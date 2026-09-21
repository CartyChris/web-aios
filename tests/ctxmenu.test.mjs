/* Context menu placement, assembly and keyboard rules.
 *
 * The placement tests care about one thing above all: a menu must never end up
 * under the pointer that opened it, because the button release would then
 * activate whatever is beneath.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeSections, placeMenu, placeSubmenu, focusableIndices, moveFocus,
  firstFocusable, lastFocusable, typeAhead, labelFor, isSeparator, isItem,
} from "../.test-build/ctxmenu.js";

const VP = { w: 1440, h: 900 };
const item = (id, extra = {}) => ({ id, label: id, ...extra });
const SEP = { separator: true };

/* ── assembling ──────────────────────────────────────────────────────────── */

test("sections are joined by exactly one separator", () => {
  const out = mergeSections([
    { id: "a", entries: [item("one")] },
    { id: "b", entries: [item("two")] },
  ]);
  assert.equal(out.length, 3);
  assert.ok(isSeparator(out[1]));
});

test("an empty section leaves no separator behind it", () => {
  // The normal case: "paste" contributes nothing when the clipboard is
  // unreadable, and must not leave a doubled rule on the menu.
  const out = mergeSections([
    { id: "a", entries: [item("one")] },
    { id: "empty", entries: [] },
    { id: "alsoEmpty", entries: [SEP] },
    { id: "b", entries: [item("two")] },
  ]);
  assert.deepEqual(out.map((e) => (isItem(e) ? e.id : "|")), ["one", "|", "two"]);
});

test("separators at the edges of a section are trimmed and runs collapse", () => {
  const out = mergeSections([{ id: "a", entries: [SEP, item("one"), SEP, SEP, item("two"), SEP] }]);
  assert.deepEqual(out.map((e) => (isItem(e) ? e.id : "|")), ["one", "|", "two"]);
});

test("a menu with no items at all is empty, not a pile of separators", () => {
  assert.deepEqual(mergeSections([{ id: "a", entries: [SEP] }, { id: "b", entries: [] }]), []);
});

/* ── placement ───────────────────────────────────────────────────────────── */

test("a menu with room opens down and to the right of the cursor", () => {
  const p = placeMenu(100, 100, 220, 300, VP);
  assert.deepEqual({ x: p.x, y: p.y, flipX: p.flipX, flipY: p.flipY }, { x: 100, y: 100, flipX: false, flipY: false });
});

test("near the right edge it FLIPS rather than clamping under the pointer", () => {
  // Clamping would put the menu's right edge at 1434 and its left edge at
  // 1214 — directly under a cursor at 1400, so the mouse-up that opened the
  // menu would activate an item. Flipping is the only correct answer.
  const p = placeMenu(1400, 100, 220, 300, VP);
  assert.equal(p.flipX, true);
  assert.equal(p.x, 1180, "1400 - 220");
  assert.ok(p.x + 220 <= 1400, "the whole menu must sit left of the cursor");
});

test("near the bottom edge it flips upward", () => {
  const p = placeMenu(100, 860, 220, 300, VP);
  assert.equal(p.flipY, true);
  assert.equal(p.y, 560);
  assert.ok(p.y + 300 <= 860);
});

test("a bottom-right corner click flips both ways", () => {
  const p = placeMenu(1430, 890, 220, 300, VP);
  assert.equal(p.flipX, true);
  assert.equal(p.flipY, true);
  assert.ok(p.x + 220 <= 1430 && p.y + 300 <= 890);
});

test("it never leaves the viewport, even when the menu is bigger than it", () => {
  for (const [ax, ay] of [[0, 0], [1440, 900], [700, 450], [-50, -50]]) {
    for (const [mw, mh] of [[220, 300], [2000, 2000], [220, 1200]]) {
      const p = placeMenu(ax, ay, mw, mh, { w: 400, h: 300 });
      assert.ok(p.x >= 6, `x ${p.x}`);
      assert.ok(p.y >= 6, `y ${p.y}`);
      assert.ok(Number.isFinite(p.maxHeight) && p.maxHeight > 0);
    }
  }
});

test("a menu taller than the viewport gets a scrollable max height, not a negative one", () => {
  const p = placeMenu(100, 100, 220, 4000, { w: 800, h: 400 });
  assert.ok(p.maxHeight > 0 && p.maxHeight <= 400);
});

