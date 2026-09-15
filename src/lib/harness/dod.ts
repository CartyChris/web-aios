import type {
  Criterion, CriterionOutcome, DefinitionOfDone, DodVerdict, RunResult,
  ToolResultStatus,
} from "./types";

/* ────────────────────────────────────────────────────────────────────────────
   Definition of done — the half of the control layer that decides whether a
   run is finished.

   Two rules drive every line here and neither is negotiable.

   (1) A swarm may not start without acceptance criteria, so `dodValidate`
   refuses the empty AND the vacuous. A definition of done that cannot fail is
   worse than no definition at all: it manufactures exactly the confidence a
   real one would have had to earn, and every positive test it is given passes.
   Each rejection below names the input it exists to catch.

   (2) The agent advises, a named person decides. A `by: "human"` criterion
   stays `met: null`, lands in `pendingHuman`, and blocks `pass` until someone
   signs it under their own name. `pass` is never reachable with a human
   criterion outstanding, and an unnamed signer is not a signer.

   The module is pure. No clock is injected into `evaluateDod`, so a verdict is
   stamped with the run's own `endedAt` rather than reading the wall clock —
   which also means a replayed run produces a byte-identical verdict.
   ──────────────────────────────────────────────────────────────────────────── */

/** An expectation shorter than this is a label, not something a person could
 *  go and observe. "works" is the input this catches. */
const MIN_EXPECTATION_CHARS = 10;

/** Same reasoning for a judge's or a human's question. */
const MIN_QUESTION_CHARS = 8;

/** Patterns that match every possible answer. A `regex` criterion built from
 *  one of these can never say no, which is the whole failure mode this file
 *  exists to prevent. The list is literal because "does this regex match
 *  everything" is undecidable in general; these are the ones people write. */
const MATCH_EVERYTHING = new Set(["", ".*", "^.*$", ".*?", "[\\s\\S]*", "^[\\s\\S]*$"]);

/** How much of an observation is quoted into a reason string. */
const OBSERVED_CHARS = 160;

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function quote(text: string, max = OBSERVED_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? JSON.stringify(flat) : JSON.stringify(flat.slice(0, max) + "...");
}

