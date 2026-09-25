/** Tamper-proof self-improvement: every way to fake a gain is refused. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sealEval, gateProposal } from "../.test-build/harness/frozen-eval.js";

const TASKS = [{ id: "a", q: "2+2" }, { id: "b", q: "capital of France" }];
const SEAL = sealEval(TASKS);
const base = { heldIn: { a: true, b: false }, heldOut: { c: true, d: false } };

test("a genuine improvement on held-out, touching only the harness, is accepted", () => {
  const r = gateProposal({ touches: ["src/lib/harness/loop.ts"], baseline: base, candidate: { heldIn: { a: true, b: true }, heldOut: { c: true, d: true } } }, SEAL, TASKS);
  assert.deepEqual(r, { accept: true, reasons: [] });
});

test("editing the eval, or the judge, is refused whatever the scores", () => {
  const better = { heldIn: { a: true, b: true }, heldOut: { c: true, d: true } };
  assert.equal(gateProposal({ touches: [], baseline: base, candidate: better }, SEAL, [...TASKS, { id: "easy", q: "1" }]).accept, false);
  assert.equal(gateProposal({ touches: ["src/lib/harness/dod.ts"], baseline: base, candidate: better }, SEAL, TASKS).accept, false);
  assert.equal(gateProposal({ touches: ["src/lib/harness/evals.ts"], baseline: base, candidate: better }, SEAL, TASKS).accept, false);
});

test("improving only the tuned split is fitting, not improving", () => {
  const r = gateProposal({ touches: ["x.ts"], baseline: base, candidate: { heldIn: { a: true, b: true }, heldOut: { c: true, d: false } } }, SEAL, TASKS);
  assert.equal(r.accept, false);
  assert.match(r.reasons.join(" "), /fitting/);
});

test("a higher total that breaks a task that passed before is refused", () => {
  const r = gateProposal({ touches: ["x.ts"], baseline: base, candidate: { heldIn: { a: false, b: true }, heldOut: { c: true, d: true } } }, SEAL, TASKS);
  assert.equal(r.accept, false);
  assert.match(r.reasons.join(" "), /breaks tasks that passed before: a/);
});

import { isHeldOut, scoresFrom } from "../.test-build/harness/frozen-eval.js";
test("the held-out split is stable and roughly a third", () => {
  const ids = Array.from({ length: 300 }, (_, i) => `task-${i}`);
  const out = ids.filter(isHeldOut).length;
  assert.ok(out > 60 && out < 140, `held-out was ${out} of 300`);
  assert.deepEqual(ids.filter(isHeldOut), ids.filter(isHeldOut));
  const s = scoresFrom({ "task-1": true, "task-2": false });
  assert.equal(Object.keys(s.heldIn).length + Object.keys(s.heldOut).length, 2);
});
