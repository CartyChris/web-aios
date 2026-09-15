import type {
  Correction, Criterion, DefinitionOfDone, DodVerdict, EvalBaseline, EvalDelta,
  EvalResult, EvalSuiteResult, EvalTask, RunResult, RunTotals,
} from "./types";
import { dodValidate, evaluateDod, type JudgeFn } from "./dod";

/* ────────────────────────────────────────────────────────────────────────────
   The improvement loop, and the rule that makes it honest.

   Every task here is run TWICE: once against its own objective and once
   against its anti-case. The anti-run is not optional and not a nicety. A
   definition of done that passes everything satisfies every positive test ever
   written, so a suite built only from positives measures whether the checks
   still execute, not whether they still discriminate. `discriminates` is
   `pass && !antiPass`, and a task that passes both ways counts as NOT green.

   The second load-bearing piece is `taskFromFailure`: a production failure
   plus a signed correction becomes a runnable golden task in one call. If that
   path is an export-and-reimport chore nobody walks it, the corrections stay
   in someone's head, and the eval set stops tracking the failures the system
   actually has.

   Third is `fingerprint`. A green suite is evidence about the code that was
   running when it went green. If the tools, the prompt, the fixtures or the
   config have moved since the baseline was taken, the old green is not
   evidence about the current code, and the suite says `stale` rather than
   vouching for something it never ran against.
   ──────────────────────────────────────────────────────────────────────────── */

/** Cost has to move by both a fraction AND an absolute amount before it is
 *  reported. Either test alone is noise: a ratio fires on a task that went
 *  from $0.0001 to $0.0003, and a flat floor never fires on a cheap suite at
 *  all. */
export const COST_DELTA_RATIO = 0.2;
export const COST_DELTA_FLOOR = 0.005;

/** A person who writes down an expected figure means that figure. The
 *  tolerance exists for floating-point representation, not for being roughly
 *  right — a regression test that accepts a nearby number is how the bug comes
 *  back wearing a slightly different value. */
export const REGRESSION_NUMBER_TOLERANCE = 1e-9;

const ZERO_TOTALS: RunTotals = {
  steps: 0, llmCalls: 0, repairCalls: 0, toolCalls: 0, toolErrors: 0,
  tokensIn: 0, tokensOut: 0, costUsd: 0, ms: 0,
};

function sumTotals(list: RunTotals[]): RunTotals {
  return list.reduce<RunTotals>((a, t) => ({
    steps: a.steps + t.steps,
    llmCalls: a.llmCalls + t.llmCalls,
    repairCalls: a.repairCalls + t.repairCalls,
    toolCalls: a.toolCalls + t.toolCalls,
    toolErrors: a.toolErrors + t.toolErrors,
    tokensIn: a.tokensIn + t.tokensIn,
    tokensOut: a.tokensOut + t.tokensOut,
    costUsd: a.costUsd + t.costUsd,
    ms: a.ms + t.ms,
  }), { ...ZERO_TOTALS });
}

/* ── Fingerprinting ──────────────────────────────────────────────────────── */

