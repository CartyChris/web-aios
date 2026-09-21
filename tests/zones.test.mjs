/* Tiling geometry.
 *
 * The properties matter more than any individual rectangle, so most of these
 * are checked across many counts and many awkward areas — especially areas
 * whose width does not divide, which is where seam bugs live.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { tile, edges, zoneAt, zoneRect, gridCols, LAYOUTS, isLayout } from "../.test-build/zones.js";

const AREA = { x: 0, y: 40, w: 1440, h: 860 };
/* Deliberately horrible: prime-ish width and height, non-zero origin. */
const ODD = { x: 7, y: 41, w: 1001, h: 683 };
const TILERS = ["cols", "rows", "grid", "main-left", "main-right"];

const overlaps = (a, b) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/* ── edges: the identity the whole module rests on ───────────────────────── */

test("edges start exactly at the origin and end exactly at the far side", () => {
  for (const span of [1000, 1001, 999, 7, 1, 1440]) {
    for (let n = 1; n <= 12; n++) {
      const e = edges(13, span, n);
      assert.equal(e.length, n + 1);
      assert.equal(e[0], 13, `n=${n} span=${span}`);
      assert.equal(e[n], 13 + span, `n=${n} span=${span} must land exactly`);
    }
  }
});

test("edges never go backwards, so no slot has negative width", () => {
  for (let n = 1; n <= 20; n++) {
    const e = edges(0, 37, n);
    for (let i = 1; i < e.length; i++) assert.ok(e[i] >= e[i - 1], `n=${n} i=${i}`);
  }
});

test("adjacent slots share an edge exactly — this is the seam", () => {
  // Computed from widths instead of edges, 3 columns of 1000 leave a pixel of
  // wallpaper down the right-hand side. That is the bug this prevents.
  const e = edges(0, 1000, 3);
  assert.deepEqual(e, [0, 333, 667, 1000]);
  const widths = [e[1] - e[0], e[2] - e[1], e[3] - e[2]];
  assert.equal(widths.reduce((a, b) => a + b, 0), 1000);
});

/* ── every tiling layout, across counts and areas ────────────────────────── */

test("a tiling layout returns exactly one rect per window", () => {
  for (const l of LAYOUTS.map((x) => x.id)) {
    for (const n of [1, 2, 3, 5, 8, 13]) {
      assert.equal(tile(l, n, AREA).length, n, `${l} n=${n}`);
    }
  }
});

test("no rect ever escapes the work area", () => {
  for (const l of LAYOUTS.map((x) => x.id)) {
    for (const area of [AREA, ODD]) {
      for (let n = 1; n <= 10; n++) {
        for (const r of tile(l, n, area)) {
          assert.ok(r.x >= area.x, `${l} n=${n} left`);
          assert.ok(r.y >= area.y, `${l} n=${n} top`);
          assert.ok(r.x + r.w <= area.x + area.w, `${l} n=${n} right: ${r.x + r.w} > ${area.x + area.w}`);
          assert.ok(r.y + r.h <= area.y + area.h, `${l} n=${n} bottom`);
        }
      }
    }
  }
});

test("no rect is ever degenerate", () => {
  for (const l of LAYOUTS.map((x) => x.id)) {
    for (let n = 1; n <= 10; n++) {
      for (const r of tile(l, n, ODD, { gap: 6 })) {
        assert.ok(r.w >= 1 && r.h >= 1, `${l} n=${n} -> ${JSON.stringify(r)}`);
      }
    }
  }
});

test("tiling layouts do not overlap, at any count that actually fits", () => {
  for (const l of TILERS) {
    for (const area of [AREA, ODD]) {
      // Keep counts inside what the area can host; beyond that the surplus
      // deliberately shares the last slot, which is tested separately.
      for (let n = 2; n <= 4; n++) {
        const rects = tile(l, n, area, { gap: 4 });
        for (let i = 0; i < rects.length; i++) {
          for (let j = i + 1; j < rects.length; j++) {
            assert.ok(!overlaps(rects[i], rects[j]), `${l} n=${n}: ${i} overlaps ${j}`);
          }
        }
      }
    }
  }
});

