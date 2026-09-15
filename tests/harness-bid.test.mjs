/**
 * The auction, and the day-one bug it is built to avoid.
 *
 * With raw pass counts a brand-new agent is 0/0 confident, scores zero, never
 * wins, and so never earns the history that would let it win — a guard whose
 * threshold moves opposite to the case it exists to serve. The cold-start test
 * below is therefore the load-bearing one: with no history at all, an auction
 * must still name a winner.
 *
 * Every abstention rule is paired with a negative control that flips one input
 * and shows the same agent bidding, because an abstention rule that fires on
 * everything silently empties the swarm.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBid, runAuction, updateHistory } from "../.test-build/harness/bid.js";
import { BID_PRIORS, BID_COST_FLOOR } from "../.test-build/harness/config.js";

const COLD_SCORE = (BID_PRIORS.priorPasses / BID_PRIORS.priorRuns) / (BID_PRIORS.defaultCostUsd + BID_COST_FLOOR);

function close(actual, expected, msg) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${msg ?? "value"}: ${actual} != ${expected}`);
}

function hist(patch = {}) {
  return { runs: 0, passes: 0, meanCostUsd: 0, meanMs: 0, bySkill: {}, ...patch };
}

function agent(id, patch = {}) {
  return {
    id, name: id, role: "does a thing",
    llm: { provider: "test", model: "test/model", temperature: 0, maxTokens: 400, persona: false },
    skills: ["research"], toolNames: ["search_docs", "think"],
    history: hist(), enabled: true, ...patch,
  };
}

function req(patch = {}) {
  return {
    taskId: "task_1", objective: "Report Q1 ARR.", requires: [], dodId: "dod_1",
    maxCostUsd: 1, deadlineMs: 600_000, ...patch,
  };
}

function dodRequiring(tool) {
  return {
    id: "dod_1", label: "needs a tool", owner: "chris", passThreshold: 1,
    criteria: [{
      id: "c1", label: "called the tool", expectation: "The trace shows the tool was called.",
      check: { kind: "tool_called", tool }, by: "fixed", weight: 1, required: true,
    }],
  };
}

const TOTALS = {
  steps: 3, llmCalls: 3, repairCalls: 0, toolCalls: 2, toolErrors: 0,
  tokensIn: 100, tokensOut: 50, costUsd: 0, ms: 0,
};

/* ── the cold start ─────────────────────────────────────────────────────── */

test("an agent with no history bids a real, non-zero score", () => {
  const b = computeBid(agent("a"), req(), BID_PRIORS);
  close(b.confidence, 0.5, "Laplace prior 1/2");
  close(b.estCostUsd, BID_PRIORS.defaultCostUsd, "default cost");
  close(b.estMs, BID_PRIORS.defaultMs, "default ms");
  close(b.score, COLD_SCORE, "score");
  assert.ok(b.score > 0, "a zero score can never win an auction");
  assert.equal(b.abstainReason, undefined);
  assert.ok(b.rationale.includes("no history"), b.rationale);
  assert.equal(b.taskId, "task_1");
});

test("an auction between three agents with no history still produces a winner", () => {
  const award = runAuction([agent("charlie"), agent("alpha"), agent("bravo")], req(), BID_PRIORS);
  assert.ok(award.winner !== null, "day one must not deadlock");
  assert.equal(award.winner.agentId, "alpha", "identical scores break on agentId, ascending");
  assert.equal(award.runnersUp.length, 2);
  assert.deepEqual(award.abstained, []);
  for (const b of [award.winner, ...award.runnersUp]) close(b.score, COLD_SCORE, b.agentId);

  // Reproducible: the same agents in a different order give the same award.
  const shuffled = runAuction([agent("bravo"), agent("charlie"), agent("alpha")], req(), BID_PRIORS);
  assert.deepEqual(shuffled, award);
});

/* ── evidence moves the score in the right direction ────────────────────── */

