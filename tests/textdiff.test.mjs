/* Line diff.
 *
 * The property that makes a diff trustworthy is reconstruction: the "a" side
 * of the ops must rebuild the old text exactly and the "b" side the new one.
 * That is checked over hundreds of seeded random edits, not just the
 * hand-picked cases, because hand-picked cases are where diff bugs hide.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { diffLines, splitLines, sideBySide, collapse, rowIsSame, DEFAULT_MAX_EDITS } from "../.test-build/textdiff.js";

const rebuild = (ops, side) => ops.filter((o) => (side === "a" ? o.kind !== "add" : o.kind !== "del")).map((o) => o.text);

/* A tiny deterministic PRNG so the random cases are the same every run. */
const rng = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };

test("identical texts are all 'same'", () => {
  const r = diffLines("a\nb\nc", "a\nb\nc");
  assert.equal(r.added, 0);
  assert.equal(r.removed, 0);
  assert.ok(r.ops.every((o) => o.kind === "same"));
  assert.equal(r.truncated, false);
});

test("one changed line is one removal and one addition", () => {
  const r = diffLines("a\nb\nc", "a\nB\nc");
  assert.equal(r.removed, 1);
  assert.equal(r.added, 1);
  assert.deepEqual(r.ops.map((o) => `${o.kind}:${o.text}`), ["same:a", "del:b", "add:B", "same:c"]);
});

test("line numbers are 1-based and track each side separately", () => {
  const r = diffLines("a\nb\nc", "a\nx\ny\nc");
  const c = r.ops.find((o) => o.text === "c");
  assert.equal(c.a, 3);
  assert.equal(c.b, 4, "two lines were inserted before it on the new side");
  assert.equal(r.ops.find((o) => o.text === "x").b, 2);
  assert.equal(r.ops.find((o) => o.text === "x").a, undefined);
});

test("empty to text and text to empty", () => {
  assert.deepEqual(diffLines("", "a\nb").ops.map((o) => o.kind), ["add", "add"]);
  assert.deepEqual(diffLines("a\nb", "").ops.map((o) => o.kind), ["del", "del"]);
  assert.deepEqual(diffLines("", "").ops, []);
});

test("CRLF and LF line endings are the same line", () => {
  const r = diffLines("a\r\nb\r\n", "a\nb\n");
  assert.equal(r.added + r.removed, 0);
  assert.deepEqual(splitLines("x\ry"), ["x", "y"]);
});

test("the edit script is minimal on a classic case", () => {
  // ABCABBA -> CBABAC has a shortest edit script of 5 (Myers' own example).
  const a = "A B C A B B A".split(" ").join("\n");
  const b = "C B A B A C".split(" ").join("\n");
  const r = diffLines(a, b);
  assert.equal(r.added + r.removed, 5);
});

test("reconstruction holds for hundreds of random edits", () => {
  const next = rng(42);
  const words = ["alpha", "beta", "gamma", "delta", "eps", ""];
  for (let trial = 0; trial < 300; trial++) {
    const len = Math.floor(next() * 40);
    const a = Array.from({ length: len }, () => words[Math.floor(next() * words.length)]);
    const b = a.slice();
    const edits = Math.floor(next() * 8);
    for (let e = 0; e < edits; e++) {
      const at = Math.floor(next() * (b.length + 1));
      const op = next();
      if (op < 0.4 && b.length) b.splice(Math.min(at, b.length - 1), 1);
      else if (op < 0.7) b.splice(at, 0, words[Math.floor(next() * words.length)]);
      else if (b.length) b[Math.min(at, b.length - 1)] = `x${trial}`;
    }
    const oldText = a.join("\n"), newText = b.join("\n");
    const r = diffLines(oldText, newText);
    assert.deepEqual(rebuild(r.ops, "a"), splitLines(oldText), `trial ${trial}: old side`);
    assert.deepEqual(rebuild(r.ops, "b"), splitLines(newText), `trial ${trial}: new side`);
    assert.equal(r.truncated, false);
  }
});

