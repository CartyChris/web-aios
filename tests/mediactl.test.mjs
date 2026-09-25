import { test } from "node:test";
import assert from "node:assert/strict";
import { abNext, abCycle, resumeAt, keyAction, clampRate } from "../.test-build/mediactl.js";

test("A-B loop jumps back only when both ends are set and ordered", () => {
  assert.equal(abNext(12, { a: 5, b: 10 }), 5);
  assert.equal(abNext(7, { a: 5, b: 10 }), null);
  assert.equal(abNext(12, { a: 5, b: null }), null);
  assert.equal(abNext(12, { a: 10, b: 5 }), null);
  assert.equal(abNext(1, { a: 5, b: 10 }), 5);
});

test("A-B cycle: A, then B, then clear; a B before A restarts at A", () => {
  let l = abCycle(5, { a: null, b: null });
  assert.deepEqual(l, { a: 5, b: null });
  assert.deepEqual(abCycle(3, l), { a: 3, b: null });
  l = abCycle(9, l);
  assert.deepEqual(l, { a: 5, b: 9 });
  assert.deepEqual(abCycle(20, l), { a: null, b: null });
});

test("resume skips the first seconds and the last seconds", () => {
  assert.equal(resumeAt(3, 100), 0);
  assert.equal(resumeAt(95, 100), 0);
  assert.equal(resumeAt(42, 100), 42);
  assert.equal(resumeAt(undefined, 100), 0);
  assert.equal(resumeAt(42, NaN), 0);
});

test("keys and rate bounds", () => {
  assert.deepEqual(keyAction("ArrowRight", true), { kind: "seek", by: 30 });
  assert.equal(keyAction("x", false), null);
  assert.equal(clampRate(5), 3);
  assert.equal(clampRate(0.1), 0.25);
});