test("a good record beats the prior, a bad record loses to it", () => {
  const good = agent("veteran", {
    skills: ["research", "sql"],
    history: hist({ runs: 9, passes: 7, meanCostUsd: 0.02, meanMs: 5_000, bySkill: { sql: { runs: 9, passes: 7 } } }),
  });
  const bad = agent("burnt", {
    skills: ["research", "sql"],
    history: hist({ runs: 9, passes: 0, meanCostUsd: 0.02, meanMs: 5_000, bySkill: { sql: { runs: 9, passes: 0 } } }),
  });
  const fresh = agent("rookie", { skills: ["research", "sql"] });
  const r = req({ requires: ["sql"] });

  const gb = computeBid(good, r, BID_PRIORS);
  close(gb.confidence, 8 / 11, "7 passes + 1 prior over 9 runs + 2 prior");
  close(gb.score, (8 / 11) / (0.02 + BID_COST_FLOOR), "score");
  assert.ok(gb.rationale.includes("7/9 on skill:sql"), gb.rationale);

  const bb = computeBid(bad, r, BID_PRIORS);
  close(bb.confidence, 1 / 11, "0 passes + 1 prior");

  const award = runAuction([good, bad, fresh], r, BID_PRIORS);
  assert.equal(award.winner.agentId, "veteran");
  assert.deepEqual(award.runnersUp.map((b) => b.agentId), ["rookie", "burnt"],
    "a record of failure ranks below no record at all");
});

test("a cheaper agent of equal confidence wins, which is what cost in the score is for", () => {
  const cheap = agent("cheap", { history: hist({ runs: 4, passes: 2, meanCostUsd: 0.01, meanMs: 5_000 }) });
  const dear = agent("dear", { history: hist({ runs: 4, passes: 2, meanCostUsd: 0.20, meanMs: 5_000 }) });
  const award = runAuction([dear, cheap], req(), BID_PRIORS);

  assert.equal(award.winner.agentId, "cheap");
  close(award.winner.score, 0.5 / (0.01 + BID_COST_FLOOR), "cheap score");
  close(award.runnersUp[0].score, 0.5 / (0.20 + BID_COST_FLOOR), "dear score");
  assert.ok(award.reason.includes("cheap won at score"), award.reason);
});

/* ── abstention, each with its negative control ─────────────────────────── */

test("a disabled agent abstains; the same agent enabled bids", () => {
  const off = computeBid(agent("a", { enabled: false }), req(), BID_PRIORS);
  assert.equal(off.abstainReason, "disabled");
  assert.equal(off.score, 0, "an abstention can never win on score");
  close(off.estCostUsd, BID_PRIORS.defaultCostUsd, "the estimate is kept for the audit");

  assert.equal(computeBid(agent("a", { enabled: true }), req(), BID_PRIORS).abstainReason, undefined);
});

test("a missing skill abstains and names the skill; having it bids", () => {
  const b = computeBid(agent("a", { skills: ["research"] }), req({ requires: ["sql", "policy"] }), BID_PRIORS);
  assert.ok(b.abstainReason.includes("sql"), b.abstainReason);
  assert.ok(b.abstainReason.includes("policy"), b.abstainReason);

  const ok = computeBid(agent("a", { skills: ["research", "sql", "policy"] }), req({ requires: ["sql", "policy"] }), BID_PRIORS);
  assert.equal(ok.abstainReason, undefined);
});

test("a price above the task budget abstains; raising the budget bids", () => {
  const pricey = agent("a", { history: hist({ runs: 5, passes: 3, meanCostUsd: 0.20, meanMs: 5_000 }) });
  const over = computeBid(pricey, req({ maxCostUsd: 0.10 }), BID_PRIORS);
  assert.ok(over.abstainReason.includes("$0.2000"), over.abstainReason);
  assert.ok(over.abstainReason.includes("$0.1000"), over.abstainReason);

  assert.equal(computeBid(pricey, req({ maxCostUsd: 0.50 }), BID_PRIORS).abstainReason, undefined);
});

test("an estimate past the deadline abstains; a longer deadline bids", () => {
  const slow = agent("a", { history: hist({ runs: 5, passes: 3, meanCostUsd: 0.01, meanMs: 30_000 }) });
  const late = computeBid(slow, req({ deadlineMs: 10_000 }), BID_PRIORS);
  assert.ok(late.abstainReason.includes("30000ms"), late.abstainReason);

  assert.equal(computeBid(slow, req({ deadlineMs: 60_000 }), BID_PRIORS).abstainReason, undefined);
});

test("an agent that cannot call a tool the DoD requires abstains rather than winning a task it must fail", () => {
  const dod = dodRequiring("kpi");
  const without = computeBid(agent("a", { toolNames: ["search_docs"] }), req(), BID_PRIORS, dod);
  assert.ok(without.abstainReason.includes("kpi"), without.abstainReason);

  const with_ = computeBid(agent("a", { toolNames: ["search_docs", "kpi"] }), req(), BID_PRIORS, dod);
  assert.equal(with_.abstainReason, undefined);

  // The rule is DoD-driven: with no DoD resolved there is nothing to check against.
  assert.equal(computeBid(agent("a", { toolNames: ["search_docs"] }), req(), BID_PRIORS).abstainReason, undefined);
});

