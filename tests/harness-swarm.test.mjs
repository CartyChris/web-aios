/* Swarm ← definition of done, and the bidding pass.
 *
 * The standing instruction is that a swarm must ALWAYS have a definition of
 * done. The tests that carry that are the ones proving the DoD can FAIL — a
 * floor everything clears is not a floor, and it is worse than none because it
 * manufactures confidence.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  swarmDod, swarmReportText, swarmAsRun, judgeSwarm, validateSwarmDod,
  profileFor, rankAgents, bidRequestFor, skillsFor, FORMATION_SKILLS,
  SWARM_DOD_MIN_AGENTS,
} from "../.test-build/harness/swarm.js";
import { dodValidate } from "../.test-build/harness/dod.js";
import { BID_PRIORS } from "../.test-build/harness/config.js";

const T0 = 1_776_254_400_000;

const GOOD_SYNTHESIS =
  "The panel largely agreed that the approach holds, but they disagree sharply on cost. " +
  "Red Team argued the index rebuild dominates; Blue Team argued it amortises over a week. " +
  "The better-supported side is Red Team, because the rebuild is measured and the amortisation is assumed. " +
  "What remains unresolved is whether the write volume in the second quarter was typical.";

const outcome = (patch = {}) => ({
  agentId: "ag1", agentName: "Red Team", status: "done", output: "Substantive answer.", costUsd: 0.01, ms: 400, ...patch,
});

const snapshot = (patch = {}) => ({
  question: "Should we rebuild the index nightly?",
  formationId: "redblue",
  outcomes: [outcome({ agentId: "ag1", agentName: "Red Team" }), outcome({ agentId: "ag2", agentName: "Blue Team" })],
  synthesis: GOOD_SYNTHESIS,
  startedAt: T0,
  endedAt: T0 + 5_000,
  ...patch,
});

const dod = (patch = {}) => swarmDod({ owner: "Chris Carty", ...patch });

/* ── the DoD itself ──────────────────────────────────────────────────────── */

test("the default swarm DoD survives the validator that rejects unfailable ones", () => {
  const r = dodValidate(dod());
  assert.equal(r.ok, true, r.ok ? "" : r.reasons.join("; "));
  assert.equal(validateSwarmDod(dod()).ok, true);
});

test("the DoD has at least one required criterion, so something on it can fail", () => {
  assert.ok(dod().criteria.some((c) => c.required), "every criterion is advisory");
});

test("a blank owner is replaced rather than left to fail validation", () => {
  // dodValidate refuses a blank owner; a DoD that cannot be constructed is a
  // worse outcome than one owned by "the operator".
  const d = swarmDod({ owner: "   " });
  assert.equal(d.owner, "the operator");
  assert.equal(dodValidate(d).ok, true);
});

test("every criterion carries an expectation a person could check by looking", () => {
  for (const c of dod().criteria) {
    assert.ok(c.expectation.trim().length >= 40, `${c.id}: expectation is too thin to check`);
  }
});

test("extra criteria are appended and still validate", () => {
  const d = dod({ extra: [{
    id: "mentions_cost", label: "Cost named", expectation: "The synthesis names a specific cost figure rather than saying it is expensive.",
    check: { kind: "regex", pattern: "\\$\\d" }, by: "fixed", weight: 1, required: false,
  }] });
  assert.equal(d.criteria.length, 5);
  assert.equal(dodValidate(d).ok, true);
});

/* ── the report text the criteria actually read ──────────────────────────── */

test("the report emits machine counts, not prose a reword would break", () => {
  const text = swarmReportText(snapshot());
  assert.match(text, /^AGENTS_DONE=2$/m);
  assert.match(text, /^AGENTS_TOTAL=2$/m);
  assert.match(text, /^SYNTHESIS_CHARS=\d+$/m);
});

test("an agent whose output is blank does not count as done", () => {
  const text = swarmReportText(snapshot({ outcomes: [outcome(), outcome({ agentId: "ag2", output: "   " })] }));
  assert.match(text, /^AGENTS_DONE=1$/m);
});

