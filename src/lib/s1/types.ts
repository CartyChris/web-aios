/* ────────────────────────────────────────────────────────────────────────────
   System One harness: shared types.

   A port of the DESIGN of HarnessRouter's SystemOneHarness
   (https://github.com/HarnessRouter/SystemOneHarness, Apache-2.0). No code was
   copied from it; the loop shape (observe, compile, encode, decide, gate,
   execute), the four enumerable parameter kinds, the per-risk thresholds and
   the three-refusal escalation rule are its ideas, reimplemented here.

   A System One model (TypeSafe's Jev) does not write text. It answers a map of
   TYPED questions about a state in one pass, with a probability for every
   option. So an agent built on it can only ever pick among things the harness
   offered, and the harness can refuse to act when the weakest of those
   probabilities is too low. Everything in this folder is pure: no DOM, no
   clock, no randomness. The clock and the decider are injected.
   ──────────────────────────────────────────────────────────────────────────── */

/** How much damage an action can do, which sets how sure the model must be. */
export type Risk = "read" | "write" | "destructive" | "finish";

/** A parameter must be enumerable. Free text is refused at load time, because
 *  a System One model cannot produce it. */
export type ParamSpec =
  | { name: string; kind: "choices"; description: string; choices: Record<string, string> }
  | { name: string; kind: "candidates"; description: string }
  | { name: string; kind: "flag"; description: string }
  | { name: string; kind: "levels"; description: string; levels: string[] };

export interface ActionSpec {
  name: string;
  description: string;
  risk: Risk;
  params?: ParamSpec[];
}

export interface Observation {
  /** What the environment says about itself, in prose. */
  text: string;
  /** Structured facts, JSON-encoded into the state as-is. */
  fields?: Record<string, unknown>;
  /** Per candidates-parameter name: option id to a short description. */
  candidates?: Record<string, Record<string, string>>;
  /** Action names available right now. Omitted means all of them. */
  available?: string[];
}

export type Question =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export type Questions = Record<string, Question>;

export type Answer =
  | { type: "noul"; p: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence?: number; discarded: string[] }
  | { type: "score"; level: number; score: number; probabilities: number[]; confidence?: number };

export type Answers = Record<string, Answer>;

export type ParamValue = string | boolean | number;

export interface Decision {
  action: string | null;
  params: Record<string, ParamValue>;
  /** Every probability the chosen action depends on, question by question. */
  required: Array<{ question: string; p: number }>;
  weakest: { question: string; p: number };
  goalMet: number | null;
}

export type Verdict = "pass" | "refused" | "approved" | "denied";

export interface GateResult {
  pass: boolean;
  threshold: number;
  weakest: { question: string; p: number };
  reason: string;
}

export type DeciderKind = "jev" | "emulated" | "scripted";

export interface DeciderRequest {
  state: string;
  questions: Questions;
}

export interface DeciderResponse {
  /** The decider's reply exactly as received, before any filtering. */
  raw: unknown;
  costUsd?: number;
  /** True when costUsd is an estimate rather than a billed figure. */
  costEstimated?: boolean;
  model?: string;
}

export interface Decider {
  kind: DeciderKind;
  label: string;
  decide: (req: DeciderRequest) => Promise<DeciderResponse>;
}

export interface EnvResult {
  ok: boolean;
  text: string;
  terminal?: boolean;
  /** Only meaningful when terminal. */
  success?: boolean;
}

export interface Environment {
  id: string;
  name: string;
  actions: ActionSpec[];
  observe: () => Observation | Promise<Observation>;
  execute: (action: string, params: Record<string, ParamValue>) => EnvResult | Promise<EnvResult>;
}

export type RunStatus = "running" | "completed" | "incomplete" | "failed" | "cancelled";

export interface TraceStep {
  n: number;
  decider: DeciderKind;
  questions: Questions;
  answers: Answers;
  /** Options the decider named that the harness never offered, per question. */
  discarded: Record<string, string[]>;
  problems: string[];
  decision: Decision;
  gate: GateResult;
  verdict: Verdict;
  latencyMs: number;
  env: EnvResult | null;
  costUsd: number;
  cumulativeCostUsd: number;
  costEstimated: boolean;
}

export interface Handoff {
  state: string;
  questions: Questions;
  answers: Answers;
  decision: Decision;
  gate: GateResult;
  refusals: number;
}

export interface RunReport {
  status: Exclude<RunStatus, "running">;
  reason: string;
  steps: TraceStep[];
  handoff: Handoff | null;
  costUsd: number;
}