test("an auction where everyone abstains says who abstained and why", () => {
  const award = runAuction(
    [agent("a", { enabled: false }), agent("b", { skills: [] })],
    req({ requires: ["sql"] }),
    BID_PRIORS,
  );
  assert.equal(award.winner, null);
  assert.deepEqual(award.runnersUp, []);
  assert.equal(award.abstained.length, 2);
  assert.ok(award.reason.includes("a: disabled"), award.reason);
  assert.ok(award.reason.includes("b: missing required skill(s): sql"), award.reason);

  // Negative control: one eligible agent among the abstainers is awarded the task.
  const rescued = runAuction(
    [agent("a", { enabled: false }), agent("b", { skills: [] }), agent("c", { skills: ["sql"] })],
    req({ requires: ["sql"] }),
    BID_PRIORS,
  );
  assert.equal(rescued.winner.agentId, "c");
  assert.equal(rescued.abstained.length, 2);
});

test("an auction with no agents at all says so", () => {
  const award = runAuction([], req(), BID_PRIORS);
  assert.equal(award.winner, null);
  assert.equal(award.reason, "no agents were offered the task.");
  assert.equal(award.taskId, "task_1");
});

/* ── history ────────────────────────────────────────────────────────────── */

test("updateHistory folds in one run, counting a skill once however often it is listed", () => {
  const h = updateHistory(
    hist(),
    { pass: true },
    { ...TOTALS, costUsd: 0.04, ms: 8_000 },
    ["research", "research", "retrieval"],
  );
  assert.equal(h.runs, 1);
  assert.equal(h.passes, 1);
  close(h.meanCostUsd, 0.04, "mean cost");
  close(h.meanMs, 8_000, "mean ms");
  assert.deepEqual(h.bySkill, {
    research: { runs: 1, passes: 1 },
    retrieval: { runs: 1, passes: 1 },
  });
});

test("a failed run is counted, and its cost stays in the mean", () => {
  const h1 = updateHistory(hist(), { pass: true }, { ...TOTALS, costUsd: 0.04, ms: 8_000 }, ["research"]);
  const h2 = updateHistory(h1, { pass: false }, { ...TOTALS, costUsd: 0.10, ms: 12_000 }, ["research"]);

  assert.equal(h2.runs, 2);
  assert.equal(h2.passes, 1, "the failure did not count as a pass");
  close(h2.meanCostUsd, 0.07, "the failed round is part of the price");
  close(h2.meanMs, 10_000, "mean ms");
  assert.ok(h2.meanCostUsd > h1.meanCostUsd, "excluding failures would make the agent look cheaper than it is");
  assert.deepEqual(h2.bySkill, { research: { runs: 2, passes: 1 } });
  assert.deepEqual(h1.bySkill, { research: { runs: 1, passes: 1 } }, "the input history is not mutated");
});

test("the loop closes: winning and passing raises the next bid, failing lowers it", () => {
  const rookie = agent("rookie", { skills: ["research"] });
  const first = runAuction([rookie], req({ requires: ["research"] }), BID_PRIORS);
  assert.equal(first.winner.agentId, "rookie");

  const totals = { ...TOTALS, costUsd: 0.05, ms: 9_000 };
  const better = { ...rookie, history: updateHistory(rookie.history, { pass: true }, totals, ["research"]) };
  const worse = { ...rookie, history: updateHistory(rookie.history, { pass: false }, totals, ["research"]) };

  const afterPass = computeBid(better, req({ requires: ["research"] }), BID_PRIORS);
  const afterFail = computeBid(worse, req({ requires: ["research"] }), BID_PRIORS);

  close(afterPass.confidence, 2 / 3, "1 pass + 1 prior over 1 run + 2 prior");
  close(afterFail.confidence, 1 / 3, "0 passes + 1 prior over 1 run + 2 prior");
  assert.ok(afterPass.score > first.winner.score, "a pass must be worth something next time");
  assert.ok(afterFail.score < first.winner.score, "a failure must cost something next time");
  assert.ok(afterPass.rationale.includes("1/1 on skill:research"), afterPass.rationale);
});