test("an errored agent with no message is flagged explicitly", () => {
  const text = swarmReportText(snapshot({ outcomes: [outcome(), outcome({ agentId: "ag2", status: "error", output: "" })] }));
  assert.match(text, /ERROR_WITHOUT_REASON agent=ag2/);
});

test("an errored agent WITH a message is not flagged — the negative control", () => {
  const text = swarmReportText(snapshot({ outcomes: [outcome(), outcome({ agentId: "ag2", status: "error", output: "429 rate limited" })] }));
  assert.doesNotMatch(text, /ERROR_WITHOUT_REASON/);
});

/* ── judging: it must be able to say no ──────────────────────────────────── */

test("a healthy swarm passes", () => {
  const { verdict } = judgeSwarm(snapshot(), dod(), "run_1");
  assert.equal(verdict.pass, true, verdict.reason);
  assert.ok(verdict.score >= 0.7);
  assert.equal(verdict.decidedBy, null);
});

test("one agent answering FAILS the floor — that is a chat message, not a swarm", () => {
  const { verdict } = judgeSwarm(snapshot({ outcomes: [outcome()] }), dod(), "run_2");
  assert.equal(verdict.pass, false);
  assert.match(verdict.reason, /agents_reported|Enough agents/i);
});

test("a synthesis that averages the panel away FAILS", () => {
  // No mention of agreement or disagreement anywhere: the panel was flattened.
  const flat = "The index should be rebuilt nightly. ".repeat(12);
  const { verdict } = judgeSwarm(snapshot({ synthesis: flat }), dod(), "run_3");
  assert.equal(verdict.pass, false);
});

test("a one-line synthesis FAILS the substance criterion", () => {
  const { verdict } = judgeSwarm(snapshot({ synthesis: "They disagree." }), dod(), "run_4");
  assert.equal(verdict.pass, false);
  assert.match(verdict.reason, /synthesis|substantive/i);
});

test("a swarm with no synthesis at all FAILS", () => {
  const { verdict } = judgeSwarm(snapshot({ synthesis: "" }), dod(), "run_5");
  assert.equal(verdict.pass, false);
});

test("requireSynthesis:false drops that criterion and the same run then passes", () => {
  // The negative control for the criterion itself: it must be the thing
  // deciding, not something else coincidentally failing at the same time.
  const s = snapshot({ synthesis: "They disagree on cost." });
  assert.equal(judgeSwarm(s, dod(), "a").verdict.pass, false);
  assert.equal(judgeSwarm(s, dod({ requireSynthesis: false }), "b").verdict.pass, true);
});

test("minAgents raises the bar and the same swarm then fails", () => {
  const s = snapshot();
  assert.equal(judgeSwarm(s, dod({ minAgents: 2 }), "a").verdict.pass, true);
  assert.equal(judgeSwarm(s, dod({ minAgents: 5 }), "b").verdict.pass, false);
});

test("the agent-count criterion matches double digits, not just single ones", () => {
  // A regex alternation over 2..9 that forgets \d{2,} silently fails a
  // twelve-agent swarm — a guard that excludes exactly the case it exists for.
  const many = Array.from({ length: 12 }, (_, i) => outcome({ agentId: `ag${i}`, agentName: `A${i}` }));
  const { verdict } = judgeSwarm(snapshot({ outcomes: many }), dod({ minAgents: 3 }), "run_6");
  assert.equal(verdict.pass, true, verdict.reason);
});

test("the verdict reason is written from the outcomes, not authored by a model", () => {
  const { verdict } = judgeSwarm(snapshot({ outcomes: [outcome()] }), dod(), "run_7");
  assert.ok(verdict.reason.length > 0);
  // It quotes criteria, which is what makes it checkable rather than narrative.
  assert.match(verdict.reason, /criteria|criterion|FAILED/i);
});

test("the score is a real weighted fraction, not a constant", () => {
  const pass = judgeSwarm(snapshot(), dod(), "a").verdict.score;
  const fail = judgeSwarm(snapshot({ outcomes: [outcome()], synthesis: "x" }), dod(), "b").verdict.score;
  assert.ok(pass > fail, `a good run scored ${pass} and a bad one ${fail}`);
  assert.ok(fail >= 0 && pass <= 1);
});