function render(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (v === undefined) return "undefined";
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** Why this criterion can never do its job, or null when it can.
 *
 *  Split out of `dodValidate` because `evaluateDod` is reachable without
 *  validation (a DoD loaded from an older store, a task built by hand) and a
 *  broken check must not quietly resolve to "met". */
function vacuityReason(c: Criterion): string | null {
  if (!Number.isFinite(c.weight) || c.weight < 0) {
    return `weight ${String(c.weight)} is not a finite number >= 0, so it cannot enter the score`;
  }
  if (c.by === "fixed" && (c.check.kind === "judge" || c.check.kind === "human")) {
    return `by: "fixed" but check kind "${c.check.kind}" needs a model or a person, so no code can ever evaluate it`;
  }
  const k = c.check;
  switch (k.kind) {
    case "contains":
    case "not_contains":
      return k.value.length === 0
        ? `${k.kind} with an empty value matches every answer`
        : null;
    case "regex": {
      if (MATCH_EVERYTHING.has(k.pattern.trim())) {
        return `pattern ${JSON.stringify(k.pattern)} matches every answer`;
      }
      try {
        new RegExp(k.pattern, k.flags);
      } catch (e) {
        return `pattern does not compile: ${message(e)}`;
      }
      return null;
    }
    case "number_within":
      if (!Number.isFinite(k.expected)) return "expected must be a finite number";
      if (!Number.isFinite(k.tolerance) || k.tolerance < 0) {
        return "tolerance must be a finite number >= 0; an infinite tolerance accepts any number in the answer";
      }
      return null;
    case "tool_called":
      if (k.tool.trim() === "") return "tool_called names no tool";
      // times <= 0 is satisfied by a run that never called the tool at all.
      if (k.times !== undefined && (!Number.isInteger(k.times) || k.times < 1)) {
        return `times ${String(k.times)} must be an integer >= 1; a run that never called ${k.tool} satisfies times <= 0`;
      }
      return null;
    case "tool_not_called":
    case "tool_value_equals":
      return k.tool.trim() === "" ? `${k.kind} names no tool` : null;
    case "artifact_exists":
      return k.path.trim() === "" ? "artifact_exists names no path" : null;
    case "max_steps":
      return !Number.isInteger(k.value) || k.value < 1
        ? "max_steps must be an integer >= 1"
        : null;
    case "max_cost_usd":
      return !Number.isFinite(k.value) || k.value < 0
        ? "max_cost_usd must be a finite number >= 0"
        : null;
    case "judge":
    case "human":
      return k.question.trim().length < MIN_QUESTION_CHARS
        ? `question ${quote(k.question, 40)} is too short to answer`
        : null;
    case "no_flag":
    case "stable_across_repeats":
      return null;
    default:
      return null;
  }
}

/** Refuse a definition of done that cannot do its job.
 *
 *  The five structural rejections — no criteria, no required criterion, total
 *  weight 0, an expectation under 10 characters, an empty owner — are the
 *  whole defence against a run that cannot be judged. The per-criterion
 *  vacuity reasons extend it to the checks themselves, because "at least one
 *  required criterion" is no defence at all when that criterion is
 *  `contains: ""`. */
export function dodValidate(dod: DefinitionOfDone): { ok: true } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];

  if (dod.criteria.length === 0) {
    reasons.push("no criteria: a run with nothing to check cannot be judged, so it cannot be started");
  }
  if (dod.criteria.length > 0 && !dod.criteria.some((c) => c.required)) {
    reasons.push("no required criterion: every criterion is advisory, so nothing on this list can fail the run");
  }

  const totalWeight = dod.criteria.reduce(
    (sum, c) => sum + (Number.isFinite(c.weight) && c.weight > 0 ? c.weight : 0),
    0,
  );
  if (dod.criteria.length > 0 && totalWeight <= 0) {
    reasons.push("total weight 0: the score has no denominator, so passThreshold can never bite");
  }

  if (!Number.isFinite(dod.passThreshold) || dod.passThreshold < 0 || dod.passThreshold > 1) {
    reasons.push(`passThreshold ${String(dod.passThreshold)} is outside 0..1`);
  }

  const seen = new Set<string>();
  for (const c of dod.criteria) {
    if (seen.has(c.id)) {
      // Outcomes are keyed by criterion id; a duplicate means one of the two
      // is silently never reported.
      reasons.push(`criterion "${c.id}": duplicate id — its outcome would overwrite the other`);
    }
    seen.add(c.id);

    if (c.expectation.trim().length < MIN_EXPECTATION_CHARS) {
      reasons.push(
        `criterion "${c.id}": expectation ${quote(c.expectation, 40)} is under ${MIN_EXPECTATION_CHARS} characters — a criterion with no expectation is a wish`,
      );
    }
    const vacuous = vacuityReason(c);
    if (vacuous) reasons.push(`criterion "${c.id}": ${vacuous}`);
  }

  if (dod.owner.trim() === "") {
    reasons.push("no owner: a definition of done nobody owns is nobody's job");
  }

  return reasons.length > 0 ? { ok: false, reasons } : { ok: true };
}

interface ToolCallView {
  tool: string;
  status: ToolResultStatus;
  value: unknown;
  stepIndex: number;
}

function toolCalls(run: RunResult): ToolCallView[] {
  const out: ToolCallView[] = [];
  for (const step of run.steps) {
    const call = step.tool;
    if (!call) continue;
    out.push({ tool: call.tool, status: call.result.status, value: call.result.value, stepIndex: step.index });
  }
  return out;
}

const NUMBER_RE = /-?\d[\d,]*(?:\.\d+)?/g;

