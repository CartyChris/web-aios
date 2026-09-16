import type {
  AgentHistory, AgentProfile, Award, BidPriors, BidRequest, Criterion,
  DefinitionOfDone, DodVerdict, RunResult, TriggerEvent,
} from "./types";
import { dodValidate, evaluateFixedCriteria, verdictReason } from "./dod";
import { runAuction } from "./bid";
import { BID_PRIORS } from "./config";

/* ────────────────────────────────────────────────────────────────────────────
   Giving the swarm a definition of done, and a reason for who runs.

   Swarm has always been able to fan a question across agents and reconcile the
   answers. What it could not do is say whether the result was any good — it
   printed a synthesis and stopped, and every run "succeeded" because nothing
   was ever asked to fail. `dod.ts` and `bid.ts` were written and tested
   sessions ago and nothing called either of them. This is the caller.

   Two things change as a result:

   - A swarm that does not meet its definition of done says so. The verdict is
     written from the outcomes BY CODE, never authored by a model — a synthesis
     pass grading its own synthesis is the purest form of the verifier problem.
   - Who runs is decided by measured history rather than by whoever is on the
     list. An agent that has never passed anything in its formation's skill
     still bids, but it bids low, and the rationale names the evidence.

   PURE. Everything here is a computation over records the app already holds.
   ──────────────────────────────────────────────────────────────────────────── */

export const SWARM_DOD_MIN_AGENTS = 2;

/** How many characters of synthesis stop counting as a synthesis. Below this a
 *  reconciliation is a sentence of throat-clearing. */
const MIN_SYNTHESIS_CHARS = 200;

export interface SwarmOutcome {
  agentId: string;
  agentName: string;
  status: "done" | "error" | "skipped" | "idle" | "running";
  output: string;
  costUsd: number;
  ms: number;
}

export interface SwarmSnapshot {
  question: string;
  formationId: string;
  outcomes: SwarmOutcome[];
  synthesis: string;
  startedAt: number;
  endedAt: number;
}

/* ── the definition of done ──────────────────────────────────────────────── */

/**
 * The standing definition of done for any swarm.
 *
 * The user's instruction was blunt and correct: "swarms must ALWAYS have a
 * definition of done." So this is not optional and not per-formation — it is
 * the floor every swarm is held to, and a formation may add to it.
 *
 * Each criterion here is one a person could check by looking. That is the test
 * for whether a criterion is real: `dodValidate` rejects an expectation under
 * a length floor precisely because "quality is good" is not an observation.
 */
export function swarmDod(opts: { owner: string; minAgents?: number; requireSynthesis?: boolean; extra?: Criterion[] }): DefinitionOfDone {
  const minAgents = Math.max(1, opts.minAgents ?? SWARM_DOD_MIN_AGENTS);
  const criteria: Criterion[] = [
    {
      id: "agents_reported",
      label: "Enough agents answered",
      expectation: `At least ${minAgents} agents finished and produced non-empty output. One agent answering is a chat message, not a swarm.`,
      check: { kind: "regex", pattern: `AGENTS_DONE=(${rangeAtLeast(minAgents)})\\b` },
      by: "fixed",
      weight: 3,
      required: true,
    },
    {
      id: "no_total_failure",
      label: "No agent failed silently",
      expectation: "The report does not record an agent whose run errored without a message a reader can act on.",
      check: { kind: "not_contains", value: "ERROR_WITHOUT_REASON" },
      by: "fixed",
      weight: 1,
      required: false,
    },
    {
      id: "disagreement_addressed",
      label: "Disagreement was named, not averaged",
      expectation:
        "The synthesis explicitly names where the agents disagreed, or states plainly that they agreed. A synthesis that does neither has averaged the panel away, which is the exact failure a panel exists to prevent.",
      check: { kind: "regex", pattern: "disagree|agree|consensus|conflict|differ|unresolved", flags: "i" },
      by: "fixed",
      weight: 2,
      required: true,
    },
  ];

  if (opts.requireSynthesis !== false) {
    criteria.push({
      id: "synthesis_substantive",
      label: "The synthesis says something",
      expectation: `The reconciliation is at least ${MIN_SYNTHESIS_CHARS} characters. Shorter than that it restates the question and stops.`,
      check: { kind: "regex", pattern: "SYNTHESIS_CHARS=([2-9]\\d{2,}|\\d{4,})\\b" },
      by: "fixed",
      weight: 2,
      required: true,
    });
  }

  return {
    id: "swarm.default.v1",
    label: "Swarm floor",
    criteria: [...criteria, ...(opts.extra ?? [])],
    passThreshold: 0.7,
    // A DoD nobody owns is nobody's job — dodValidate refuses a blank owner.
    owner: opts.owner.trim() || "the operator",
  };
}

/** A regex alternation matching every integer from `min` upward, for the small
 *  values a formation can actually reach. Written out rather than compared
 *  numerically because the check vocabulary is string-shaped, and a lookahead
 *  that silently matches nothing is exactly the self-defeating guard this
 *  codebase keeps finding. */
