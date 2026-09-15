import { BID_COST_FLOOR } from "./config";
import type {
  AgentHistory, AgentProfile, Award, Bid, BidPriors, BidRequest,
  DefinitionOfDone, DodVerdict, RunTotals,
} from "./types";

/* ────────────────────────────────────────────────────────────────────────────
   Swarm bidding — agents bid on a task by cost and confidence, and the
   cheapest sufficiently-confident bidder wins.

   Everything here is arithmetic over recorded history. No model is ever asked
   how confident it is: a model's self-reported confidence is a sample from its
   prose style, while `passes / runs` is a measurement, and only one of the two
   can be wrong in a way a trace shows you.

   The cold start is the whole design problem. With raw counts a new agent is
   0/0 confident, scores zero, never wins, and therefore never earns the
   history that would let it win — a guard whose threshold moves opposite to
   the case it exists to serve. Laplace priors fix it: with no history every
   agent scores priorPasses/priorRuns over (defaultCostUsd + floor), which is
   identical and non-zero, and the lexicographic tie-break still names a
   winner. An auction must always produce one or say precisely why it did not.

   Abstentions are kept, never dropped. An auction where nobody bid has to be
   able to say why nobody bid.
   ──────────────────────────────────────────────────────────────────────────── */

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function skillTotals(h: AgentHistory, skills: string[]): { runs: number; passes: number } {
  let runs = 0;
  let passes = 0;
  for (const s of skills) {
    const row = h.bySkill[s];
    if (!row) continue;
    runs += row.runs;
    passes += row.passes;
  }
  return { runs, passes };
}

/** Tools the DoD's `tool_called` criteria name. An agent that cannot call one
 *  of them cannot satisfy the definition of done however cheap or confident it
 *  is, so it abstains rather than winning a task it must fail. */
function toolsRequiredBy(dod: DefinitionOfDone | null | undefined): string[] {
  if (!dod) return [];
  const out: string[] = [];
  for (const c of dod.criteria) {
    if (c.check.kind === "tool_called" && !out.includes(c.check.tool)) out.push(c.check.tool);
  }
  return out;
}

/** Price and confidence for one agent on one task.
 *
 *  `dod` is optional because `BidRequest` carries only a `dodId`; pass the
 *  resolved definition of done and the tool check below applies, omit it and
 *  the other four abstention rules still do. */
export function computeBid(
  agent: AgentProfile,
  req: BidRequest,
  priors: BidPriors,
  dod?: DefinitionOfDone | null,
): Bid {
  const h = agent.history;

  // An empty `requires` means the task declares no skills, so the skill filter
  // would compare every agent on zero evidence. Fall back to the agent's whole
  // record: less specific, but still a measurement.
  const matched = req.requires.filter((s) => agent.skills.includes(s));
  const evidence = req.requires.length === 0
    ? { runs: h.runs, passes: h.passes }
    : skillTotals(h, matched);

  const confidence =
    (evidence.passes + priors.priorPasses) / (evidence.runs + priors.priorRuns);
  const estCostUsd = h.runs > 0 ? h.meanCostUsd : priors.defaultCostUsd;
  const estMs = h.runs > 0 ? h.meanMs : priors.defaultMs;
  // The floor keeps a free or near-free agent from dividing by ~0 and winning
  // every auction on arithmetic alone, however unconfident it is.
  const score = confidence / (estCostUsd + BID_COST_FLOOR);

  const basis = req.requires.length === 0
    ? `${evidence.passes}/${evidence.runs} overall`
    : `${evidence.passes}/${evidence.runs} on ${matched.length > 0 ? matched.map((s) => `skill:${s}`).join(", ") : "no matching skill"}`;
  const rationale =
    h.runs === 0
      ? `no history; Laplace prior ${priors.priorPasses}/${priors.priorRuns} at ${usd(priors.defaultCostUsd)} default (confidence ${confidence.toFixed(3)})`
      : `${basis}, mean ${usd(h.meanCostUsd)} over ${h.runs} runs (confidence ${confidence.toFixed(3)})`;

  const bid: Bid = { agentId: agent.id, taskId: req.taskId, estCostUsd, estMs, confidence, score, rationale };

  const missingSkills = req.requires.filter((s) => !agent.skills.includes(s));
  const missingTools = toolsRequiredBy(dod).filter((t) => !agent.toolNames.includes(t));

  let abstainReason: string | null = null;
  if (!agent.enabled) {
    abstainReason = "disabled";
  } else if (missingSkills.length > 0) {
    abstainReason = `missing required skill(s): ${missingSkills.join(", ")}`;
  } else if (estCostUsd > req.maxCostUsd) {
    abstainReason = `estimated ${usd(estCostUsd)} exceeds the task budget of ${usd(req.maxCostUsd)}`;
  } else if (estMs > req.deadlineMs) {
    abstainReason = `estimated ${estMs}ms exceeds the deadline of ${req.deadlineMs}ms`;
  } else if (missingTools.length > 0) {
    abstainReason = `cannot call tool(s) the definition of done requires: ${missingTools.join(", ")}`;
  }

  if (abstainReason === null) return bid;
  // Score zeroed so that a caller who sorts every bid together, abstentions
  // included, can never accidentally award one; the estimates stay for the
  // audit trail.
  return { ...bid, score: 0, abstainReason };
}

