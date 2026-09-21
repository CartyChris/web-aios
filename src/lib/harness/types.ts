/* ────────────────────────────────────────────────────────────────────────────
   Harness contracts.

   This file imports nothing, on purpose. Every other harness module imports
   it, so a dependency here would propagate into the test build and into the
   /api/harness/mcp route, which must run the same deterministic tool code the
   browser runs. Types only, plus the literal unions that are part of the wire
   shape.
   ──────────────────────────────────────────────────────────────────────────── */

export type Usd = number;
export type Millis = number;
export type Disposer = () => void;

/* ── Layer 6: traces ─────────────────────────────────────────────────────── */

/** Observatory's four kinds, unchanged. A harness span is a superset with
 *  optional fields only, so it stays a valid Observatory Span and the existing
 *  span-tree UI lights up with no edits to that app. */
export type SpanKind = "model" | "tool" | "app" | "system";

export type SpanRole =
  | "run" | "step" | "llm" | "llm_repair" | "tool"
  | "judge" | "bid" | "trigger" | "eval" | "context";

export interface Span {
  id: string;
  parentId: string | null;
  name: string;
  kind: SpanKind;
  startedAt: number;
  endedAt?: number;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: Usd;
  /** Output. Truncated to TRACE_LIMITS.text at write time. */
  text?: string;
  error?: string;

  /* Harness additions — all optional. */
  role?: SpanRole;
  runId?: string;
  stepIndex?: number;
  /** Input as actually sent. Truncated to TRACE_LIMITS.input at write time. */
  input?: string;
  attrs?: Record<string, string | number | boolean | null>;
}

export type SpanSink = (span: Span) => void;

export interface TraceFlag {
  code:
    | "circular" | "empty_step" | "all_tool_no_answer" | "error_cascade"
    | "runaway_depth" | "cost_spike" | "stalled" | "context_drop";
  severity: "info" | "warn" | "error";
  label: string;
  /** Names the evidence, not just the verdict. */
  detail: string;
  spanIds: string[];
}

/* ── Layer 1: triggers ───────────────────────────────────────────────────── */

export type TriggerKind = "manual" | "event" | "schedule" | "file" | "eval";

export interface TriggerSpec {
  id: string;
  kind: TriggerKind;
  /** event: a bus event name. schedule: "every:15m" or "at:09:30".
   *  file: a VFS path prefix. manual/eval: "". */
  match: string;
  enabled: boolean;
  configId: string;
  dodId: string;
  /** "{{payload}}", "{{payload.path}}", "{{now}}" are substituted. */
  objectiveTemplate: string;
  /** A trigger that has never fired is a bug you cannot otherwise see. */
  firedCount: number;
  lastFiredAt?: number;
  createdAt: number;
}

export interface TriggerEvent {
  triggerId: string;
  kind: TriggerKind;
  at: number;
  payload: unknown;
  /** Stable over identical payloads; the harness refuses a repeat inside
   *  LoopConfig.dedupeMs. */
  dedupeKey: string;
}

/* ── Layer 3: tools ──────────────────────────────────────────────────────── */

export interface JsonSchemaProp {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  description: string;
  enum?: string[];
  items?: { type: "string" | "number" | "integer" | "boolean" };
  default?: string | number | boolean;
}

export interface JsonSchema {
  type: "object";
  properties: Record<string, JsonSchemaProp>;
  required?: string[];
}

export interface ToolAnnotations {
  readOnly: boolean;
  destructive: boolean;
  /** Reaches something outside the fixtures: network, MCP, the user's files. */
  openWorld: boolean;
  /** A named person must approve before it runs. */
  requiresApproval: boolean;
}

export type ToolResultStatus = "ok" | "error" | "denied" | "timeout" | "invalid_args";

export interface ToolResult<R = unknown> {
  status: ToolResultStatus;
  /** What the model sees next turn. NEVER empty — an empty observation
   *  teaches the model nothing and it will repeat the same action. */
  observation: string;
  /** Machine value, used by DoD criteria and eval assertions. */
  value?: R;
  /** Present when status !== "ok". Names the constraint AND the way forward. */
  error?: string;
  ms: Millis;
  /** True when answered from the per-run (name,args) cache. */
  cached?: boolean;
}

export interface ToolContext {
  runId: string;
  stepIndex: number;
  signal: AbortSignal;
  facts: FactStore;
  span: SpanSink;
  parentSpanId: string;
  /** Injected so a replay reproduces a date-dependent trace byte for byte. */
  now: () => number;
  /** Per-run memo of (name + canonical args) -> ToolResult. */
  cache: Map<string, ToolResult>;
}

/** Deliberately NOT generic. Under strictFunctionTypes a generic `run`
 *  property makes concrete tools unassignable to ToolDef, and the registry
 *  gains nothing from the type parameter: args arrive from a parsed string and
 *  must be validated at runtime regardless. */
