/* Parse, Decide, Gate. Design after SystemOneHarness (Apache-2.0).

   The invariant this file exists for: an option the harness did not offer is
   DISCARDED, never executed. A decider (especially an emulated one, which is
   a chat model pretending to be System One) can name an action that does not
   exist or a window that is not open; that name is dropped and recorded, and
   the remaining probabilities are NOT renormalised, so the discarded mass
   lowers confidence instead of vanishing. */

import { ACTION_Q, GOAL_Q, paramQ } from "./compile";
import type { ActionSpec, Answer, Answers, Decision, GateResult, ParamValue, Questions, Risk } from "./types";

/** SystemOneHarness README values. Its launch blog post quotes write 0.7 and
 *  destructive 0.9 instead; the README is used here and the sliders in the
 *  app let a user tighten them. */
export const DEFAULT_THRESHOLDS: Record<Risk, number> = { read: 0.5, write: 0.6, destructive: 0.8, finish: 0.5 };

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : typeof x === "string" && x.trim() !== "" && Number.isFinite(Number(x)) ? Number(x) : null);

/** Accept `{answers:{...}}` or the bare map. */
function answerMap(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.answers && typeof r.answers === "object") return r.answers as Record<string, unknown>;
  return r;
}

/** Probabilities written as percentages (a chat model's habit) become 0..1. */
function scaleIfPercent(values: number[]): number {
  const sum = values.reduce((a, b) => a + b, 0);
  return values.some((v) => v > 1) && sum > 1.5 ? 100 : 1;
}

export interface ParseResult {
  answers: Answers;
  discarded: Record<string, string[]>;
  problems: string[];
}

export function parseAnswers(raw: unknown, questions: Questions): ParseResult {
  const map = answerMap(raw);
  const answers: Answers = {};
  const discarded: Record<string, string[]> = {};
  const problems: string[] = [];
  if (!map) return { answers, discarded, problems: ["the decider returned no answer map"] };

  for (const [name, q] of Object.entries(questions)) {
    const a = map[name];
    if (a === undefined || a === null) { problems.push(`${name}: no answer`); continue; }
    const obj = (typeof a === "object" ? a : {}) as Record<string, unknown>;
    const confidence = num(obj.confidence) ?? undefined;

    if (q.type === "noul") {
      let p = num(typeof a === "object" ? (obj.noul ?? obj.p ?? obj.probability) : a);
      if (p === null) { problems.push(`${name}: noul answer is not a number`); continue; }
      if (p > 1 && p <= 100) p = p / 100;
      answers[name] = { type: "noul", p: clamp01(p) };
      continue;
    }

    if (q.type === "choice") {
      const offered = Object.keys(q.criteria);
      const rawProbs = (obj.probabilities && typeof obj.probabilities === "object" ? obj.probabilities : {}) as Record<string, unknown>;
      const entries = Object.entries(rawProbs).map(([k, v]) => [k, num(v)] as const).filter((e): e is readonly [string, number] => e[1] !== null);
      const scale = scaleIfPercent(entries.map((e) => e[1]));
      const probs: Record<string, number> = {};
      const dropped: string[] = [];
      for (const [k, v] of entries) {
        if (offered.includes(k)) probs[k] = clamp01(v / scale);
        else dropped.push(k);
      }
      const named = typeof obj.choice === "string" ? obj.choice : typeof a === "string" ? a : null;
      if (named && !offered.includes(named) && !dropped.includes(named)) dropped.push(named);
      // A named choice with no probabilities: trust it only as far as the
      // decider's own confidence, and never above 1.
      if (named && offered.includes(named) && probs[named] === undefined && entries.length === 0) probs[named] = clamp01(confidence ?? 0);
      if (dropped.length) discarded[name] = dropped;
      const best = Object.entries(probs).sort((x, y) => y[1] - x[1])[0];
      if (!best || best[1] <= 0) { problems.push(`${name}: no probability on any offered option`); continue; }
      answers[name] = { type: "choice", choice: best[0], probabilities: probs, confidence, discarded: dropped };
      continue;
    }

    // score
    const levels = q.criteria.length;
    const arr = Array.isArray(obj.probabilities) ? obj.probabilities.map(num) : [];
    let probabilities = arr.slice(0, levels).map((v) => (v === null ? 0 : v));
    const scale = scaleIfPercent(probabilities);
    probabilities = probabilities.map((v) => clamp01(v / scale));
    const score = num(obj.score);
    if (probabilities.length < levels) {
      if (score === null) { problems.push(`${name}: score answer has neither probabilities nor a score`); continue; }
      probabilities = Array.from({ length: levels }, (_, i) => (i === Math.round(Math.min(levels - 1, Math.max(0, score))) ? clamp01(confidence ?? 0) : 0));
    }
    let level = 0;
    probabilities.forEach((p, i) => { if (p > probabilities[level]) level = i; });
    const expected = probabilities.reduce((s, p, i) => s + p * i, 0);
    answers[name] = { type: "score", level, score: score ?? expected, probabilities, confidence };
  }
  return { answers, discarded, problems };
}

/** Turn answers into one concrete action plus every probability it rests on. */
export function decide(answers: Answers, actions: ActionSpec[]): Decision {
  const goal = answers[GOAL_Q];
  const goalMet = goal && goal.type === "noul" ? goal.p : null;
  const act = answers[ACTION_Q];
  if (!act || act.type !== "choice") {
    return { action: null, params: {}, required: [{ question: ACTION_Q, p: 0 }], weakest: { question: ACTION_Q, p: 0 }, goalMet };
  }
  const spec = actions.find((a) => a.name === act.choice);
  const required: Array<{ question: string; p: number }> = [{ question: ACTION_Q, p: act.probabilities[act.choice] ?? 0 }];
  const params: Record<string, ParamValue> = {};
  for (const p of spec?.params ?? []) {
    const name = paramQ(act.choice, p.name);
    const a: Answer | undefined = answers[name];
    if (!a) { required.push({ question: name, p: 0 }); continue; }
    if (a.type === "choice") { params[p.name] = a.choice; required.push({ question: name, p: a.probabilities[a.choice] ?? 0 }); }
    else if (a.type === "noul") { params[p.name] = a.p >= 0.5; required.push({ question: name, p: Math.max(a.p, 1 - a.p) }); }
    else { params[p.name] = p.kind === "levels" ? p.levels[a.level] : a.level; required.push({ question: name, p: a.probabilities[a.level] ?? 0 }); }
  }
  // Finishing is a claim that the goal is met, so that claim is gated too.
  if (spec?.risk === "finish") required.push({ question: GOAL_Q, p: goalMet ?? 0 });
  const weakest = required.reduce((w, r) => (r.p < w.p ? r : w), required[0]);
  return { action: spec ? act.choice : null, params, required, weakest, goalMet };
}

export function gate(decision: Decision, actions: ActionSpec[], thresholds: Record<Risk, number> = DEFAULT_THRESHOLDS): GateResult {
  const spec = actions.find((a) => a.name === decision.action);
  if (!spec) return { pass: false, threshold: 1, weakest: decision.weakest, reason: "no offered action was chosen" };
  const threshold = thresholds[spec.risk];
  const pass = decision.weakest.p >= threshold;
  return {
    pass,
    threshold,
    weakest: decision.weakest,
    reason: pass
      ? `${decision.weakest.question} at ${decision.weakest.p.toFixed(2)} clears the ${spec.risk} threshold ${threshold.toFixed(2)}`
      : `${decision.weakest.question} at ${decision.weakest.p.toFixed(2)} is below the ${spec.risk} threshold ${threshold.toFixed(2)}`,
  };
}
