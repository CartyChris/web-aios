/* Self-improvement that cannot fake its own results.

   "Auditing Harness Tampering in Self-Improving Agents" (arXiv 2606.09498)
   defines tampering as edits that produce illusory gains or break integrity
   constraints. The defence is structural: the eval is frozen and sealed, a
   proposal may not touch the eval or the thing that grades it, and a proposal
   is accepted only on evidence it could not have tuned itself to.

   Pure: the caller runs the evals and passes in the numbers. */

import { fingerprint } from "../rewind";

export interface EvalScores {
  /** Pass per task id, on the split the proposal was tuned against. */
  heldIn: Record<string, boolean>;
  /** Pass per task id, on the split it never saw. */
  heldOut: Record<string, boolean>;
}

export interface Proposal {
  /** Files or config keys the proposal changes. */
  touches: string[];
  baseline: EvalScores;
  candidate: EvalScores;
}

/** The seal: a fingerprint of the eval tasks themselves. */
export function sealEval(tasks: unknown): string {
  return fingerprint({ tasks });
}

/** Anything that decides pass or fail is off limits to the thing being judged. */
export const PROTECTED = [/(^|\/)evals?(\.|\/|$)/i, /golden/i, /(^|\/)dod(\.|\/|$)/i, /judge/i, /verif/i, /(^|\/)tests?\//i, /frozen-eval/i];

const rate = (m: Record<string, boolean>) => {
  const v = Object.values(m);
  return v.length ? v.filter(Boolean).length / v.length : 0;
};

export function gateProposal(p: Proposal, seal: string, currentTasks: unknown): { accept: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (sealEval(currentTasks) !== seal) reasons.push("The eval set changed since it was sealed: results against it prove nothing.");
  const hits = p.touches.filter((t) => PROTECTED.some((re) => re.test(t)));
  if (hits.length) reasons.push(`The proposal touches what grades it: ${hits.join(", ")}.`);
  const inB = rate(p.baseline.heldIn), inC = rate(p.candidate.heldIn);
  const outB = rate(p.baseline.heldOut), outC = rate(p.candidate.heldOut);
  if (outC < outB) reasons.push(`Held-out pass rate fell (${(outB * 100).toFixed(0)}% to ${(outC * 100).toFixed(0)}%).`);
  if (outC <= outB && inC <= inB) reasons.push("No improvement on either split.");
  if (outC === outB && inC > inB) reasons.push("Only the tuned split improved: that is fitting, not improving. It must also help held-out tasks.");
  const regressed = [...Object.entries(p.baseline.heldIn), ...Object.entries(p.baseline.heldOut)]
    .filter(([id, passed]) => passed && (p.candidate.heldIn[id] === false || p.candidate.heldOut[id] === false))
    .map(([id]) => id);
  if (regressed.length) reasons.push(`It breaks tasks that passed before: ${regressed.join(", ")}.`);
  return { accept: reasons.length === 0, reasons };
}

/** A fixed held-out split: about a third of task ids, chosen by a hash of the
 *  id, so the split never depends on the order tasks were added or run. */
export function isHeldOut(taskId: string): boolean {
  return parseInt(fingerprint({ taskId }).slice(0, 6), 16) % 3 === 0;
}

export function scoresFrom(perTask: Record<string, boolean>): EvalScores {
  const out: EvalScores = { heldIn: {}, heldOut: {} };
  for (const [id, pass] of Object.entries(perTask)) (isHeldOut(id) ? out.heldOut : out.heldIn)[id] = pass;
  return out;
}