function fnv1a(input: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    // imul, because the 32-bit FNV prime overflows a double's integer range
    // and `h * 0x01000193` silently loses the low bits that carry the hash.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 64 bits of FNV-1a as hex, from two passes with different offset bases.
 *  32 bits collide at around 77,000 distinct inputs, which a long-lived
 *  baseline file will reach; a collision here means a changed surface
 *  fingerprints as unchanged and a stale green passes for a fresh one. */
function digest(input: string): string {
  const a = fnv1a(input, 0x811c9dc5);
  const b = fnv1a(input, 0x9e3779b9);
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/** The separator below is a NUL, which cannot occur in a tool signature, a
 *  prompt fingerprint, a version string or a config digest. */
const FIELD_SEP = String.fromCharCode(0);

export function fingerprint(input: {
  toolSignature: string;
  promptFingerprint: string;
  fixtureVersion: string;
  configDigest: string;
}): string {
  // Separated rather than concatenated: "ab" + "c" and "a" + "bc" hash
  // identically once concatenated, so a field moving a character into its
  // neighbour would be invisible to the staleness guard.
  const joined = [
    input.toolSignature, input.promptFingerprint,
    input.fixtureVersion, input.configDigest,
  ].join(FIELD_SEP);
  return `fp-${digest(joined)}`;
}

/* ── Task validation ─────────────────────────────────────────────────────── */

const normalise = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();

/** Reject loudly, never skip.
 *
 *  A task that cannot be run must land in the suite's `rejected` list and make
 *  the suite not green. Skipping it quietly is the failure mode where a suite
 *  shrinks task by task and keeps reporting green on what is left. */
export function validateTask(t: EvalTask): { ok: true } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];

  if (!t.id.trim()) reasons.push("id is empty; a task with no id cannot be referenced by a baseline.");
  if (!t.objective.trim()) reasons.push("objective is empty.");

  if (!t.anti || !t.anti.objective.trim()) {
    reasons.push(
      "no anti-case. A definition of done that passes everything satisfies every positive test, "
      + "so a task without an objective it must REFUSE proves nothing.",
    );
  } else if (normalise(t.anti.objective) === normalise(t.objective)) {
    reasons.push(
      "the anti-case objective is the objective. Running the same question twice cannot show that "
      + "the definition of done discriminates.",
    );
  }
  if (t.anti && !t.anti.reason.trim()) {
    reasons.push("the anti-case has no written reason; nobody can tell later why it must fail.");
  }

  const dod = dodValidate(t.dod);
  if (!dod.ok) for (const r of dod.reasons) reasons.push(`definition of done: ${r}`);

  const repeats = t.repeat ?? 1;
  const needsRepeats = t.dod.criteria.some((c) => c.check.kind === "stable_across_repeats");
  if (needsRepeats && repeats < 2) {
    reasons.push(
      `a stable_across_repeats criterion with repeat: ${repeats}. One run is stable across itself, `
      + "so the criterion would pass unconditionally.",
    );
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/* ── Running one task ────────────────────────────────────────────────────── */

export interface EvalDeps {
  runOne: (objective: string, task: EvalTask, label: "main" | "anti" | "repeat") => Promise<RunResult>;
  judge: JudgeFn | null;
  now: () => number;
  /** Returns a reason when no further run may be dispatched.
   *
   *  Not in the original signature, and optional so callers that do not track
   *  spend still compile. It exists because `ask()` commits spend globally and
   *  its own budget stop THROWS: a suite that only checks the budget once,
   *  before it starts, discovers the ceiling by having a run die mid-flight
   *  and losing its trace. */
  budgetStopped?: () => string | null;
}

function refusedVerdict(dodId: string, at: number, reason: string): DodVerdict {
  return { dodId, pass: false, score: 0, outcomes: [], decidedBy: null, decidedAt: at, reason, pendingHuman: [] };
}

function errorResult(t: EvalTask, at: number, error: string): EvalResult {
  return {
    taskId: t.id,
    runId: "",
    pass: false,
    // An anti-case that never ran did not pass; the task still fails, which is
    // the honest reading of "we could not tell".
    antiPass: false,
    discriminates: false,
    verdict: refusedVerdict(t.dod.id, at, error),
    antiVerdict: refusedVerdict(t.dod.id, at, "the anti-case was not run."),
    totals: { ...ZERO_TOTALS },
    antiTotals: { ...ZERO_TOTALS },
    toolSequence: [],
    startedAt: at,
    ms: 0,
    error,
  };
}

const toolSequenceOf = (run: RunResult): string[] =>
  run.steps.map((s) => s.tool?.tool).filter((n): n is string => typeof n === "string");

/**
 * Run a task and its mandatory anti-case.
 *
 * The anti gets the same repeat count as the main objective. Giving it fewer
 * would let a `stable_across_repeats` criterion fail on the anti because it
 * had nothing to compare, and the task would then look discriminating for a
 * reason that has nothing to do with the objective.
 *
 * This never throws. A task that blows up mid-suite must still produce a
 * result, or one bad task takes the whole run's evidence with it.
 */
export async function runTask(t: EvalTask, deps: EvalDeps): Promise<EvalResult> {
  const startedAt = deps.now();

  const gate = validateTask(t);
  if (!gate.ok) return errorResult(t, startedAt, `invalid task: ${gate.reasons.join(" ")}`);

  try {
    const repeats = Math.max(1, t.repeat ?? 1);

    const mainRuns: RunResult[] = [];
    for (let i = 0; i < repeats; i += 1) {
      mainRuns.push(await deps.runOne(t.objective, t, i === 0 ? "main" : "repeat"));
    }
    const antiRuns: RunResult[] = [];
    for (let i = 0; i < repeats; i += 1) {
      antiRuns.push(await deps.runOne(t.anti.objective, t, "anti"));
    }

    const main = mainRuns[0];
    const anti = antiRuns[0];
    if (!main || !anti) return errorResult(t, startedAt, "runOne returned nothing.");

    const verdict = await evaluateDod(t.dod, main, deps.judge, mainRuns.slice(1));
    const antiVerdict = await evaluateDod(t.dod, anti, deps.judge, antiRuns.slice(1));

    const pass = verdict.pass;
    const antiPass = antiVerdict.pass;

    return {
      taskId: t.id,
      runId: main.runId,
      pass,
      antiPass,
      discriminates: pass && !antiPass,
      verdict,
      antiVerdict,
      // Summed over the repeats, not taken from the first run: the suite's
      // cost line has to be what the suite actually spent, or a task with
      // repeat: 3 under-reports itself by two thirds.
      totals: sumTotals(mainRuns.map((r) => r.totals)),
      antiTotals: sumTotals(antiRuns.map((r) => r.totals)),
      toolSequence: toolSequenceOf(main),
      startedAt,
      ms: deps.now() - startedAt,
    };
  } catch (e) {
    return errorResult(t, startedAt, e instanceof Error ? e.message : String(e));
  }
}

/* ── Running the suite ───────────────────────────────────────────────────── */

export interface SuiteOptions {
  concurrency: number;
  baseline: EvalBaseline | null;
  fingerprint: string;
}

export async function runSuite(
  tasks: EvalTask[],
  deps: EvalDeps,
  opts: SuiteOptions,
): Promise<EvalSuiteResult> {
  const startedAt = deps.now();

  const rejected: Array<{ taskId: string; reason: string }> = [];
  const runnable: EvalTask[] = [];
  for (const t of tasks) {
    const gate = validateTask(t);
    if (gate.ok) runnable.push(t);
    else rejected.push({ taskId: t.id, reason: gate.reasons.join(" ") });
  }

  // Indexed writes, so the report reads in task order however the pool
  // happened to interleave. A suite whose output order changes run to run
  // cannot be diffed by eye.
  const results: EvalResult[] = new Array<EvalResult>(runnable.length);
  const width = Math.max(1, Math.min(Math.floor(opts.concurrency) || 1, runnable.length));
  let next = 0;
  let stopped: string | null = null;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= runnable.length) return;
      const t = runnable[i];
      if (!t) return;

      if (stopped === null && deps.budgetStopped) stopped = deps.budgetStopped();
      results[i] = stopped === null
        ? await runTask(t, deps)
        : errorResult(t, deps.now(), `not dispatched: ${stopped}`);
    }
  };

  await Promise.all(Array.from({ length: width }, () => worker()));

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  const nonDiscriminating = results.filter((r) => r.pass && !r.discriminates).length;
  const stale = opts.baseline !== null && opts.baseline.fingerprint !== opts.fingerprint;

  const out: EvalSuiteResult = {
    suiteId: `suite-${digest(`${opts.fingerprint}|${startedAt}|${runnable.map((t) => t.id).join(",")}`)}`,
    startedAt,
    ms: deps.now() - startedAt,
    results,
    passed,
    failed,
    nonDiscriminating,
    rejected,
    // `results.length > 0` is not in the written formula and is added on
    // purpose: an empty suite satisfies "nothing failed" and would report
    // green while vouching for nothing at all.
    green: results.length > 0
      && failed === 0
      && nonDiscriminating === 0
      && rejected.length === 0
      && stale === false,
    // Both sides of every task. The anti-runs are real spend, and a suite that
    // reports only the main runs understates its own price by about half.
    totals: sumTotals(results.flatMap((r) => [r.totals, r.antiTotals])),
    fingerprint: opts.fingerprint,
    stale,
    baseline: opts.baseline,
    deltas: [],
  };
  out.deltas = opts.baseline ? diffAgainstBaseline(out, opts.baseline) : [];
  return out;
}