/** Rank the bids and name a winner.
 *
 *  Sorted by score descending, ties broken on `agentId` ascending so the same
 *  agents and the same history always produce the same award — an auction
 *  nobody can reproduce is not evidence about anything. */
export function runAuction(
  agents: AgentProfile[],
  req: BidRequest,
  priors: BidPriors,
  dod?: DefinitionOfDone | null,
): Award {
  const bids = agents.map((a) => computeBid(a, req, priors, dod));
  const abstained = bids.filter((b) => b.abstainReason !== undefined);
  const contenders = bids
    .filter((b) => b.abstainReason === undefined)
    .sort((a, b) => (b.score - a.score) || (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));

  const winner = contenders[0] ?? null;
  const runnersUp = contenders.slice(1);

  const reason = winner
    ? `${winner.agentId} won at score ${winner.score.toFixed(4)}: ${winner.rationale}. ` +
      `${runnersUp.length} runner(s)-up${runnersUp.length > 0 ? ` (${runnersUp.map((b) => `${b.agentId} ${b.score.toFixed(4)}`).join(", ")})` : ""}, ` +
      `${abstained.length} abstained.`
    : agents.length === 0
      ? "no agents were offered the task."
      : `no winner: all ${agents.length} agent(s) abstained — ${abstained.map((b) => `${b.agentId}: ${b.abstainReason ?? "unknown"}`).join("; ")}.`;

  return { taskId: req.taskId, winner, runnersUp, abstained, reason };
}

/** Fold one finished run into an agent's record.
 *
 *  The cost mean covers every run, pass or fail. Excluding the failures makes
 *  an agent look cheaper than it is, and the auction then keeps buying the
 *  cheap-looking one that has to be run twice. */
export function updateHistory(
  h: AgentHistory,
  verdict: DodVerdict,
  totals: RunTotals,
  skills: string[],
): AgentHistory {
  const runs = h.runs + 1;
  const passed = verdict.pass ? 1 : 0;
  const bySkill: AgentHistory["bySkill"] = { ...h.bySkill };
  // Deduped: a skill listed twice on one run would otherwise count as two
  // runs' worth of evidence from a single data point.
  for (const s of new Set(skills)) {
    const prev = bySkill[s] ?? { runs: 0, passes: 0 };
    bySkill[s] = { runs: prev.runs + 1, passes: prev.passes + passed };
  }
  return {
    runs,
    passes: h.passes + passed,
    meanCostUsd: (h.meanCostUsd * h.runs + totals.costUsd) / runs,
    meanMs: (h.meanMs * h.runs + totals.ms) / runs,
    bySkill,
  };
}
