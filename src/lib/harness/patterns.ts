/* ────────────────────────────────────────────────────────────────────────────
   Experience observability — turning a pile of runs into a short list of
   things actually worth fixing.

   A trace answers "what happened in run 41". It cannot answer "what keeps
   going wrong", and that second question is the one that changes the harness.
   So this aggregates the run ledger into evidence: patterns that recurred,
   with the runs that prove each one.

   Two rules, both from how this goes wrong in practice:

   1. ONLY RECURRENT PATTERNS. A single failed run is an anecdote. Proposing a
      harness change from one data point is how you end up with a prompt full
      of special cases for problems that never came back. Nothing below the
      threshold is reported at all, rather than reported weakly.

   2. EVERY PATTERN CARRIES ITS RECEIPTS. A pattern names the run ids it was
      derived from, so the claim can be checked against the traces rather than
      believed. A summary you cannot audit is just a rumour with a number
      attached.

   PURE. `now` and the run list arrive as parameters.
   ──────────────────────────────────────────────────────────────────────────── */

export interface RunLike {
  runId: string;
  objective: string;
  status: string;
  pass: boolean | null;
  steps: number;
  costUsd: number;
  ms: number;
  flags: string[];
  startedAt: number;
}

export type PatternKind = "flag" | "status" | "verdict" | "cost" | "stall";

export interface Pattern {
  id: string;
  kind: PatternKind;
  /** One line, written for someone deciding what to fix next. */
  label: string;
  /** Why it is worth attention, in plain terms. */
  detail: string;
  /** Run ids this was derived from. The receipts. */
  runIds: string[];
  count: number;
  /** Fraction of the runs considered, 0..1. */
  share: number;
  /** Ranked for display: lower sorts first. */
  severity: number;
}

export interface MineOptions {
  /** A pattern must appear at least this many times to be reported at all. */
  minRuns?: number;
  /** Cap on how many patterns come back. */
  limit?: number;
}

export const MINE_DEFAULTS = { minRuns: 2, limit: 12 } as const;

/** Flags that mean the harness itself is the problem, not the task. These are
 *  the ones a change to the loop, the prompt or a tool can actually fix. */
const ACTIONABLE_FLAGS: Record<string, { label: string; detail: string; severity: number }> = {
  loop_detected: { label: "The agent went in circles", detail: "Raise loop sensitivity, or give it a tool that makes progress visible.", severity: 0 },
  cap_exhausted: { label: "Ran out of steps before finishing", detail: "Either maxSteps is too low for this objective, or a step is being wasted every turn.", severity: 1 },
  tool_error: { label: "A tool kept failing", detail: "Check the tool's arguments schema — a model that cannot call it right will not learn to.", severity: 1 },
  invalid_action: { label: "The model named tools that do not exist", detail: "The tool list in the system prompt is probably unclear or too long.", severity: 2 },
  parse_repair: { label: "Replies needed a second call to parse", detail: "Every repair is real money. Tighten the format instructions or the stop sequence.", severity: 2 },
  budget_stopped: { label: "Stopped on cost", detail: "The budget is binding before the work is done.", severity: 1 },
  empty_step: { label: "Steps that did nothing", detail: "The model produced neither a usable thought nor an action.", severity: 3 },
  approval_required: { label: "Blocked waiting for approval", detail: "Expected if the tools really are destructive; otherwise loosen the approval policy.", severity: 4 },
};

const pct = (n: number, total: number): number => (total ? n / total : 0);

/**
 * Patterns across a set of runs, most severe first.
 *
 * Returns [] for an empty or tiny ledger rather than straining to say
 * something: with three runs there is no such thing as a trend.
 */