/* ── Comparing against the baseline ──────────────────────────────────────── */

export function diffAgainstBaseline(r: EvalSuiteResult, b: EvalBaseline): EvalDelta[] {
  const deltas: EvalDelta[] = [];
  const seen = new Set<string>();

  for (const res of r.results) {
    seen.add(res.taskId);
    const prev = b.perTask[res.taskId];

    if (!prev) {
      deltas.push({
        taskId: res.taskId,
        kind: res.pass ? "fixed" : "regressed",
        detail: `not in the baseline; ${res.pass ? "passing" : "failing"} on its first recorded run.`,
      });
      continue;
    }

    if (prev.pass && !res.pass) {
      deltas.push({
        taskId: res.taskId,
        kind: "regressed",
        detail: `passed in the baseline, fails now: ${res.error ?? res.verdict.reason}`,
      });
      continue;
    }
    if (!prev.pass && res.pass) {
      deltas.push({ taskId: res.taskId, kind: "fixed", detail: "failed in the baseline, passes now." });
      continue;
    }

    let moved = false;
    const dCost = res.totals.costUsd - prev.costUsd;
    const ratio = prev.costUsd > 0 ? Math.abs(dCost) / prev.costUsd : Infinity;
    if (Math.abs(dCost) > COST_DELTA_FLOOR && ratio > COST_DELTA_RATIO) {
      deltas.push({
        taskId: res.taskId,
        kind: dCost > 0 ? "cost_up" : "cost_down",
        detail: `${prev.costUsd.toFixed(4)} to ${res.totals.costUsd.toFixed(4)} USD for the same verdict.`,
      });
      moved = true;
    }
    if (res.totals.steps > prev.steps) {
      deltas.push({
        taskId: res.taskId,
        kind: "steps_up",
        detail: `${prev.steps} steps to ${res.totals.steps} for the same verdict.`,
      });
      moved = true;
    }
    if (!moved) deltas.push({ taskId: res.taskId, kind: "unchanged", detail: "same verdict, same cost, same steps." });
  }

  // A task in the baseline that this run never executed is lost coverage, and
  // lost coverage looks exactly like a clean suite if nobody reports it.
  for (const taskId of Object.keys(b.perTask).sort()) {
    if (seen.has(taskId)) continue;
    deltas.push({
      taskId,
      kind: "regressed",
      detail: "in the baseline, absent from this run. Coverage was removed, not earned.",
    });
  }

  return deltas;
}