test("with no gap, columns cover the area exactly — no seam, no overlap", () => {
  const rects = tile("cols", 3, ODD, { gap: 0 });
  assert.equal(rects[0].x, ODD.x);
  for (let i = 1; i < rects.length; i++) {
    assert.equal(rects[i].x, rects[i - 1].x + rects[i - 1].w, `slot ${i} must start where ${i - 1} ends`);
  }
  const last = rects[rects.length - 1];
  assert.equal(last.x + last.w, ODD.x + ODD.w, "the last column must reach the far edge exactly");
  assert.equal(rects.reduce((a, r) => a + r.w, 0), ODD.w, "widths must sum to the full span");
});

test("rows cover the area exactly too", () => {
  const rects = tile("rows", 4, ODD, { gap: 0 });
  assert.equal(rects.reduce((a, r) => a + r.h, 0), ODD.h);
  assert.equal(rects[3].y + rects[3].h, ODD.y + ODD.h);
});

test("the gap is taken from inside the slot, so coverage still holds", () => {
  const gap = 10;
  const rects = tile("cols", 3, AREA, { gap });
  // Each tile is inset by the gap on both sides, so consecutive tiles sit
  // exactly 2*gap apart and the outer edges are gap from the border.
  assert.equal(rects[0].x, AREA.x + gap);
  assert.equal(rects[1].x - (rects[0].x + rects[0].w), gap * 2);
  const last = rects[2];
  assert.equal(last.x + last.w, AREA.x + AREA.w - gap);
});

/* ── one window ──────────────────────────────────────────────────────────── */

test("one window fills the area under every tiling layout", () => {
  for (const l of TILERS) {
    const [r] = tile(l, 1, AREA, { gap: 0 });
    assert.deepEqual({ x: r.x, y: r.y, w: r.w, h: r.h }, AREA, l);
  }
});

/* ── grid shape ──────────────────────────────────────────────────────────── */

test("a grid is as square as the count allows", () => {
  assert.equal(gridCols(1), 1);
  assert.equal(gridCols(2), 2);
  assert.equal(gridCols(4), 2);
  assert.equal(gridCols(5), 3);
  assert.equal(gridCols(9), 3);
  assert.equal(gridCols(10), 4);
});

test("a four-window grid really is two by two", () => {
  const r = tile("grid", 4, AREA, { gap: 0 });
  assert.equal(r[0].x, r[2].x, "0 and 2 share a column");
  assert.equal(r[1].x, r[3].x, "1 and 3 share a column");
  assert.equal(r[0].y, r[1].y, "0 and 1 share a row");
  assert.equal(r[2].y, r[3].y, "2 and 3 share a row");
});

/* ── main + stack ────────────────────────────────────────────────────────── */

test("main + stack gives the front window the larger share, on the right side", () => {
  const left = tile("main-left", 3, AREA, { gap: 0 });
  assert.ok(left[0].w > left[1].w, "the main pane is wider");
  assert.equal(left[0].x, AREA.x, "main-left puts it on the left");
  assert.equal(left[1].x, left[0].x + left[0].w, "the stack starts where main ends");

  const right = tile("main-right", 3, AREA, { gap: 0 });
  assert.equal(right[0].x + right[0].w, AREA.x + AREA.w, "main-right puts it against the right edge");
  assert.equal(right[1].x, AREA.x, "the stack starts at the left edge");
});

test("the stack splits the height between the non-main windows", () => {
  const r = tile("main-left", 3, AREA, { gap: 0 });
  assert.equal(r[1].h + r[2].h, AREA.h);
  assert.equal(r[2].y, r[1].y + r[1].h);
});

/* ── graceful degradation ────────────────────────────────────────────────── */