function extractNumbers(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(NUMBER_RE)) {
    const n = Number(m[0].replace(/,/g, ""));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

function getPath(value: unknown, path: string): unknown {
  if (path.trim() === "") return value;
  let cur: unknown = value;
  // Array indices need no special case: "0" is a valid key on an array.
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function sameValue(actual: unknown, expected: string | number | boolean): boolean {
  if (Object.is(actual, expected)) return true;
  if (actual === null || actual === undefined) return false;
  const t = typeof actual;
  if (t !== "string" && t !== "number" && t !== "boolean") return false;
  // A tool value that has round-tripped through JSON in the VFS comes back as
  // text. Failing 4182000 against "4182000" would teach people to stop using
  // the check rather than fix the data; it still says no to a different value.
  return String(actual) === String(expected);
}

function repeatKey(run: RunResult, field: "answer" | "tool_sequence"): string {
  return field === "answer"
    ? run.answer.trim()
    : toolCalls(run).map((c) => c.tool).join(" > ");
}

function checkFixed(c: Criterion, run: RunResult, repeats: RunResult[]): { met: boolean; observed: string } {
  const vacuous = vacuityReason(c);
  if (vacuous) {
    // A broken check resolves to "not met", never to "met": a run does not get
    // to pass because its criterion was malformed.
    return { met: false, observed: `criterion is unusable and was not evaluated: ${vacuous}` };
  }

  const k = c.check;
  switch (k.kind) {
    case "contains":
    case "not_contains": {
      const hay = k.caseSensitive === true ? run.answer : run.answer.toLowerCase();
      const needle = k.caseSensitive === true ? k.value : k.value.toLowerCase();
      const at = hay.indexOf(needle);
      const found = at >= 0;
      const where = found
        ? `found ${JSON.stringify(k.value)} at index ${at}: ${quote(run.answer.slice(Math.max(0, at - 40), at + needle.length + 40))}`
        : `answer (${run.answer.length} chars) does not contain ${JSON.stringify(k.value)}: ${quote(run.answer)}`;
      return { met: k.kind === "contains" ? found : !found, observed: where };
    }
    case "regex": {
      const re = new RegExp(k.pattern, k.flags);
      const m = re.exec(run.answer);
      return m
        ? { met: true, observed: `matched /${k.pattern}/${k.flags ?? ""} at index ${m.index}: ${quote(m[0])}` }
        : { met: false, observed: `no match for /${k.pattern}/${k.flags ?? ""} in ${quote(run.answer)}` };
    }
    case "number_within": {
      const nums = extractNumbers(run.answer);
      if (nums.length === 0) {
        return { met: false, observed: `answer contains no number; expected ${k.expected} +/- ${k.tolerance}` };
      }
      let best = nums[0] as number;
      for (const n of nums) if (Math.abs(n - k.expected) < Math.abs(best - k.expected)) best = n;
      const met = Math.abs(best - k.expected) <= k.tolerance;
      return {
        met,
        observed: `nearest number in the answer is ${best}; expected ${k.expected} +/- ${k.tolerance} (delta ${Math.abs(best - k.expected)})`,
      };
    }
    case "tool_called": {
      const calls = toolCalls(run).filter((t) => t.tool === k.tool);
      const need = k.times ?? 1;
      // ">=", not "===": a run that retried and succeeded on the third attempt
      // still called the tool twice, and failing it for doing extra work is
      // not what this criterion is for.
      return {
        met: calls.length >= need,
        observed: `${k.tool} called ${calls.length}x (need >= ${need})${calls.length > 0 ? ` at steps [${calls.map((t) => t.stepIndex).join(", ")}]` : ""}`,
      };
    }
    case "tool_not_called": {
      const calls = toolCalls(run).filter((t) => t.tool === k.tool);
      return {
        met: calls.length === 0,
        observed: calls.length === 0
          ? `${k.tool} was never called`
          : `${k.tool} was called ${calls.length}x at steps [${calls.map((t) => t.stepIndex).join(", ")}]`,
      };
    }
    case "tool_value_equals": {
      const calls = toolCalls(run).filter((t) => t.tool === k.tool && t.status === "ok");
      if (calls.length === 0) {
        return { met: false, observed: `${k.tool} produced no ok result to read "${k.path}" from` };
      }
      const seen: string[] = [];
      let met = false;
      for (const call of calls) {
        const got = getPath(call.value, k.path);
        seen.push(render(got));
        if (sameValue(got, k.equals)) met = true;
      }
      return {
        met,
        observed: `${k.tool}.${k.path} was ${seen.join(", ")}; expected ${render(k.equals)}`,
      };
    }
    case "artifact_exists": {
      const writes = toolCalls(run).filter((t) => t.tool === "write_artifact" && t.status === "ok");
      const paths = writes.map((w) => String(getPath(w.value, "path") ?? ""));
      const suffix = k.path.startsWith("/") ? k.path : `/${k.path}`;
      // write_artifact forces the run's own directory onto the path, so a DoD
      // author who wrote only the file name must still match.
      const met = paths.some((p) => p === k.path || p.endsWith(suffix));
      return {
        met,
        observed: paths.length === 0
          ? `no artifact was written; expected ${k.path}`
          : `artifacts written: ${paths.join(", ")}; expected ${k.path}`,
      };
    }
    case "max_steps": {
      // The larger of the two counters. This criterion exists to catch a run
      // that wandered, and an undercount would pass exactly the run it is
      // there to fail.
      const used = Math.max(run.totals.steps, run.steps.length);
      return { met: used <= k.value, observed: `run used ${used} steps (limit ${k.value})` };
    }
    case "max_cost_usd":
      return {
        met: run.totals.costUsd <= k.value,
        observed: `run cost $${run.totals.costUsd.toFixed(4)} (limit $${k.value.toFixed(4)})`,
      };
    case "no_flag": {
      const hits = run.flags.filter((f) => f.code === k.code);
      return {
        met: hits.length === 0,
        observed: hits.length === 0
          ? `no "${k.code}" flag was raised`
          : `${hits.length} "${k.code}" flag(s): ${hits.map((f) => `step ${f.stepIndex}: ${f.detail}`).join("; ")}`,
      };
    }
    case "stable_across_repeats": {
      if (repeats.length === 0) {
        // Not "met by default": stability that was never observed is not
        // stability, and this is the check most likely to be silently green.
        return {
          met: false,
          observed: `no repeat runs were supplied, so ${k.field} stability was never observed`,
        };
      }
      const base = repeatKey(run, k.field);
      const differing = repeats.filter((r) => repeatKey(r, k.field) !== base);
      return {
        met: differing.length === 0,
        observed: differing.length === 0
          ? `${k.field} identical across ${repeats.length + 1} runs: ${quote(base, 80)}`
          : `${k.field} differed in ${differing.length} of ${repeats.length} repeats: ${quote(base, 60)} vs ${quote(repeatKey(differing[0] as RunResult, k.field), 60)}`,
      };
    }
    case "judge":
    case "human":
      return { met: false, observed: `check kind "${k.kind}" is not evaluable by code` };
    default:
      return { met: false, observed: "unknown check kind" };
  }
}

/** Every `by: "fixed"` criterion, evaluated against the run. No model call,
 *  no clock, no I/O — so the same run always produces the same outcomes. */
export function evaluateFixedCriteria(
  dod: DefinitionOfDone,
  run: RunResult,
  repeats: RunResult[] = [],
): CriterionOutcome[] {
  const out: CriterionOutcome[] = [];
  for (const c of dod.criteria) {
    if (c.by !== "fixed") continue;
    const r = checkFixed(c, run, repeats);
    // ms is 0 because no clock is injected here; a fabricated duration on a
    // synchronous string comparison would be noise in the audit record.
    out.push({ criterionId: c.id, met: r.met, observed: r.observed, by: "fixed", ms: 0 });
  }
  return out;
}

export type JudgeFn = (
  question: string,
  objective: string,
  answer: string,
) => Promise<{ met: boolean; observed: string }>;

function outcomeMap(outcomes: CriterionOutcome[]): Map<string, CriterionOutcome> {
  return new Map(outcomes.map((o) => [o.criterionId, o]));
}

/** Assemble the verdict from outcomes. Score, pass and reason are all computed
 *  here by code — a model never writes any of the three, because the verdict
 *  is the audit record and an audit record authored by the thing under audit
 *  is not one. */
function assemble(
  dod: DefinitionOfDone,
  outcomes: CriterionOutcome[],
  at: number,
  decidedBy: string | null,
): DodVerdict {
  const byId = outcomeMap(outcomes);
  let totalWeight = 0;
  let earnedWeight = 0;
  for (const c of dod.criteria) {
    const w = Number.isFinite(c.weight) && c.weight > 0 ? c.weight : 0;
    totalWeight += w;
    if (byId.get(c.id)?.met === true) earnedWeight += w;
  }
  // dodValidate refuses a zero-weight DoD, but evaluateDod is reachable
  // without it; 0/0 must not become NaN, which compares false against every
  // threshold in a way nobody can debug.
  const score = totalWeight > 0 ? earnedWeight / totalWeight : 0;

  const pendingHuman = dod.criteria
    .filter((c) => c.by === "human" && byId.get(c.id)?.met !== true && byId.get(c.id)?.met !== false)
    .map((c) => c.id);

  const requiredMet = dod.criteria
    .filter((c) => c.required)
    .every((c) => byId.get(c.id)?.met === true);

  // The criteria.length guard is not decoration: with no criteria at all,
  // every([]) is true and 0 >= 0 is true, so a vacuous DoD would report pass.
  const pass =
    dod.criteria.length > 0 &&
    requiredMet &&
    score >= dod.passThreshold &&
    pendingHuman.length === 0;

  return {
    dodId: dod.id,
    pass,
    score,
    outcomes,
    decidedBy,
    decidedAt: at,
    reason: verdictReason(dod, outcomes),
    pendingHuman,
  };
}

/** Evaluate every criterion: fixed first (free), then the judge, then the
 *  humans who have not signed yet. */
export async function evaluateDod(
  dod: DefinitionOfDone,
  run: RunResult,
  judge: JudgeFn | null,
  repeats: RunResult[] = [],
): Promise<DodVerdict> {
  const byId = outcomeMap(evaluateFixedCriteria(dod, run, repeats));

  // A judge call on a run that has already failed a required fixed criterion
  // is pure spend: the verdict cannot change.
  const requiredFixedFailed = dod.criteria.some((c) => c.required && byId.get(c.id)?.met === false);

  for (const c of dod.criteria) {
    if (c.by !== "model") continue;
    if (requiredFixedFailed) {
      byId.set(c.id, {
        criterionId: c.id,
        met: null,
        observed: "not evaluated: a required fixed criterion already failed, so the judge was not called",
        by: "model",
        ms: 0,
      });
      continue;
    }
    if (!judge) {
      byId.set(c.id, {
        criterionId: c.id,
        met: null,
        observed: "not evaluated: no judge was configured for this run",
        by: "model",
        ms: 0,
      });
      continue;
    }
    const question = c.check.kind === "judge" ? c.check.question : c.expectation;
    try {
      // The judge sees the objective and the answer only — never the plan, the
      // thoughts or the transcript. A verifier shown the argument for
      // something agrees with it.
      const r = await judge(question, run.objective, run.answer);
      byId.set(c.id, { criterionId: c.id, met: r.met, observed: r.observed, by: "model", ms: 0 });
    } catch (e) {
      // An errored judge is "not met", not "pending": a criterion nobody could
      // observe has not been satisfied, and parking it as pending would invite
      // a human to sign off on evidence that does not exist.
      byId.set(c.id, {
        criterionId: c.id,
        met: false,
        observed: `judge call failed: ${message(e)}`,
        by: "model",
        ms: 0,
      });
    }
  }

  for (const c of dod.criteria) {
    if (c.by !== "human") continue;
    byId.set(c.id, {
      criterionId: c.id,
      met: null,
      observed: `awaiting sign-off from ${dod.owner.trim() === "" ? "an unnamed owner" : dod.owner}`,
      by: "human",
      ms: 0,
    });
  }

  const outcomes = dod.criteria.map(
    (c) => byId.get(c.id) ?? { criterionId: c.id, met: null, observed: "not evaluated", by: c.by, ms: 0 },
  );
  // The verdict carries the run's own end time; this module has no clock.
  return assemble(dod, outcomes, run.endedAt, null);
}

export interface HumanDecisionOptions {
  /** Supply it and the verdict is recomputed exactly — weights, required
   *  flags and threshold included. Without it the fallback below applies. */
  dod?: DefinitionOfDone;
  /** When the person signed. Callers that have a clock should pass it; this
   *  module has none. */
  at?: number;
}

/** Record a named person's decision on one `by: "human"` criterion.
 *
 *  Refused, leaving the verdict untouched, when: the criterion is not in this
 *  verdict, it is not a human criterion (a signature must not overwrite a
 *  fixed check — that erases the only part of the record that was evidence),
 *  or the signer has no name. "A named person decides" is not satisfied by
 *  an empty string. */
export function applyHumanDecision(
  v: DodVerdict,
  criterionId: string,
  met: boolean,
  observed: string,
  person: string,
  opts: HumanDecisionOptions = {},
): DodVerdict {
  const target = v.outcomes.find((o) => o.criterionId === criterionId);
  if (!target || target.by !== "human" || person.trim() === "") return v;

  const outcomes = v.outcomes.map((o) =>
    o.criterionId === criterionId
      ? { ...o, met, observed: `${person.trim()}: ${observed}` }
      : o,
  );
  const at = opts.at ?? v.decidedAt;

  if (opts.dod) return { ...assemble(opts.dod, outcomes, at, person.trim()) };

  // Without the DoD we do not know which criteria were required or what the
  // threshold was, so the fallback demands that every criterion be met. It can
  // only be stricter than the real rule, never looser — a false pass here puts
  // a person's name on a verdict they did not give.
  const pendingHuman = outcomes.filter((o) => o.by === "human" && o.met === null).map((o) => o.criterionId);
  const pass = outcomes.length > 0 && pendingHuman.length === 0 && outcomes.every((o) => o.met === true);
  const failed = outcomes.filter((o) => o.met === false).length;
  const reason =
    `${outcomes.filter((o) => o.met === true).length}/${outcomes.length} criteria met after ${person.trim()} signed "${criterionId}"` +
    `${failed > 0 ? `; ${failed} not met` : ""}` +
    `${pendingHuman.length > 0 ? `; awaiting ${pendingHuman.join(", ")}` : ""}` +
    "; score reflects the automated criteria only (no definition of done supplied to recompute it).";

  return { ...v, outcomes, pass, decidedBy: person.trim(), decidedAt: at, reason, pendingHuman };
}

/** The audit sentence. Assembled by concatenation from the outcomes, never
 *  written by a model: the reason is the record of what was observed, and a
 *  generated one is a summary of a record rather than the record. */
export function verdictReason(dod: DefinitionOfDone, outcomes: CriterionOutcome[]): string {
  const byId = outcomeMap(outcomes);
  let totalWeight = 0;
  let earnedWeight = 0;
  let metCount = 0;
  for (const c of dod.criteria) {
    const w = Number.isFinite(c.weight) && c.weight > 0 ? c.weight : 0;
    totalWeight += w;
    if (byId.get(c.id)?.met === true) {
      earnedWeight += w;
      metCount += 1;
    }
  }
  const score = totalWeight > 0 ? earnedWeight / totalWeight : 0;

  const parts: string[] = [
    `${metCount}/${dod.criteria.length} criteria met (score ${score.toFixed(2)}, threshold ${(Number.isFinite(dod.passThreshold) ? dod.passThreshold : 0).toFixed(2)}).`,
  ];

  for (const c of dod.criteria) {
    const o = byId.get(c.id);
    if (!o || o.met !== false) continue;
    parts.push(`FAILED${c.required ? " (required)" : ""} "${c.label}": ${quote(o.observed)}.`);
  }
  for (const c of dod.criteria) {
    const o = byId.get(c.id);
    if (!o || o.met !== null) continue;
    parts.push(
      c.by === "human"
        ? `PENDING "${c.label}" — awaiting ${dod.owner.trim() === "" ? "an unnamed owner" : dod.owner}.`
        : `NOT OBSERVED "${c.label}": ${quote(o.observed)}.`,
    );
  }
  if (parts.length === 1) parts.push("Every criterion met.");

  return parts.join(" ");
}