/* ── A production failure becomes a test ─────────────────────────────────── */

const TOOL_WORD_STOPLIST = new Set([
  "tool", "tools", "the", "a", "an", "it", "that", "this",
  "value", "number", "answer", "step", "run", "result",
]);

/** Pull a tool name out of what the person wrote.
 *
 *  Three patterns in descending confidence: an explicit "should have called
 *  X", a backticked identifier, then any snake_case token. The stoplist is
 *  there because "should have used the tool" otherwise yields a criterion
 *  asserting a tool literally named `tool` was called, which can never pass. */
function inferToolName(text: string): string | null {
  const said = /\b(?:call|called|calling|use|used|using|invoke|invoked)\s+(?:the\s+)?`?([a-z][a-z0-9_]{1,39})`?\b/.exec(text);
  const ticked = /`([a-z][a-z0-9_]{1,39})`/.exec(text);
  const snake = /\b([a-z][a-z0-9]*_[a-z0-9_]+)\b/.exec(text);
  for (const m of [said, ticked, snake]) {
    const name = m?.[1];
    if (name && !TOOL_WORD_STOPLIST.has(name)) return name;
  }
  return null;
}

/** Mutate an objective so its expected result no longer holds.
 *
 *  The ladder deliberately stops rather than inventing a mutation it cannot
 *  justify. A generic fallback like appending "for a segment that does not
 *  exist" would make this never throw, and a `taskFromFailure` that always
 *  succeeds produces regression tests whose anti-case nobody ever read. */
function mutateObjective(objective: string): { objective: string; reason: string } | null {
  const period = /\b(?:19|20)\d{2}(?:Q[1-4]|-(?:0[1-9]|1[0-2]))?\b/.exec(objective);
  if (period) {
    const found = period[0];
    const year = Number(found.slice(0, 4));
    const shifted = `${year - 7}${found.slice(4)}`;
    return {
      objective: objective.replace(found, shifted),
      reason: `period ${found} shifted to ${shifted}, which is outside the data, so the expected result cannot hold.`,
    };
  }

  const num = /-?\d+(?:\.\d+)?/.exec(objective);
  if (num) {
    const found = num[0];
    // 7n + 13 is never n for any real n, so the mutated objective is always a
    // different question. A "randomised" mutation can land back on itself.
    const changed = String(Number(found) * 7 + 13);
    return {
      objective: objective.replace(found, changed),
      reason: `the quantity ${found} changed to ${changed}, so the expected result no longer applies.`,
    };
  }

  const quoted = /"([^"]{1,60})"|'([^']{1,60})'/.exec(objective);
  const quotedTerm = quoted?.[1] ?? quoted?.[2];
  if (quoted && quotedTerm) {
    return {
      objective: objective.replace(quotedTerm, "zzz-absent-term"),
      reason: `the term "${quotedTerm}" replaced with one absent from the corpus, so nothing can match it.`,
    };
  }

  const ident = /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/.exec(objective);
  if (ident) {
    return {
      objective: objective.replace(ident[0], "zzz_absent_term"),
      reason: `the identifier ${ident[0]} replaced with one that does not exist, so the lookup must miss.`,
    };
  }

  return null;
}

