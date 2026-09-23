/* The run-state machine: Observe, Compile, Encode, Decide, Gate, Execute.
   Design after SystemOneHarness (Apache-2.0); no upstream code.

   Termination rules:
   - the environment reports a terminal state: completed on success, failed otherwise
   - three CONSECUTIVE gate refusals: the run is handed to a human with the
     full state, questions and probabilities. Approve executes the proposed
     action anyway; Deny (or no human attached) ends the run incomplete with
     reason "no_confident_action"
   - maxSteps without a terminal state: incomplete, "max_steps"
   - the decider or the environment throws: failed
   - the abort signal fires: cancelled */

import { compileQuestions, encodeState, type HistoryLine } from "./compile";
import { DEFAULT_THRESHOLDS, decide, gate, parseAnswers } from "./parse";
import type { Decider, Environment, Handoff, Risk, RunReport, TraceStep } from "./types";

export const MAX_REFUSALS = 3;

export interface RunOptions {
  goal: string;
  env: Environment;
  decider: Decider;
  thresholds?: Record<Risk, number>;
  maxSteps?: number;
  historyWindow?: number;
  memory?: string[];
  /** Injected so this stays pure and testable. */
  now: () => number;
  signal?: AbortSignal;
  /** Asked after the third consecutive refusal. Omit to end the run there. */
  escalate?: (h: Handoff) => Promise<"approve" | "deny">;
  onStep?: (s: TraceStep) => void;
}

export async function runSystemOne(o: RunOptions): Promise<RunReport> {
  const thresholds = o.thresholds ?? DEFAULT_THRESHOLDS;
  const maxSteps = o.maxSteps ?? 12;
  const steps: TraceStep[] = [];
  const history: HistoryLine[] = [];
  let refusals = 0;
  let cost = 0;
  const end = (status: RunReport["status"], reason: string, handoff: Handoff | null = null): RunReport => ({ status, reason, steps, handoff, costUsd: cost });

  for (let n = 1; n <= maxSteps; n++) {
    if (o.signal?.aborted) return end("cancelled", "cancelled by the user");
    let obs;
    try { obs = await o.env.observe(); } catch (e) { return end("failed", `observe failed: ${msg(e)}`); }
    const questions = compileQuestions(o.env.actions, obs);
    const state = encodeState({ goal: o.goal, obs, history, memory: o.memory, window: o.historyWindow });

    const t0 = o.now();
    let res;
    try { res = await o.decider.decide({ state, questions }); } catch (e) {
      if (o.signal?.aborted) return end("cancelled", "cancelled by the user");
      return end("failed", `decider error: ${msg(e)}`);
    }
    const latencyMs = Math.max(0, o.now() - t0);
    cost += res.costUsd ?? 0;

    const parsed = parseAnswers(res.raw, questions);
    const decision = decide(parsed.answers, o.env.actions);
    const g = gate(decision, o.env.actions, thresholds);
    const step: TraceStep = {
      n, decider: o.decider.kind, questions, answers: parsed.answers, discarded: parsed.discarded, problems: parsed.problems,
      decision, gate: g, verdict: g.pass ? "pass" : "refused", latencyMs, env: null,
      costUsd: res.costUsd ?? 0, cumulativeCostUsd: cost, costEstimated: !!res.costEstimated,
    };

    let execute = g.pass;
    if (g.pass) refusals = 0;
    else {
      refusals++;
      if (refusals >= MAX_REFUSALS) {
        const handoff: Handoff = { state, questions, answers: parsed.answers, decision, gate: g, refusals };
        const human = o.escalate && decision.action ? await o.escalate(handoff) : "deny";
        if (o.signal?.aborted) { steps.push(step); o.onStep?.(step); return end("cancelled", "cancelled by the user"); }
        if (human === "approve") { step.verdict = "approved"; execute = true; refusals = 0; }
        else {
          step.verdict = "denied";
          steps.push(step); o.onStep?.(step);
          return end("incomplete", "no_confident_action", handoff);
        }
      }
    }

    if (execute && decision.action) {
      try { step.env = await o.env.execute(decision.action, decision.params); } catch (e) {
        steps.push(step); o.onStep?.(step);
        return end("failed", `execute failed: ${msg(e)}`);
      }
    }
    steps.push(step);
    o.onStep?.(step);
    history.push({ n, action: decision.action, verdict: step.verdict, result: step.env ? step.env.text : g.reason });
    if (step.env?.terminal) return step.env.success ? end("completed", step.env.text) : end("failed", step.env.text);
  }
  return end("incomplete", "max_steps");
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