test("the swarm is judged through the same RunResult path a harness run uses", () => {
  const run = swarmAsRun(snapshot(), "run_8");
  assert.equal(run.objective, "Should we rebuild the index nightly?");
  // The answer is the REPORT — machine counts then the synthesis — because the
  // fixed criteria read run.answer and nothing reads run.transcript.
  assert.match(run.answer, /^AGENTS_DONE=2$/m);
  assert.ok(run.answer.includes(GOOD_SYNTHESIS), "the synthesis must survive into the judged text");
  assert.equal(run.status, "finished");
  assert.equal(run.totals.costUsd, 0.02);
  assert.equal(run.totals.ms, 5_000);
  assert.equal(run.trigger.kind, "manual");
});

test("a swarm where every agent failed is status failed, not finished", () => {
  const run = swarmAsRun(snapshot({ outcomes: [outcome({ status: "error" })] }), "run_9");
  assert.equal(run.status, "failed");
  assert.equal(run.totals.toolErrors, 1);
});

test("judgeSwarm returns a run carrying its own verdict, so the receipt is self-contained", () => {
  const { run, verdict } = judgeSwarm(snapshot(), dod(), "run_10");
  assert.deepEqual(run.verdict, verdict);
});

/* ── the bidding pass ────────────────────────────────────────────────────── */

const hist = (runs, passes, cost, bySkill = {}) => ({ runs, passes, meanCostUsd: cost, meanMs: 500, bySkill });

test("every shipped formation declares skills, so no agent bids on an empty requirement", () => {
  for (const id of ["redblue", "research", "engineering", "explainers", "consensus"]) {
    assert.ok(FORMATION_SKILLS[id]?.length > 0, `${id} has no skills`);
    assert.ok(skillsFor(id).length > 0);
  }
  assert.deepEqual(skillsFor("a_formation_added_later"), ["general"]);
});

test("a cheaper agent with the same record outranks a dearer one", () => {
  const cheap = profileFor({ id: "cheap", name: "Cheap", role: "r" }, skillsFor("redblue"), hist(10, 8, 0.01, { argument: { runs: 10, passes: 8 }, critique: { runs: 10, passes: 8 } }));
  const dear = profileFor({ id: "dear", name: "Dear", role: "r" }, skillsFor("redblue"), hist(10, 8, 0.50, { argument: { runs: 10, passes: 8 }, critique: { runs: 10, passes: 8 } }));
  const req = bidRequestFor({ question: "q", formationId: "redblue", dodId: "swarm.default.v1", maxCostUsd: 5, deadlineMs: 60_000 });
  const { order } = rankAgents([dear, cheap], req, BID_PRIORS);
  assert.equal(order[0], "cheap");
});

test("a better record outranks a worse one at the same price", () => {
  const good = profileFor({ id: "good", name: "G", role: "r" }, skillsFor("redblue"), hist(20, 18, 0.02, { argument: { runs: 20, passes: 18 }, critique: { runs: 20, passes: 18 } }));
  const poor = profileFor({ id: "poor", name: "P", role: "r" }, skillsFor("redblue"), hist(20, 2, 0.02, { argument: { runs: 20, passes: 2 }, critique: { runs: 20, passes: 2 } }));
  const req = bidRequestFor({ question: "q", formationId: "redblue", dodId: "d", maxCostUsd: 5, deadlineMs: 60_000 });
  assert.equal(rankAgents([poor, good], req, BID_PRIORS).order[0], "good");
});

test("a cold-start agent still bids rather than being permanently unrankable", () => {
  const cold = profileFor({ id: "cold", name: "C", role: "r" }, skillsFor("redblue"));
  const req = bidRequestFor({ question: "q", formationId: "redblue", dodId: "d", maxCostUsd: 5, deadlineMs: 60_000 });
  const { order, award } = rankAgents([cold], req, BID_PRIORS);
  assert.deepEqual(order, ["cold"]);
  assert.ok(award.winner.confidence > 0, "Laplace priors should keep a cold agent above zero confidence");
});