/**
 * Turn a run someone judged wrong into a golden task, in one call.
 *
 * Throws rather than degrade, in three places. An unsigned correction is an
 * opinion, not a decision. A correction with no stated expectation gives the
 * task nothing to assert. And an objective with no date, number, quoted term
 * or identifier to mutate has no anti-case, which would make a regression test
 * that cannot fail — the exact thing this module exists to refuse.
 */
export function taskFromFailure(run: RunResult, c: Correction, dodTemplate: DefinitionOfDone): EvalTask {
  if (!c.correctedBy.trim()) {
    throw new Error("Correction.correctedBy is empty. An unsigned correction is an opinion, not a decision.");
  }
  if (!c.expected.trim()) {
    throw new Error("Correction.expected is empty. There is nothing for the regression test to assert.");
  }
  if (!run.objective.trim()) {
    throw new Error(`Run ${run.runId} has no objective to replay.`);
  }

  const id = `g-reg-${digest(run.runId).slice(0, 6)}`;

  // A figure someone wrote down is checked as a figure; anything else is
  // checked as text. Commas stripped first: "4,182,000" otherwise parses as 4.
  const numeric = /-?\d+(?:\.\d+)?/.exec(c.expected.replace(/,/g, ""));
  const expectedCriterion: Criterion = numeric
    ? {
      id: "c-expected",
      label: "The corrected figure",
      expectation: `${c.correctedBy} recorded the expected result as: ${c.expected}`,
      check: { kind: "number_within", expected: Number(numeric[0]), tolerance: REGRESSION_NUMBER_TOLERANCE },
      by: "fixed",
      weight: 3,
      required: true,
    }
    : {
      id: "c-expected",
      label: "The corrected answer",
      expectation: `${c.correctedBy} recorded the expected result as: ${c.expected}`,
      check: { kind: "contains", value: c.expected.trim() },
      by: "fixed",
      weight: 3,
      required: true,
    };

  const step = run.steps.find((s) => s.index === c.wrongStepIndex) ?? run.steps[c.wrongStepIndex];
  const stepFlag = run.flags.find((f) => f.stepIndex === c.wrongStepIndex);
  const inferred = inferToolName(`${c.whatWasWrong} ${c.expected}`);

  let stepCriterion: Criterion;
  if (step && !step.tool && inferred) {
    stepCriterion = {
      id: "c-wrong-step",
      label: `Step ${c.wrongStepIndex} calls ${inferred}`,
      expectation: `The step that went wrong answered without calling ${inferred}. It has to call it.`,
      check: { kind: "tool_called", tool: inferred },
      by: "fixed",
      weight: 2,
      required: true,
    };
  } else if (stepFlag) {
    stepCriterion = {
      id: "c-wrong-step",
      label: `No ${stepFlag.code} flag`,
      expectation: `Step ${c.wrongStepIndex} raised ${stepFlag.code}: ${stepFlag.detail}`,
      check: { kind: "no_flag", code: stepFlag.code },
      by: "fixed",
      weight: 2,
      required: true,
    };
  } else {
    // Strictly fewer steps than the failing run took. Equal would let the
    // identical wander through.
    const cap = Math.max(1, run.totals.steps - 1);
    stepCriterion = {
      id: "c-wrong-step",
      label: `At most ${cap} steps`,
      expectation: `The failing run wandered for ${run.totals.steps} steps; this one has to finish in fewer.`,
      check: { kind: "max_steps", value: cap },
      by: "fixed",
      weight: 2,
      required: true,
    };
  }

  const anti = mutateObjective(run.objective);
  if (!anti) {
    throw new Error(
      `Cannot build an anti-case for "${run.objective}": it holds no date, number, quoted term or `
      + "identifier to mutate. Write anti.objective by hand — a regression test that cannot fail is "
      + "not a regression test.",
    );
  }

  // Human criteria from the template are dropped. They belong on the
  // production definition of done, where a person is in the loop; a replay
  // that parks itself on pendingHuman can never go green in a suite, so
  // carrying one over would quietly disable the new test.
  const inherited = dodTemplate.criteria.filter((cr) => cr.by !== "human");

  const dod: DefinitionOfDone = {
    id: `dod-${id}`,
    label: `Regression from ${run.runId}: ${c.whatWasWrong}`.slice(0, 120),
    criteria: [...inherited, expectedCriterion, stepCriterion],
    passThreshold: dodTemplate.passThreshold,
    owner: dodTemplate.owner && dodTemplate.owner !== "unassigned" ? dodTemplate.owner : c.correctedBy,
  };

  const task: EvalTask = {
    id,
    title: `Regression: ${c.whatWasWrong}`.slice(0, 120),
    category: "regression",
    objective: run.objective,
    // The run's fixture overlay is not carried on RunResult, so the replay
    // reads the shipped fixtures. The run's fingerprint is tagged instead, so
    // a replay against moved fixtures is at least visible rather than silent.
    fixtures: {},
    dod,
    anti,
    origin: "production_failure",
    sourceRunId: run.runId,
    createdAt: c.at,
    tags: ["regression", `run:${run.runId}`, `fingerprint:${run.fingerprint}`, `step:${c.wrongStepIndex}`],
    // The run's own start, so the replay sees the dates the run saw.
    clockAt: run.startedAt,
  };

  const gate = validateTask(task);
  if (!gate.ok) {
    throw new Error(`taskFromFailure built a task the suite would reject: ${gate.reasons.join(" ")}`);
  }
  return task;
}