export function minePatterns(runs: RunLike[], opts: MineOptions = {}): Pattern[] {
  const minRuns = opts.minRuns ?? MINE_DEFAULTS.minRuns;
  const limit = opts.limit ?? MINE_DEFAULTS.limit;
  const total = runs.length;
  if (total < minRuns) return [];

  const out: Pattern[] = [];

  // 1. Recurring flags.
  const byFlag = new Map<string, string[]>();
  for (const r of runs) {
    for (const f of new Set(r.flags)) {
      if (!ACTIONABLE_FLAGS[f]) continue;
      byFlag.set(f, [...(byFlag.get(f) ?? []), r.runId]);
    }
  }
  for (const [flag, ids] of byFlag) {
    if (ids.length < minRuns) continue;
    const meta = ACTIONABLE_FLAGS[flag];
    out.push({
      id: `flag:${flag}`, kind: "flag", label: meta.label, detail: meta.detail,
      runIds: ids, count: ids.length, share: pct(ids.length, total), severity: meta.severity,
    });
  }

  // 2. Runs that ended badly, grouped by how.
  const byStatus = new Map<string, string[]>();
  for (const r of runs) {
    if (r.status === "finished" || r.status === "running") continue;
    byStatus.set(r.status, [...(byStatus.get(r.status) ?? []), r.runId]);
  }
  for (const [status, ids] of byStatus) {
    if (ids.length < minRuns) continue;
    out.push({
      id: `status:${status}`, kind: "status",
      label: `${ids.length} runs ended as "${status}"`,
      detail: "A run that never reaches an answer cannot be judged, so this hides every other problem behind it.",
      runIds: ids, count: ids.length, share: pct(ids.length, total), severity: 0,
    });
  }

  // 3. Runs that finished and were still judged wrong. The most valuable
  //    pattern there is: the harness worked and the answer was bad anyway.
  const failed = runs.filter((r) => r.pass === false).map((r) => r.runId);
  if (failed.length >= minRuns) {
    out.push({
      id: "verdict:failed", kind: "verdict",
      label: `${failed.length} runs finished but failed their definition of done`,
      detail: "These are the ones worth turning into golden-set tasks: the loop behaved and the answer was still wrong.",
      runIds: failed, count: failed.length, share: pct(failed.length, total), severity: 0,
    });
  }

  // 4. Cost outliers, measured against the median rather than the mean so one
  //    runaway run does not redefine "normal" and hide itself.
  const costs = runs.map((r) => r.costUsd).filter((c) => c > 0).sort((a, b) => a - b);
  if (costs.length >= minRuns * 2) {
    const median = costs[Math.floor(costs.length / 2)];
    const ids = runs.filter((r) => r.costUsd > median * 3).map((r) => r.runId);
    if (ids.length >= minRuns) {
      out.push({
        id: "cost:outlier", kind: "cost",
        label: `${ids.length} runs cost more than 3x the median`,
        detail: `Median is $${median.toFixed(4)}. Look at whether they are doing more work or just more turns.`,
        runIds: ids, count: ids.length, share: pct(ids.length, total), severity: 2,
      });
    }
  }

  // 5. Runs that used a lot of steps and still did not pass — different from
  //    cap_exhausted, which is about hitting the ceiling rather than grinding.
  const grinding = runs.filter((r) => r.steps >= 6 && r.pass !== true).map((r) => r.runId);
  if (grinding.length >= minRuns) {
    out.push({
      id: "stall:long", kind: "stall",
      label: `${grinding.length} long runs that did not pass`,
      detail: "Long and wrong usually means the objective is underspecified, not that the model is weak.",
      runIds: grinding, count: grinding.length, share: pct(grinding.length, total), severity: 1,
    });
  }

  return out
    .sort((a, b) => a.severity - b.severity || b.count - a.count || (a.id < b.id ? -1 : 1))
    .slice(0, limit);
}

/**
 * A golden-set task proposed from a pattern, or null when the pattern does not
 * imply one.
 *
 * Only `verdict` patterns become tasks. A run that failed its definition of
 * done is a correction waiting to be written down; a run that hit a step cap is
 * a harness problem, and turning that into a test would pin the bug in place.
 */
export function proposeTask(p: Pattern, runs: RunLike[]): { objective: string; fromRunId: string } | null {
  if (p.kind !== "verdict") return null;
  const first = runs.find((r) => r.runId === p.runIds[0]);
  if (!first) return null;
  return { objective: first.objective, fromRunId: first.runId };
}
