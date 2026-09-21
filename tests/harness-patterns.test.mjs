/* Mining a run ledger into patterns worth acting on.
 *
 * The discipline under test is restraint: one bad run is an anecdote, and a
 * miner that reports anecdotes fills the harness with special cases for
 * problems that never came back.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { minePatterns, proposeTask, MINE_DEFAULTS } from "../.test-build/harness/patterns.js";

const run = (id, over = {}) => ({
  runId: id, objective: `objective ${id}`, status: "finished", pass: true,
  steps: 3, costUsd: 0.01, ms: 1000, flags: [], startedAt: 1000, ...over,
});

/* ── restraint ───────────────────────────────────────────────────────────── */

test("an empty ledger produces nothing", () => {
  assert.deepEqual(minePatterns([]), []);
});

test("a ledger smaller than the threshold produces nothing", () => {
  // With one run there is no such thing as a trend.
  assert.deepEqual(minePatterns([run("a", { flags: ["loop_detected"] })]), []);
});

test("a one-off problem is not reported at all", () => {
  const runs = [run("a", { flags: ["loop_detected"] }), run("b"), run("c"), run("d")];
  assert.deepEqual(minePatterns(runs).filter((p) => p.id === "flag:loop_detected"), []);
});

test("the same problem twice IS reported", () => {
  const runs = [run("a", { flags: ["loop_detected"] }), run("b", { flags: ["loop_detected"] }), run("c")];
  const p = minePatterns(runs).find((x) => x.id === "flag:loop_detected");
  assert.ok(p, "two occurrences clear the bar");
  assert.equal(p.count, 2);
});

test("the threshold is configurable and respected", () => {
  const runs = [run("a", { flags: ["tool_error"] }), run("b", { flags: ["tool_error"] }), run("c")];
  assert.equal(minePatterns(runs, { minRuns: 3 }).filter((p) => p.kind === "flag").length, 0);
  assert.ok(minePatterns(runs, { minRuns: 2 }).some((p) => p.kind === "flag"));
});

/* ── receipts ────────────────────────────────────────────────────────────── */

test("every pattern names the runs it came from", () => {
  const runs = [run("a", { flags: ["tool_error"] }), run("b", { flags: ["tool_error"] }), run("c")];
  const p = minePatterns(runs).find((x) => x.id === "flag:tool_error");
  assert.deepEqual(p.runIds, ["a", "b"]);
  assert.equal(p.count, p.runIds.length, "the count and the receipts must agree");
});

test("share is a fraction of the runs considered", () => {
  const runs = [run("a", { flags: ["tool_error"] }), run("b", { flags: ["tool_error"] }), run("c"), run("d")];
  const p = minePatterns(runs).find((x) => x.id === "flag:tool_error");
  assert.equal(p.share, 0.5);
});

test("a flag repeated inside ONE run counts once, not twice", () => {
  // Otherwise a single chatty run would manufacture a trend by itself.
  const runs = [run("a", { flags: ["tool_error", "tool_error", "tool_error"] }), run("b"), run("c")];
  assert.equal(minePatterns(runs).filter((p) => p.id === "flag:tool_error").length, 0);
});

/* ── which flags are worth reporting ─────────────────────────────────────── */

test("only flags a harness change could fix are reported", () => {
  const runs = [run("a", { flags: ["something_unknown"] }), run("b", { flags: ["something_unknown"] })];
  assert.deepEqual(minePatterns(runs).filter((p) => p.kind === "flag"), []);
});

test("each reported flag comes with advice, not just a count", () => {
  const runs = [run("a", { flags: ["parse_repair"] }), run("b", { flags: ["parse_repair"] })];
  const p = minePatterns(runs).find((x) => x.kind === "flag");
  assert.ok(p.detail.length > 20, "a pattern with no advice is just a number");
});

/* ── statuses and verdicts ───────────────────────────────────────────────── */

test("runs that never reached an answer are grouped by how they ended", () => {
  const runs = [run("a", { status: "timeout", pass: null }), run("b", { status: "timeout", pass: null }), run("c")];
  const p = minePatterns(runs).find((x) => x.id === "status:timeout");
  assert.ok(p);
  assert.match(p.label, /timeout/);
});