/* ── The report ──────────────────────────────────────────────────────────── */

const usd = (n: number): string => `$${n.toFixed(4)}`;

export function suiteToMarkdown(r: EvalSuiteResult): string {
  const lines: string[] = [];
  lines.push(`# Golden set — ${r.green ? "GREEN" : "NOT GREEN"}`);
  lines.push("");
  lines.push(`Suite \`${r.suiteId}\` · fingerprint \`${r.fingerprint}\`${r.stale ? " · STALE" : ""}`);
  lines.push("");
  lines.push(
    `${r.passed} passed · ${r.failed} failed · ${r.nonDiscriminating} non-discriminating `
    + `· ${r.rejected.length} rejected`,
  );
  lines.push(`${usd(r.totals.costUsd)} over ${r.totals.steps} steps and ${r.totals.llmCalls} model calls.`);
  lines.push("");

  if (r.stale) {
    lines.push(
      "> The tools, prompt, fixtures or config moved since the baseline was taken. "
      + "An old green is not evidence about this code.",
    );
    lines.push("");
  }

  lines.push("| task | pass | anti fails | discriminates | steps | cost |");
  lines.push("|---|---|---|---|---|---|");
  for (const res of r.results) {
    lines.push(
      `| \`${res.taskId}\` | ${res.pass ? "yes" : "no"} | ${res.antiPass ? "NO" : "yes"} `
      + `| ${res.discriminates ? "yes" : "no"} | ${res.totals.steps} | ${usd(res.totals.costUsd)} |`,
    );
  }
  lines.push("");

  const undiscriminating = r.results.filter((res) => res.pass && !res.discriminates);
  if (undiscriminating.length > 0) {
    lines.push("## Passed, but proves nothing");
    lines.push("");
    lines.push(
      "These tasks passed their own objective AND their anti-case. A check that says yes to both "
      + "is decoration.",
    );
    lines.push("");
    for (const res of undiscriminating) {
      lines.push(`- \`${res.taskId}\` — anti-case verdict: ${res.antiVerdict.reason}`);
    }
    lines.push("");
  }

  const failures = r.results.filter((res) => !res.pass);
  if (failures.length > 0) {
    lines.push("## Failed");
    lines.push("");
    for (const res of failures) lines.push(`- \`${res.taskId}\` — ${res.error ?? res.verdict.reason}`);
    lines.push("");
  }

  if (r.rejected.length > 0) {
    lines.push("## Rejected at registration");
    lines.push("");
    for (const rej of r.rejected) lines.push(`- \`${rej.taskId}\` — ${rej.reason}`);
    lines.push("");
  }

  const moved = r.deltas.filter((d) => d.kind !== "unchanged");
  if (moved.length > 0) {
    lines.push("## Against the baseline");
    lines.push("");
    for (const d of moved) lines.push(`- \`${d.taskId}\` — **${d.kind}** — ${d.detail}`);
    lines.push("");
  }

  return lines.join("\n");
}