export interface ToolDef {
  /** ^[a-z][a-z0-9_]{1,39}$ — matched by the action parser. */
  name: string;
  title: string;
  /** One sentence. Goes verbatim into the system prompt. */
  description: string;
  inputSchema: JsonSchema;
  /** Same args + same fixtures => byte-identical observation, always. */
  deterministic: boolean;
  annotations: ToolAnnotations;
  timeoutMs: Millis;
  /** One worked call, e.g. `kpi[{"metric":"arr","period":"2026Q1"}]`. */
  example: string;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

export interface ToolRegistry {
  /** Returns the function that removes it. A tool you cannot remove
   *  completely is worse than one you never added: the model keeps its
   *  description, calls it, gets silence, and reasons from the silence. */
  register: (tool: ToolDef) => Disposer;
  get: (name: string) => ToolDef | undefined;
  list: () => ToolDef[];
  /** Registry snapshot used in the eval fingerprint. */
  signature: () => string;
}

export interface ToolCallRecord {
  spanId: string;
  tool: string;
  args: Record<string, unknown>;
  result: ToolResult;
  ms: Millis;
}

/* ── Layer 2: the loop ───────────────────────────────────────────────────── */

export interface LlmConfig {
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
  /** Always false in the harness. The OS persona ("be terse and deadpan")
   *  leaking into a verifier is a silent correctness bug. */
  persona: false;
}

export interface LoopConfig {
  id: string;
  name: string;
  /** Hard cap on Thought/Action/Observation steps. */
  maxSteps: number;
  /** Consecutive tool errors before the run is abandoned. */
  maxToolErrors: number;
  /** Extra action-only LLM calls allowed per run when the split fails. */
  maxRepairsPerRun: number;
  stepTimeoutMs: Millis;
  runTimeoutMs: Millis;
  maxCostUsd: Usd;
  /** "dense" = a thought before every action (QA-shaped work).
   *  "sparse" = the model decides (long action horizons). */
  thoughtDensity: "dense" | "sparse";
  llm: LlmConfig;
  /** Must differ from llm.model where the provider offers an alternative. */
  judge: LlmConfig;
  /** Allowlist. Empty array means every registered tool. */
  toolNames: string[];
  /** Jaccard over 5-shingles, above which two steps count as the same. */
  loopSimilarity: number;
  /** How many prior steps the detector compares against. */
  loopWindow: number;
  onLoop: "abort" | "resample";
  resampleTemperature: number;
  dedupeMs: Millis;
  approvals: "never" | "destructive" | "always";
  /** Character budget for the trusted-context block. */
  contextMaxChars: number;
  /** Fold the transcript once a run passes this many steps. 0 disables it.
   *  Only the PROMPT is folded; run.transcript stays complete, because it is
   *  the receipt. */
  foldAfterSteps: number;
  /** Steps kept verbatim at the tail when folding. */
  foldKeepRecent: number;
}

export interface Action {
  /** Tool name, or "think" / "finish". */
  verb: string;
  /** Exactly what the model emitted after "Action {i}: ". */
  raw: string;
  args: Record<string, unknown>;
}

export type StepOutcome =
  | "acted" | "thought" | "finished"
  | "parse_error" | "invalid_action" | "tool_error"
  | "denied" | "aborted";

export interface LlmCallRecord {
  spanId: string;
  provider: string;
  model: string;
  system: string;
  /** The user message as sent, after context truncation. */
  prompt: string;
  stop: string[];
  temperature: number;
  maxTokens: number;
  output: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: Usd;
  ms: Millis;
  error?: string;
  /** 1 on the first attempt. Retries share the step, not the index. */
  attempt: number;
}

export interface Step {
  /** 1-based. This number appears in "Thought {i}:" and in the stop sequence. */
  index: number;
  thought: string;
  action: Action | null;
  /** Why `action` is null. */
  parseError?: string;
  observation: string;
  outcome: StepOutcome;
  llm: LlmCallRecord;
  /** The action-only second call. Counted separately, because it is a real
   *  extra spend and a harness that hides it under-reports its own cost. */
  repair?: LlmCallRecord;
  tool?: ToolCallRecord;
  startedAt: number;
  ms: Millis;
  costUsd: Usd;
}

export type RunStatus =
  | "running" | "finished" | "cap_exhausted" | "budget_stopped"
  | "tool_error_cascade" | "loop_detected" | "timeout"
  | "aborted" | "failed" | "awaiting_approval";

export interface RunFlag {
  code:
    | "loop_detected" | "cap_exhausted" | "budget_stopped" | "parse_repair"
    | "invalid_action" | "tool_error" | "empty_step" | "approval_required"
    | "context_truncated" | "dedupe_skipped" | "resampled";
  severity: "info" | "warn" | "error";
  stepIndex: number;
  detail: string;
}

export interface RunTotals {
  steps: number;
  llmCalls: number;
  repairCalls: number;
  toolCalls: number;
  toolErrors: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: Usd;
  ms: Millis;
}

export interface RunResult {
  runId: string;
  configId: string;
  agentId: string | null;
  objective: string;
  trigger: TriggerEvent;
  status: RunStatus;
  /** "" when the run never produced one. Never a fabricated placeholder. */
  answer: string;
  steps: Step[];
  /** The full ReAct text, exactly as the model last saw it. */
  transcript: string;
  spans: Span[];
  verdict: DodVerdict | null;
  flags: RunFlag[];
  totals: RunTotals;
  startedAt: number;
  endedAt: number;
  /** Fingerprint of prompt + tools + fixtures at run time. */
  fingerprint: string;
}

/* ── Layer 4: trusted context ────────────────────────────────────────────── */

export interface Fact {
  id: string;
  /** Human-readable origin: a VFS path, a URL, a tool name, a person. */
  source: string;
  sourceKind: "vfs" | "tool" | "human" | "config" | "run";
  text: string;
  /** Higher survives when the budget forces a cut. */
  weight: number;
  updatedAt: number;
  /** Volatile facts are appended after the cache prefix, never inserted into
   *  it. A prefix cache is an all-or-nothing match. */
  volatile: boolean;
  tags: string[];
}

export interface FactStore {
  all: () => Fact[];
  byId: (id: string) => Fact | undefined;
  /** Lexical, deterministic, no model call. */
  search: (q: string, limit: number) => Fact[];
}

export interface ContextBlock {
  stable: string;
  volatile: string;
  includedIds: string[];
  /** Everything dropped, with the reason. "Why did the agent not see the
   *  thing I gave it" is the question that destroys trust in a memory. */
  withheld: Array<{ id: string; reason: string; chars: number }>;
  chars: number;
}

/* ── Layer 5: definition of done ─────────────────────────────────────────── */

export type CriterionCheck =
  | { kind: "contains"; value: string; caseSensitive?: boolean }
  | { kind: "not_contains"; value: string; caseSensitive?: boolean }
  | { kind: "regex"; pattern: string; flags?: string }
  | { kind: "number_within"; expected: number; tolerance: number }
  | { kind: "tool_called"; tool: string; times?: number }
  | { kind: "tool_not_called"; tool: string }
  | { kind: "tool_value_equals"; tool: string; path: string; equals: string | number | boolean }
  | { kind: "artifact_exists"; path: string }
  | { kind: "max_steps"; value: number }
  | { kind: "max_cost_usd"; value: number }
  | { kind: "no_flag"; code: RunFlag["code"] }
  | { kind: "stable_across_repeats"; field: "answer" | "tool_sequence" }
  | { kind: "judge"; question: string }
  | { kind: "human"; question: string };

export interface Criterion {
  id: string;
  label: string;
  /** What a person would observe. A criterion with no expectation is a wish. */
  expectation: string;
  check: CriterionCheck;
  /** "fixed" runs code. "model" asks the judge. "human" waits for a person. */
  by: "fixed" | "model" | "human";
  /** >= 0. Weight 0 means advisory: recorded, never blocking. */
  weight: number;
  /** A failed required criterion fails the whole DoD regardless of score. */
  required: boolean;
}

export interface DefinitionOfDone {
  id: string;
  label: string;
  /** MUST contain at least one required criterion — see dodValidate. */
  criteria: Criterion[];
  /** Weighted fraction needed once every required criterion passed. 0..1. */
  passThreshold: number;
  /** A named person. A DoD nobody owns is nobody's job. */
  owner: string;
}

export interface CriterionOutcome {
  criterionId: string;
  /** null = awaiting a human. */
  met: boolean | null;
  /** What was actually seen, quoted. */
  observed: string;
  by: "fixed" | "model" | "human";
  ms: Millis;
}

export interface DodVerdict {
  dodId: string;
  pass: boolean;
  /** Weighted, 0..1. */
  score: number;
  outcomes: CriterionOutcome[];
  /** The named person, when a human criterion decided it. */
  decidedBy: string | null;
  decidedAt: number;
  /** Written from the outcomes by code. Never authored by a model. */
  reason: string;
  pendingHuman: string[];
}

/* ── Layer 5: bidding ────────────────────────────────────────────────────── */

export interface AgentHistory {
  runs: number;
  passes: number;
  /** Mean USD over every run, pass or fail. Failed rounds are part of the
   *  price; excluding them makes an agent look cheaper than it is. */
  meanCostUsd: Usd;
  meanMs: Millis;
  /** Per-skill, so confidence is not one global number. */
  bySkill: Record<string, { runs: number; passes: number }>;
}

export interface AgentProfile {
  id: string;
  name: string;
  /** Free-text brief. */
  role: string;
  llm: LlmConfig;
  skills: string[];
  toolNames: string[];
  history: AgentHistory;
  enabled: boolean;
}

export interface BidRequest {
  taskId: string;
  objective: string;
  /** Skills the task needs. An agent missing one abstains. */
  requires: string[];
  dodId: string;
  maxCostUsd: Usd;
  deadlineMs: Millis;
}

export interface BidPriors {
  /** Laplace smoothing, so a cold-start agent is not confidence 0 and
   *  therefore never awarded anything. */
  priorRuns: number;
  priorPasses: number;
  defaultCostUsd: Usd;
  defaultMs: Millis;
}

export interface Bid {
  agentId: string;
  taskId: string;
  /** Predicted USD for one full run, from history. Never asked of a model. */
  estCostUsd: Usd;
  estMs: Millis;
  /** 0..1, Laplace-smoothed pass rate over the intersecting skills. */
  confidence: number;
  /** confidence / (estCostUsd + BID_COST_FLOOR). Higher wins. */
  score: number;
  /** Names the evidence: "7/9 on skill:sql, mean $0.012 over 9 runs". */
  rationale: string;
  /** Set when the agent cannot bid. Kept, not dropped — an auction where
   *  everyone abstained must say why. */
  abstainReason?: string;
}

export interface Award {
  taskId: string;
  winner: Bid | null;
  runnersUp: Bid[];
  abstained: Bid[];
  reason: string;
}

/* ── Evals ───────────────────────────────────────────────────────────────── */

export type EvalCategory =
  | "fixed_logic" | "retrieval" | "multi_hop" | "arithmetic"
  | "tool_error_recovery" | "refusal" | "determinism"
  | "long_horizon" | "cost" | "regression";

export interface EvalTask {
  id: string;
  title: string;
  category: EvalCategory;
  objective: string;
  /** Fixture overlay keyed by fixture table name. Merged over fixtures.ts. */
  fixtures: Record<string, unknown>;
  dod: DefinitionOfDone;
  /** MANDATORY negative control. An objective this DoD must NOT pass.
   *  Without it a suite degrades into "the guard still fires", which a guard
   *  that fires on everything also satisfies. */
  anti: { objective: string; reason: string };
  configPatch?: Partial<LoopConfig>;
  /** Times to run for a "stable_across_repeats" criterion. Default 1. */
  repeat?: number;
  origin: "seed" | "production_failure";
  sourceRunId?: string;
  createdAt: number;
  tags: string[];
  /** Fixed clock, so a date-dependent task is reproducible forever. */
  clockAt: number;
}

export interface EvalResult {
  taskId: string;
  runId: string;
  pass: boolean;
  /** The anti-run's verdict. A task where the anti ALSO passed proves
   *  nothing about the DoD and does not count toward green. */
  antiPass: boolean;
  discriminates: boolean;
  verdict: DodVerdict;
  antiVerdict: DodVerdict;
  totals: RunTotals;
  antiTotals: RunTotals;
  /** Tool name sequence of the main run, for the determinism check. */
  toolSequence: string[];
  startedAt: number;
  ms: Millis;
  error?: string;
}

export interface EvalDelta {
  taskId: string;
  kind: "regressed" | "fixed" | "cost_up" | "cost_down" | "steps_up" | "unchanged";
  detail: string;
}

export interface EvalBaseline {
  fingerprint: string;
  at: number;
  perTask: Record<string, { pass: boolean; costUsd: Usd; steps: number; ms: Millis }>;
}

export interface EvalSuiteResult {
  suiteId: string;
  startedAt: number;
  ms: Millis;
  results: EvalResult[];
  passed: number;
  failed: number;
  /** Passed, but its anti passed too. Counted as NOT green. */
  nonDiscriminating: number;
  /** Tasks refused at registration, e.g. no anti, or a vacuous DoD. Loud. */
  rejected: Array<{ taskId: string; reason: string }>;
  green: boolean;
  totals: RunTotals;
  fingerprint: string;
  /** True when the surface changed since the baseline was taken, so an old
   *  green cannot be trusted. */
  stale: boolean;
  baseline: EvalBaseline | null;
  deltas: EvalDelta[];
}

/** A person's account of what went wrong, which becomes a regression test. */
export interface Correction {
  runId: string;
  /** Which step was the first wrong one. The trace is the receipt; this is
   *  the line of it someone pointed at. */
  wrongStepIndex: number;
  whatWasWrong: string;
  expected: string;
  correctedBy: string;
  at: number;
}