function rangeAtLeast(min: number): string {
  const singles: string[] = [];
  for (let i = min; i <= 9; i++) singles.push(String(i));
  // Two or more digits is always >= 10, which is always >= any min we allow.
  return [...singles, "\\d{2,}"].join("|");
}

/* ── judging a swarm ─────────────────────────────────────────────────────── */

/**
 * Render a swarm into the text the fixed criteria read.
 *
 * The counts are emitted as machine tokens — `AGENTS_DONE=3` — rather than
 * left for a regex to find in prose. A criterion that has to parse English to
 * learn how many agents ran is a criterion that starts passing the day someone
 * rewords a heading.
 */
export function swarmReportText(s: SwarmSnapshot): string {
  const done = s.outcomes.filter((o) => o.status === "done" && o.output.trim().length > 0);
  const errored = s.outcomes.filter((o) => o.status === "error");
  const lines = [
    `AGENTS_DONE=${done.length}`,
    `AGENTS_TOTAL=${s.outcomes.length}`,
    `AGENTS_ERRORED=${errored.length}`,
    `SYNTHESIS_CHARS=${s.synthesis.trim().length}`,
  ];
  // A failure with no message is worse than a failure: it is a gap in the
  // record that reads as though nothing happened.
  for (const o of errored) {
    if (!o.output.trim()) lines.push(`ERROR_WITHOUT_REASON agent=${o.agentId}`);
  }
  lines.push("", s.synthesis);
  for (const o of s.outcomes) lines.push("", `## ${o.agentName} [${o.status}]`, o.output);
  return lines.join("\n");
}

/** A RunResult shaped from a swarm, so the swarm is judged by exactly the same
 *  code path as a harness run. Duplicating the check logic here would let the
 *  two drift, and the one that drifts is always the one with fewer tests. */
export function swarmAsRun(s: SwarmSnapshot, runId: string): RunResult {
  const trigger: TriggerEvent = { triggerId: "swarm", kind: "manual", at: s.startedAt, payload: {}, dedupeKey: runId };
  const costUsd = s.outcomes.reduce((a, o) => a + o.costUsd, 0);
  const done = s.outcomes.filter((o) => o.status === "done");
  return {
    runId,
    configId: "swarm",
    agentId: null,
    objective: s.question,
    trigger,
    status: done.length > 0 ? "finished" : "failed",
    // The REPORT, not the bare synthesis. Every fixed check in dod.ts reads
    // `run.answer` and nothing reads `transcript`, so machine counts placed in
    // the transcript would be invisible to the criteria that exist to read
    // them — a criterion that can never match is the self-defeating guard this
    // codebase keeps finding. The synthesis is still the tail of the report.
    answer: swarmReportText(s),
    steps: [],
    transcript: swarmReportText(s),
    spans: [],
    verdict: null,
    flags: [],
    totals: {
      steps: s.outcomes.length,
      llmCalls: done.length + (s.synthesis ? 1 : 0),
      repairCalls: 0,
      toolCalls: 0,
      toolErrors: s.outcomes.filter((o) => o.status === "error").length,
      tokensIn: 0,
      tokensOut: 0,
      costUsd,
      ms: Math.max(0, s.endedAt - s.startedAt),
    },
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    fingerprint: `swarm:${s.formationId}:${s.outcomes.length}`,
  };
}

/**
 * Judge a swarm. Fixed criteria only — deliberately.
 *
 * A `judge` criterion would need a model, and the model available is the one
 * that just wrote the synthesis. `mergeConfig` swaps the judge's model in the
 * harness for exactly this reason; here there is nothing to swap to, so rather
 * than run a verifier on the producer's own weights and call the agreement a
 * pass, this judges only what code can check and the UI says so.
 */
export function judgeSwarm(s: SwarmSnapshot, dod: DefinitionOfDone, runId: string): { verdict: DodVerdict; run: RunResult } {
  const run = swarmAsRun(s, runId);
  const outcomes = evaluateFixedCriteria(dod, run);

  const byId = new Map(dod.criteria.map((c) => [c.id, c]));
  let earned = 0;
  let total = 0;
  let requiredFailed = false;
  for (const o of outcomes) {
    const c = byId.get(o.criterionId);
    if (!c) continue;
    total += c.weight;
    if (o.met === true) earned += c.weight;
    if (o.met === false && c.required) requiredFailed = true;
  }
  const score = total > 0 ? earned / total : 0;
  const pending = dod.criteria.filter((c) => c.by === "human").map((c) => c.id);

  const verdict: DodVerdict = {
    dodId: dod.id,
    pass: !requiredFailed && pending.length === 0 && score >= dod.passThreshold,
    score,
    outcomes,
    decidedBy: null,
    decidedAt: s.endedAt,
    // Written from the outcomes by code. A model never authors a verdict about
    // its own output.
    reason: verdictReason(dod, outcomes),
    pendingHuman: pending,
  };
  return { verdict, run: { ...run, verdict } };
}

/** Refuse to start a swarm whose definition of done cannot fail. */
export function validateSwarmDod(dod: DefinitionOfDone): { ok: true } | { ok: false; reasons: string[] } {
  return dodValidate(dod);
}

/* ── the bidding pass ────────────────────────────────────────────────────── */