/* ── submenus ────────────────────────────────────────────────────────────── */

test("a submenu opens to the right, overlapping its parent slightly", () => {
  // The overlap matters: a gap between parent and submenu lets the pointer
  // cross dead space on the diagonal and closes the submenu under it.
  const s = placeSubmenu(100, 220, 200, 200, 240, VP);
  assert.equal(s.side, "right");
  assert.equal(s.x, 316, "100 + 220 - 4 overlap");
  assert.equal(s.y, 200);
});

test("a submenu with no room on the right opens to the left", () => {
  const s = placeSubmenu(1150, 220, 200, 200, 240, VP);
  assert.equal(s.side, "left");
  assert.ok(s.x + 200 <= 1150 + 220, "it must sit over/left of the parent, not off-screen");
  assert.ok(s.x >= 6);
});

test("a submenu stays on screen vertically", () => {
  const s = placeSubmenu(100, 220, 880, 200, 240, VP);
  assert.ok(s.y + 240 <= VP.h);
  assert.ok(s.y >= 6);
});

/* ── keyboard ────────────────────────────────────────────────────────────── */

const MENU = [item("alpha"), SEP, item("beta"), item("gamma", { disabled: true }), item("delta")];

test("only real, enabled items can take focus", () => {
  assert.deepEqual(focusableIndices(MENU), [0, 2, 4]);
});

test("Down from nothing focuses the first item; Up from nothing focuses the last", () => {
  assert.equal(firstFocusable(MENU), 0);
  assert.equal(lastFocusable(MENU), 4);
});

test("focus skips separators and disabled items", () => {
  assert.equal(moveFocus(MENU, 0, 1), 2, "alpha -> beta, over the separator");
  assert.equal(moveFocus(MENU, 2, 1), 4, "beta -> delta, over disabled gamma");
});

test("focus wraps at both ends", () => {
  assert.equal(moveFocus(MENU, 4, 1), 0);
  assert.equal(moveFocus(MENU, 0, -1), 4);
});

test("a menu with nothing focusable returns -1 instead of looping forever", () => {
  assert.equal(moveFocus([SEP, item("x", { disabled: true })], -1, 1), -1);
  assert.equal(focusableIndices([SEP]).length, 0);
});

test("focus recovers when the focused item has become disabled", () => {
  // Index 3 (gamma) is disabled and cannot be current, but state can lag.
  assert.equal(moveFocus(MENU, 3, 1), 4);
  assert.equal(moveFocus(MENU, 3, -1), 2);
});

/* ── type-ahead ──────────────────────────────────────────────────────────── */

test("typing jumps to the next item starting with the buffer", () => {
  assert.equal(typeAhead(MENU, "d", 0), 4);
  assert.equal(typeAhead(MENU, "be", 0), 2);
});

test("type-ahead is case-insensitive", () => {
  assert.equal(typeAhead(MENU, "DEL", 0), 4);
});

test("repeating a letter cycles rather than sticking", () => {
  const m = [item("save"), item("save as"), item("send")];
  assert.equal(typeAhead(m, "s", 0), 1);
  assert.equal(typeAhead(m, "s", 1), 2);
  assert.equal(typeAhead(m, "s", 2), 0, "and wraps");
});

test("type-ahead skips disabled items and never matches a separator", () => {
  assert.equal(typeAhead(MENU, "g", 0), -1, "gamma is disabled");
});

test("an unmatched buffer leaves focus alone", () => {
  assert.equal(typeAhead(MENU, "zzz", 0), -1);
  assert.equal(typeAhead(MENU, "   ", 0), -1);
});

/* ── labels ──────────────────────────────────────────────────────────────── */

test("a long selection is shortened on a word boundary where possible", () => {
  assert.equal(labelFor("short"), "short");
  const long = labelFor("the quick brown fox jumps over the lazy dog", 24);
  assert.ok(long.endsWith("…"));
  assert.ok(long.length <= 25);
  assert.ok(!long.includes("  "));
});

test("a selection with newlines collapses to one line", () => {
  assert.equal(labelFor("a\n\n  b   c"), "a b c");
});

test("a single unbroken token is still cut to length", () => {
  const s = labelFor("x".repeat(100), 10);
  assert.ok(s.length <= 11, s);
  assert.ok(s.endsWith("…"));
});