test("a narrow area stops adding columns instead of making slivers", () => {
  const narrow = { x: 0, y: 0, w: 500, h: 600 };
  const rects = tile("cols", 6, narrow, { gap: 8, minW: 240 });
  assert.equal(rects.length, 6, "still one rect per window");
  const distinct = new Set(rects.map((r) => `${r.x}:${r.w}`));
  assert.ok(distinct.size <= 2, `expected at most 2 columns in 500px, got ${distinct.size}`);
  for (const r of rects) assert.ok(r.w >= 200, `sliver: ${r.w}`);
});

test("surplus windows share the last slot rather than shrinking every slot", () => {
  const narrow = { x: 0, y: 0, w: 500, h: 600 };
  const rects = tile("cols", 4, narrow, { gap: 8, minW: 240 });
  const last = rects[rects.length - 1];
  assert.deepEqual({ x: rects[2].x, w: rects[2].w }, { x: last.x, w: last.w });
});

test("an unknown layout falls back to grid rather than throwing", () => {
  assert.deepEqual(tile("nonsense", 4, AREA), tile("grid", 4, AREA));
  assert.equal(isLayout("nonsense"), false);
  assert.equal(isLayout("grid"), true);
});

test("zero windows produce nothing", () => {
  for (const l of LAYOUTS.map((x) => x.id)) assert.deepEqual(tile(l, 0, AREA), []);
});

/* ── cascade ─────────────────────────────────────────────────────────────── */

test("cascade wraps before it can push a window off the bottom", () => {
  // The failure mode of every naive cascade: window 20 is off-screen.
  const rects = tile("cascade", 24, AREA);
  for (const r of rects) {
    assert.ok(r.x + r.w <= AREA.x + AREA.w, `escaped right: ${r.x + r.w}`);
    assert.ok(r.y + r.h <= AREA.y + AREA.h, `escaped bottom: ${r.y + r.h}`);
  }
  assert.ok(rects.some((r, i) => i > 0 && r.x === rects[0].x), "it must wrap back to the start");
});

test("cascade staggers, so no two consecutive titlebars coincide", () => {
  const r = tile("cascade", 3, AREA);
  assert.notEqual(r[0].x, r[1].x);
  assert.notEqual(r[0].y, r[1].y);
});

/* ── zones ───────────────────────────────────────────────────────────────── */

test("corners win over edges, or the corners are unreachable", () => {
  // A corner point is inside both edge bands. Testing edges first is what
  // makes home-grown snapping feel like it ignores you.
  assert.equal(zoneAt(2, 42, AREA).zone, "tl");
  assert.equal(zoneAt(AREA.w - 2, 42, AREA).zone, "tr");
  assert.equal(zoneAt(2, AREA.y + AREA.h - 2, AREA).zone, "bl");
  assert.equal(zoneAt(AREA.w - 2, AREA.y + AREA.h - 2, AREA).zone, "br");
});

test("edges resolve to halves, the top to maximize, and the middle to nothing", () => {
  assert.equal(zoneAt(2, 500, AREA).zone, "left");
  assert.equal(zoneAt(AREA.w - 2, 500, AREA).zone, "right");
  assert.equal(zoneAt(700, 42, AREA).zone, "max");
  assert.equal(zoneAt(700, AREA.y + AREA.h - 2, AREA).zone, "bottom");
  assert.equal(zoneAt(700, 500, AREA), null, "the middle of the screen is not a zone");
});

test("left and right halves meet exactly and cover the width", () => {
  const l = zoneRect("left", ODD);
  const r = zoneRect("right", ODD);
  assert.equal(l.x, ODD.x);
  assert.equal(l.x + l.w, r.x, "no seam");
  assert.equal(r.x + r.w, ODD.x + ODD.w, "no gap at the far edge");
  assert.equal(l.w + r.w, ODD.w);
});

test("the four quadrants tile the area exactly", () => {
  const q = ["tl", "tr", "bl", "br"].map((z) => zoneRect(z, ODD));
  assert.equal(q.reduce((a, r) => a + r.w * r.h, 0), ODD.w * ODD.h);
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) assert.ok(!overlaps(q[i], q[j]), `${i}/${j} overlap`);
  }
});

test("max is the whole work area", () => {
  assert.deepEqual(zoneRect("max", ODD), { ...ODD });
});