const COLD_HISTORY: AgentHistory = { runs: 0, passes: 0, meanCostUsd: 0, meanMs: 0, bySkill: {} };

/** Turn a swarm agent into a profile the auction understands. History comes
 *  from the app's own ledger; an agent with none bids on the priors, which is
 *  what stops a cold-start agent from being permanently unbiddable. */
export function profileFor(
  agent: { id: string; name: string; role: string; model?: string; provider?: string },
  skills: string[],
  history?: AgentHistory,
): AgentProfile {
  // `computeBid` abstains on ANY missing required skill, so an agent briefed
  // into a formation must carry that formation's whole skill set. Handing it
  // one skill out of two makes every agent abstain and the auction awards
  // nobody — which looks exactly like "the swarm found no one suitable".
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    llm: {
      provider: agent.provider ?? "",
      model: agent.model ?? "",
      temperature: 0.7,
      maxTokens: 1200,
      persona: false,
    },
    skills,
    toolNames: [],
    history: history ?? { ...COLD_HISTORY, bySkill: {} },
    enabled: true,
  };
}

/**
 * Rank a formation's agents by measured value for money.
 *
 * The auction picks ONE winner; a swarm wants an ordering, because the whole
 * point is to run several. So the award is read as a ranking: the winner
 * first, the runners-up behind it, and the abstainers last with their reasons
 * intact. An auction where everyone abstained must still say why — dropping
 * the abstentions is how a swarm silently runs nobody.
 */
export function rankAgents(
  profiles: AgentProfile[],
  req: BidRequest,
  priors: BidPriors = BID_PRIORS,
  dod?: DefinitionOfDone | null,
): { award: Award; order: string[]; withinBudget: string[] } {
  const award = runAuction(profiles, req, priors, dod);
  const ranked = [...(award.winner ? [award.winner] : []), ...award.runnersUp];
  const order = ranked.map((b) => b.agentId);

  // Walk the ranking accumulating predicted cost, and stop at the budget. This
  // is the difference between a budget that stops a swarm halfway through and
  // one that decides up front which agents are worth the money.
  const withinBudget: string[] = [];
  let spent = 0;
  for (const bid of ranked) {
    if (req.maxCostUsd > 0 && spent + bid.estCostUsd > req.maxCostUsd) break;
    spent += bid.estCostUsd;
    withinBudget.push(bid.agentId);
  }
  // Never plan to run nobody. `computeBid` abstains outright when an estimate
  // exceeds the task budget, so a budget below every estimate empties the
  // contender list entirely — and a swarm that runs no one while reporting
  // success is strictly worse than one that runs its cheapest agent and lets
  // the live budget stop catch it. Only a COST abstention is rescued; an agent
  // that lacks the skills is not made suitable by being cheap.
  if (withinBudget.length === 0) {
    const cheapest = [...award.abstained]
      .filter((b) => (b.abstainReason ?? "").startsWith("estimated $"))
      .sort((a, b) => a.estCostUsd - b.estCostUsd)[0];
    const fallback = order[0] ?? cheapest?.agentId;
    if (fallback) withinBudget.push(fallback);
  }

  return { award, order: order.length > 0 ? order : withinBudget, withinBudget };
}

/** Skills a formation exercises, used as the auction's `requires`. Derived
 *  from the formation id so a new formation does not silently arrive with an
 *  empty skill list — which would make every agent bid on its whole record
 *  rather than on the relevant part of it. */
export const FORMATION_SKILLS: Record<string, string[]> = {
  redblue: ["argument", "critique"],
  research: ["research", "corroboration"],
  engineering: ["architecture", "security", "performance"],
  explainers: ["explanation"],
  consensus: ["general"],
};

export function skillsFor(formationId: string): string[] {
  return FORMATION_SKILLS[formationId] ?? ["general"];
}

/** Profiles for a whole formation, each carrying the formation's skills. This
 *  is the call site the app uses; `profileFor` is the single-agent form. */
export function profilesForFormation(
  formationId: string,
  agents: Array<{ id: string; name: string; role: string; model?: string; provider?: string; enabled?: boolean }>,
  historyFor?: (agentId: string) => AgentHistory | undefined,
): AgentProfile[] {
  const skills = skillsFor(formationId);
  return agents.map((a) => ({
    ...profileFor(a, skills, historyFor?.(a.id)),
    enabled: a.enabled !== false,
  }));
}

export function bidRequestFor(opts: {
  question: string;
  formationId: string;
  dodId: string;
  maxCostUsd: number;
  deadlineMs: number;
}): BidRequest {
  return {
    taskId: `swarm:${opts.formationId}`,
    objective: opts.question,
    requires: skillsFor(opts.formationId),
    dodId: opts.dodId,
    // 0 means "no budget set", which everywhere else in this OS means
    // unlimited. `computeBid` compares against it literally, so a bare 0 would
    // make every agent abstain for exceeding a budget of nothing — the exact
    // inverse of what the user asked for.
    maxCostUsd: opts.maxCostUsd > 0 ? opts.maxCostUsd : Number.POSITIVE_INFINITY,
    deadlineMs: opts.deadlineMs,
  };
}