test("a single edit deep in a large file is found without walking the whole file", () => {
  const a = Array.from({ length: 20000 }, (_, i) => `line ${i}`);
  const b = a.slice();
  b[12345] = "changed";
  const t0 = process.hrtime.bigint();
  const r = diffLines(a.join("\n"), b.join("\n"));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(r.added, 1);
  assert.equal(r.removed, 1);
  assert.equal(r.ops.find((o) => o.kind === "add").b, 12346);
  assert.ok(ms < 500, `took ${ms.toFixed(1)}ms`);
});

test("past the edit cap the result is still correct, and says it was truncated", () => {
  // Two texts sharing nothing need n+m edits. With a cap below that the middle
  // is replaced wholesale — still reconstructible, and honest about it.
  const a = Array.from({ length: 50 }, (_, i) => `a${i}`).join("\n");
  const b = Array.from({ length: 50 }, (_, i) => `b${i}`).join("\n");
  const r = diffLines(a, b, { maxEdits: 10 });
  assert.equal(r.truncated, true);
  assert.deepEqual(rebuild(r.ops, "a"), splitLines(a));
  assert.deepEqual(rebuild(r.ops, "b"), splitLines(b));
});

test("the default cap is large enough for ordinary edits", () => {
  assert.ok(DEFAULT_MAX_EDITS >= 1000);
  const a = Array.from({ length: 300 }, (_, i) => `l${i}`).join("\n");
  const b = Array.from({ length: 300 }, (_, i) => (i % 3 ? `l${i}` : `m${i}`)).join("\n");
  assert.equal(diffLines(a, b).truncated, false);
});

/* ── side by side ────────────────────────────────────────────────────────── */

test("a changed line pairs old with new on one row", () => {
  const rows = sideBySide(diffLines("a\nb\nc", "a\nB\nc").ops);
  assert.equal(rows.length, 3);
  assert.equal(rows[1].left.text, "b");
  assert.equal(rows[1].left.kind, "del");
  assert.equal(rows[1].right.text, "B");
  assert.equal(rows[1].right.kind, "add");
});

test("an uneven change leaves the short side empty rather than misaligning", () => {
  const rows = sideBySide(diffLines("a\nz", "a\nx\ny\nz").ops);
  const changed = rows.filter((r) => !rowIsSame(r));
  assert.equal(changed.length, 2);
  assert.equal(changed[0].left, undefined);
  assert.equal(changed[1].left, undefined);
  assert.deepEqual(changed.map((r) => r.right.text), ["x", "y"]);
});

test("every line appears on exactly one row of its side", () => {
  const rows = sideBySide(diffLines("1\n2\n3\n4\n5", "1\nx\n3\n5\n6").ops);
  const left = rows.filter((r) => r.left).map((r) => r.left.text);
  const right = rows.filter((r) => r.right).map((r) => r.right.text);
  assert.deepEqual(left, ["1", "2", "3", "4", "5"]);
  assert.deepEqual(right, ["1", "x", "3", "5", "6"]);
});

/* ── collapsing ──────────────────────────────────────────────────────────── */

test("long unchanged runs collapse to a skip, keeping context around changes", () => {
  const a = Array.from({ length: 30 }, (_, i) => `l${i}`);
  const b = a.slice(); b[15] = "changed";
  const out = collapse(sideBySide(diffLines(a.join("\n"), b.join("\n")).ops), rowIsSame, 3);
  const skips = out.filter((x) => x.kind === "skip");
  assert.equal(skips.length, 2, "one before and one after the hunk");
  assert.equal(skips[0].count, 12, "30 lines, change at 15, 3 of context: skip 0..11");
  assert.equal(out.filter((x) => x.kind === "row").length, 7, "3 + the change + 3");
});

test("an unchanged file collapses to a single skip", () => {
  const out = collapse(sideBySide(diffLines("a\nb", "a\nb").ops), rowIsSame, 3);
  assert.deepEqual(out, [{ kind: "skip", count: 2 }]);
});