test("finished and running are not failure statuses", () => {
  const runs = [run("a"), run("b"), run("c", { status: "running", pass: null })];
  assert.deepEqual(minePatterns(runs).filter((p) => p.kind === "status"), []);
});

test("runs that finished and still failed are called out as the valuable ones", () => {
  const runs = [run("a", { pass: false }), run("b", { pass: false }), run("c")];
  const p = minePatterns(runs).find((x) => x.kind === "verdict");
  assert.ok(p);
  assert.equal(p.count, 2);
  assert.equal(p.severity, 0, "a wrong answer from a healthy loop is the top priority");
});

test("a null verdict is not a failure — it is an unjudged run", () => {
  const runs = [run("a", { pass: null }), run("b", { pass: null }), run("c")];
  assert.deepEqual(minePatterns(runs).filter((p) => p.kind === "verdict"), []);
});

/* ── cost ────────────────────────────────────────────────────────────────── */

test("cost outliers are measured against the MEDIAN, not the mean", () => {
  // Against a mean, two runaway runs drag the average up far enough to hide
  // themselves. The median is unmoved by them, which is the point.
  const cheap = Array.from({ length: 8 }, (_, i) => run(`c${i}`, { costUsd: 0.01 }));
  const dear = [run("x", { costUsd: 5 }), run("y", { costUsd: 6 })];
  const p = minePatterns([...cheap, ...dear]).find((x) => x.kind === "cost");
  assert.ok(p, "two runs at 500x the median must be visible");
  assert.deepEqual(p.runIds.sort(), ["x", "y"]);
});

test("a uniform ledger reports no cost outliers", () => {
  const runs = Array.from({ length: 10 }, (_, i) => run(`c${i}`, { costUsd: 0.02 }));
  assert.deepEqual(minePatterns(runs).filter((p) => p.kind === "cost"), []);
});

test("a ledger too small to have a meaningful median is not mined for cost", () => {
  const runs = [run("a", { costUsd: 0.01 }), run("b", { costUsd: 9 })];
  assert.deepEqual(minePatterns(runs).filter((p) => p.kind === "cost"), []);
});

/* ── ordering ────────────────────────────────────────────────────────────── */

test("the worst patterns come first, and ties break deterministically", () => {
  const runs = [
    run("a", { pass: false, flags: ["parse_repair"] }),
    run("b", { pass: false, flags: ["parse_repair"] }),
    run("c", { flags: ["parse_repair"] }),
  ];
  const ps = minePatterns(runs);
  assert.equal(ps[0].severity, 0, "severity 0 sorts first");
  assert.deepEqual(minePatterns(runs).map((p) => p.id), ps.map((p) => p.id), "and the order is stable");
});

test("the result is capped", () => {
  const runs = Array.from({ length: 20 }, (_, i) =>
    run(`r${i}`, { pass: false, status: "timeout", steps: 9, costUsd: i, flags: Object.keys({ loop_detected: 1, cap_exhausted: 1, tool_error: 1, invalid_action: 1, parse_repair: 1, empty_step: 1 }) }));
  assert.ok(minePatterns(runs, { limit: 3 }).length <= 3);
  assert.ok(minePatterns(runs).length <= MINE_DEFAULTS.limit);
});

/* ── proposing a test from a pattern ─────────────────────────────────────── */

test("a failed-verdict pattern becomes a golden-set task", () => {
  const runs = [run("a", { pass: false }), run("b", { pass: false }), run("c")];
  const p = minePatterns(runs).find((x) => x.kind === "verdict");
  const t = proposeTask(p, runs);
  assert.equal(t.objective, "objective a");
  assert.equal(t.fromRunId, "a");
});

test("a harness problem does NOT become a task", () => {
  // Turning "it ran out of steps" into a test would pin the bug in place
  // instead of fixing it.
  const runs = [run("a", { flags: ["cap_exhausted"] }), run("b", { flags: ["cap_exhausted"] })];
  const p = minePatterns(runs).find((x) => x.kind === "flag");
  assert.equal(proposeTask(p, runs), null);
});

test("a pattern whose runs have since been cleared proposes nothing", () => {
  const runs = [run("a", { pass: false }), run("b", { pass: false })];
  const p = minePatterns(runs).find((x) => x.kind === "verdict");
  assert.equal(proposeTask(p, []), null);
});
