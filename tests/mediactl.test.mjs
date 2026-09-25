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

import { shuffleNext, moveItem } from "../.test-build/mediactl.js";

test("shuffle is a bag: each track once, never the current one twice in a row", () => {
  const ids = ["a", "b", "c", "d"];
  let played = [], cur = "a", seen = new Set(["a"]);
  // r alternates 0 and 0.99: r=0 is exactly where a bag that forgot to exclude
  // the current track would pick it again (the first mutation this caught).
  for (let i = 0; i < 3; i++) {
    const n = shuffleNext(ids, played, cur, i % 2 ? 0.99 : 0, false);
    assert.notEqual(n.id, cur);
    assert.ok(!seen.has(n.id), `repeated ${n.id} before the bag emptied`);
    seen.add(n.id); played = n.played; cur = n.id;
  }
  assert.equal(seen.size, 4);
  assert.equal(shuffleNext(ids, played, cur, 0.5, false), null, "bag empty and repeat off: stop");
  const again = shuffleNext(ids, played, cur, 0, true);
  assert.notEqual(again.id, cur, "a new round does not start with the track that just ended");
});

test("shuffle with one track and repeat plays it again; moveItem clamps", () => {
  assert.equal(shuffleNext(["x"], ["x"], "x", 0.3, true).id, "x");
  assert.deepEqual(moveItem(["a", "b", "c"], 0, 1), ["b", "a", "c"]);
  assert.deepEqual(moveItem(["a", "b", "c"], 2, 5), ["a", "b", "c"].slice(0, 2).concat("c"));
  assert.deepEqual(moveItem(["a", "b", "c"], 2, -2), ["c", "a", "b"]);
});
