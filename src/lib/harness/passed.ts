/* Whether a harness run counts as done.

   The loop sets status "finished" when the MODEL emits finish[...], which is
   the model marking its own homework. The run's verdict is the harness's own
   judgement against the definition of done, written by code from criterion
   outcomes. Anything that reports success to the user (automation jobs, the
   harness router) must read this, not the status: a run can finish and still
   fail its definition of done, and that is exactly the case worth surfacing. */

export interface JudgeableRun {
  status: string;
  verdict: { pass: boolean; pendingHuman?: string[] } | null;
}

export function runPassed(r: JudgeableRun): { pass: boolean; why: string } {
  if (r.status !== "finished") return { pass: false, why: `stopped: ${r.status}` };
  if (!r.verdict) return { pass: false, why: "the model said finish, but no definition-of-done verdict was recorded" };
  if (r.verdict.pendingHuman && r.verdict.pendingHuman.length > 0) return { pass: false, why: `waiting on a human: ${r.verdict.pendingHuman.join(", ")}` };
  return r.verdict.pass ? { pass: true, why: "passed its definition of done" } : { pass: false, why: "finished, but failed its definition of done" };
}
