import type {
  AgentProfile, BidPriors, DefinitionOfDone, LlmConfig, LoopConfig,
} from "./types";

/* ────────────────────────────────────────────────────────────────────────────
   Every tunable the harness has, in one file.

   This exists because of the orchestration layer's rule: how far the agent is
   allowed to go is a CONFIG setting, not code. A limit written as a literal
   inside the loop body is a limit nobody can change without a deploy, and it
   stops being a policy the moment it is a number in an if-statement. The
   integrity gate enforces the same thing from the other side — it fails the
   build on a bare numeric loop limit in loop.ts.
   ──────────────────────────────────────────────────────────────────────────── */

/** How much of a span's payload is kept.
 *
 *  A trace is the receipt for a run, and a receipt nobody can store is no
 *  receipt at all: full model output across a few hundred spans will exhaust
 *  the origin's localStorage quota and take unrelated stores down with it.
 *  Bodies go to the VFS; the store keeps the head of each. */
export const TRACE_LIMITS = {
  text: 4_000,
  input: 2_000,
  error: 1_000,
  spansPerRun: 600,
} as const;

const WORKER: LlmConfig = {
  provider: "openrouter",
  model: "anthropic/claude-opus-5",
  // Greedy by default. The ReAct paper names greedy decoding as the suspected
  // cause of its 47% looping rate but never acts on it; resampling only once a
  // loop is actually detected keeps determinism as the default and buys the
  // escape where it is needed.
  temperature: 0,
  // 400, not the paper's 100. 100 caps a thought plus `Search[x]` and nothing
  // more; our actions carry JSON arguments, and truncating one mid-object
  // manufactures the exact parse failure the repair path then pays for.
  maxTokens: 400,
  persona: false,
};

const JUDGE: LlmConfig = {
  provider: "openrouter",
  model: "openai/gpt-5.2",
  temperature: 0,
  maxTokens: 400,
  persona: false,
};

export const DEFAULT_LOOP_CONFIG: LoopConfig = {
  id: "default",
  name: "Default",
  // The paper uses 7 for HotpotQA against two tools. Ours has ten, so a run
  // legitimately spends a step or two more on retrieval before it can answer.
  maxSteps: 8,
  maxToolErrors: 3,
  maxRepairsPerRun: 2,
  stepTimeoutMs: 60_000,
  runTimeoutMs: 300_000,
  maxCostUsd: 0.5,
  thoughtDensity: "dense",
  llm: WORKER,
  judge: JUDGE,
  toolNames: [],
  loopSimilarity: 0.62,
  loopWindow: 3,
  onLoop: "resample",
  resampleTemperature: 0.7,
  dedupeMs: 60_000,
  approvals: "destructive",
  contextMaxChars: 6_000,
  // Eight steps of ReAct is roughly where a transcript starts crowding out the
  // context block it shares a window with.
  foldAfterSteps: 8,
  foldKeepRecent: 3,
};

/** The fallback definition of done.
 *
 *  Its job is to make "this run has no acceptance criteria" structurally
 *  impossible. It is deliberately not a rubber stamp: the single criterion is
 *  owned by a person and stays pending until that person answers, so an
 *  open-ended run still ends with a named human deciding rather than with the
 *  harness congratulating itself. */
export const DOD_EXPLORATORY: DefinitionOfDone = {
  id: "exploratory",
  label: "Exploratory — a person decides",
  owner: "unassigned",
  passThreshold: 1,
  criteria: [
    {
      id: "human_ok",
      label: "Achieved the objective",
      expectation: "A named person read the answer and the trace, and says it did what was asked.",
      check: { kind: "human", question: "Did this achieve the objective?" },
      by: "human",
      weight: 1,
      required: true,
    },
  ],
};

/** Priors for the bidding auction.
 *
 *  Laplace smoothing is load-bearing rather than decorative: with raw counts a
 *  brand-new agent has confidence 0/0, scores zero, is never awarded a task,
 *  and so never earns the history that would let it score. A cold start has to
 *  be survivable or the auction only ever picks incumbents. */
export const BID_PRIORS: BidPriors = {
  priorRuns: 2,
  priorPasses: 1,
  defaultCostUsd: 0.05,
  defaultMs: 20_000,
};

/** Added to the denominator of confidence / cost.
 *
 *  Without it a free or near-free agent divides by ~0 and wins every auction
 *  on arithmetic alone, however unconfident it is. */
export const BID_COST_FLOOR = 0.01;

const history = () => ({ runs: 0, passes: 0, meanCostUsd: 0, meanMs: 0, bySkill: {} });

/** Starter agents. Distinct roles and distinct models, because a swarm whose
 *  members share weights and a brief produces correlated answers and the
 *  reconciliation pass then has nothing to reconcile. */
export const AGENT_SEED: AgentProfile[] = [
  {
    id: "researcher", name: "Researcher",
    role: "Finds and cites what the documents actually say. Never asserts a fact it did not read.",
    llm: { ...WORKER },
    skills: ["research", "retrieval", "summarise"],
    toolNames: ["search_docs", "read_doc", "lookup", "think"],
    history: history(), enabled: true,
  },
  {
    id: "analyst", name: "Analyst",
    role: "Computes figures with tools and shows the formula. Never states a number it did not calculate.",
    llm: { ...WORKER, model: "openai/gpt-5.2" },
    skills: ["analysis", "numbers", "kpi"],
    toolNames: ["kpi", "calc", "table_query", "date_math", "think"],
    history: history(), enabled: true,
  },
  {
    id: "auditor", name: "Auditor",
    role: "Checks a claim against policy and says which rule applies. Advises; never decides.",
    llm: { ...JUDGE },
    skills: ["policy", "compliance", "review"],
    toolNames: ["policy_check", "search_docs", "read_doc", "think"],
    history: history(), enabled: true,
  },
  {
    id: "writer", name: "Writer",
    role: "Turns findings into an artifact someone can act on, with its evidence attached.",
    llm: { ...WORKER, model: "google/gemini-3-pro" },
    skills: ["writing", "summarise", "artifact"],
    toolNames: ["write_artifact", "search_docs", "read_doc", "think"],
    history: history(), enabled: true,
  },
];

/** Overlay a patch onto a config.
 *
 *  `llm` and `judge` merge field-by-field so a caller can override one model
 *  without having to restate temperature and token budget. The judge is then
 *  forced away from the worker's model: a verifier running the producer's own
 *  weights agrees with it far more often than an independent one does, and
 *  that agreement looks exactly like success. */
export function mergeConfig(base: LoopConfig, patch: Partial<LoopConfig> = {}): LoopConfig {
  const merged: LoopConfig = {
    ...base,
    ...patch,
    llm: { ...base.llm, ...(patch.llm ?? {}), persona: false },
    judge: { ...base.judge, ...(patch.judge ?? {}), persona: false },
  };
  if (merged.judge.model === merged.llm.model) {
    const alt = JUDGE.model === merged.llm.model ? WORKER.model : JUDGE.model;
    merged.judge = { ...merged.judge, model: alt };
  }
  return merged;
}
