/* Compile and Encode: turn the actions available right now into typed
   questions, and the goal plus observation into one bounded state. Design
   after SystemOneHarness (Apache-2.0); no upstream code. */

import type { ActionSpec, Observation, Question, Questions } from "./types";

export const ACTION_Q = "action";
export const GOAL_Q = "goal_met";
/** Separator between an action and its parameter in a question name. */
export const SEP = "__";

export const paramQ = (action: string, param: string) => `${action}${SEP}${param}`;

/** The actions that can actually be taken now: listed as available, and every
 *  candidates-parameter has at least one candidate. */
export function availableActions(actions: ActionSpec[], obs: Observation): ActionSpec[] {
  return actions.filter((a) => {
    if (obs.available && !obs.available.includes(a.name)) return false;
    return (a.params ?? []).every((p) => p.kind !== "candidates" || Object.keys(obs.candidates?.[p.name] ?? {}).length > 0);
  });
}

/** One request answers the action, all of its parameters and the goal check. */
export function compileQuestions(actions: ActionSpec[], obs: Observation): Questions {
  const live = availableActions(actions, obs);
  const q: Questions = {};
  q[ACTION_Q] = {
    type: "choice",
    instructions: "Which single action best advances the goal from this state?",
    criteria: Object.fromEntries(live.map((a) => [a.name, `${a.description} (risk: ${a.risk})`])),
  };
  for (const a of live) {
    for (const p of a.params ?? []) {
      const name = paramQ(a.name, p.name);
      let question: Question;
      if (p.kind === "choices") question = { type: "choice", instructions: `If the action is ${a.name}: ${p.description}`, criteria: { ...p.choices } };
      else if (p.kind === "candidates") question = { type: "choice", instructions: `If the action is ${a.name}: ${p.description}`, criteria: { ...(obs.candidates?.[p.name] ?? {}) } };
      else if (p.kind === "flag") question = { type: "noul", instructions: `If the action is ${a.name}: ${p.description}` };
      else question = { type: "score", instructions: `If the action is ${a.name}: ${p.description}`, criteria: [...p.levels] };
      q[name] = question;
    }
  }
  q[GOAL_Q] = { type: "noul", instructions: "Has the goal already been fully achieved in the current state?" };
  return q;
}

export interface HistoryLine {
  n: number;
  action: string | null;
  verdict: string;
  result: string;
}

/** The state string sent to the decider. Bounded: only the last `window`
 *  history lines, and the whole thing clipped to `maxChars`. */
export function encodeState(o: { goal: string; obs: Observation; history: HistoryLine[]; memory?: string[]; window?: number; maxChars?: number }): string {
  const window = o.window ?? 6;
  const maxChars = o.maxChars ?? 24_000;
  const lines = [
    `GOAL: ${o.goal}`,
    `OBSERVATION: ${o.obs.text}`,
    o.obs.fields ? `FIELDS: ${JSON.stringify(o.obs.fields)}` : "",
    o.history.length
      ? `HISTORY (last ${Math.min(window, o.history.length)} of ${o.history.length}):\n${o.history.slice(-window).map((h) => `  ${h.n}. ${h.action ?? "(none)"} [${h.verdict}] ${h.result}`).join("\n")}`
      : "HISTORY: none yet",
    o.memory?.length ? `MEMORY:\n${o.memory.map((m) => `  - ${m}`).join("\n")}` : "",
  ].filter(Boolean);
  const s = lines.join("\n");
  return s.length > maxChars ? `${s.slice(0, maxChars - 12)}\n[clipped]` : s;
}

/** Jev's request body. The dev.to guide (valyuai, re-checked 2026-09-23)
 *  shows questions as `{ "type": "noul", "instructions": ... }`; an earlier
 *  summary described a nested `{ "noul": { "instructions": ... } }` form.
 *  Neither was verified against the live API from this session, so both
 *  are available and "typed" is the default. */
export type JevWire = "typed" | "nested";

export function toJevRequest(state: string, questions: Questions, wire: JevWire = "typed", model = "jev-latest") {
  const qs: Record<string, unknown> = {};
  for (const [name, q] of Object.entries(questions)) {
    const { type, ...rest } = q;
    qs[name] = wire === "typed" ? { type, ...rest } : { [type]: rest };
  }
  return { model, state, questions: qs };
}