test("the budget decides who runs UP FRONT rather than stopping a swarm halfway", () => {
  const mk = (id, cost) => profileFor({ id, name: id, role: "r" }, skillsFor("redblue"), hist(10, 8, cost, { argument: { runs: 10, passes: 8 }, critique: { runs: 10, passes: 8 } }));
  const req = bidRequestFor({ question: "q", formationId: "redblue", dodId: "d", maxCostUsd: 0.05, deadlineMs: 60_000 });
  const { withinBudget, order } = rankAgents([mk("a", 0.02), mk("b", 0.02), mk("c", 0.02), mk("d", 0.02)], req, BID_PRIORS);
  assert.equal(order.length, 4, "every agent should still be ranked");
  assert.ok(withinBudget.length < order.length, "the budget did not exclude anybody");
  assert.ok(withinBudget.length >= 2);
});

test("when even the best bid exceeds the budget, one agent still runs", () => {
  // Planning to run nobody and reporting success is the worst available
  // outcome; let the live budget stop catch it instead.
  const dear = profileFor({ id: "dear", name: "D", role: "r" }, skillsFor("redblue"), hist(5, 4, 10, { argument: { runs: 5, passes: 4 }, critique: { runs: 5, passes: 4 } }));
  const req = bidRequestFor({ question: "q", formationId: "redblue", dodId: "d", maxCostUsd: 0.01, deadlineMs: 60_000 });
  const { withinBudget } = rankAgents([dear], req, BID_PRIORS);
  assert.deepEqual(withinBudget, ["dear"]);
});

test("a zero budget means unlimited, not 'run nobody'", () => {
  const mk = (id) => profileFor({ id, name: id, role: "r" }, skillsFor("redblue"), hist(5, 4, 0.2, { argument: { runs: 5, passes: 4 }, critique: { runs: 5, passes: 4 } }));
  const req = bidRequestFor({ question: "q", formationId: "redblue", dodId: "d", maxCostUsd: 0, deadlineMs: 60_000 });
  const { withinBudget } = rankAgents([mk("a"), mk("b"), mk("c")], req, BID_PRIORS);
  assert.equal(withinBudget.length, 3);
});

test("abstentions are kept with their reasons — an auction that ran nobody must say why", () => {
  const wrongSkill = profileFor({ id: "ws", name: "W", role: "r" }, ["cooking"], hist(5, 5, 0.01, { cooking: { runs: 5, passes: 5 } }));
  const req = bidRequestFor({ question: "q", formationId: "engineering", dodId: "d", maxCostUsd: 5, deadlineMs: 60_000 });
  const { award } = rankAgents([wrongSkill], req, BID_PRIORS);
  const everyone = [...(award.winner ? [award.winner] : []), ...award.runnersUp, ...award.abstained];
  assert.equal(everyone.length, 1, "a bidder vanished from the record");
  assert.ok(award.reason.length > 0);
});

test("the ranking is deterministic — two identical auctions agree", () => {
  const mk = (id) => profileFor({ id, name: id, role: "r" }, skillsFor("redblue"), hist(10, 8, 0.02, { argument: { runs: 10, passes: 8 }, critique: { runs: 10, passes: 8 } }));
  const req = bidRequestFor({ question: "q", formationId: "redblue", dodId: "d", maxCostUsd: 5, deadlineMs: 60_000 });
  const agents = [mk("b"), mk("a"), mk("c")];
  assert.deepEqual(rankAgents(agents, req, BID_PRIORS).order, rankAgents(agents, req, BID_PRIORS).order);
});

test("the bid request carries the DoD id, so who runs and what counts as done are linked", () => {
  const req = bidRequestFor({ question: "q", formationId: "redblue", dodId: "swarm.default.v1", maxCostUsd: 1, deadlineMs: 1000 });
  assert.equal(req.dodId, "swarm.default.v1");
  assert.deepEqual(req.requires, ["argument", "critique"]);
  assert.equal(req.taskId, "swarm:redblue");
});

test("the exported minimum is what the default DoD actually enforces", () => {
  assert.equal(SWARM_DOD_MIN_AGENTS, 2);
  const { verdict } = judgeSwarm(snapshot({ outcomes: [outcome()] }), swarmDod({ owner: "x" }), "r");
  assert.equal(verdict.pass, false);
});
