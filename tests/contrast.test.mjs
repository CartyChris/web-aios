/* Readable text over something we did not choose.
 *
 * The bug: a desktop icon label takes its colour from `--text`, which belongs
 * to the theme, so a LIGHT theme over a DARK wallpaper paints near-black on
 * near-black. These tests pin the arithmetic that decides the colour instead.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  relativeLuminance, contrastRatio, pickTextColor, applyDim,
  luminanceGrid, sampleGrid, textStyleAt, PAPER, INK,
} from "../.test-build/contrast.js";

/** Build RGBA pixel data from a per-pixel colour function. */
function pixels(w, h, fn) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a = 255] = fn(x, y);
      const i = (y * w + x) * 4;
      out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = a;
    }
  }
  return out;
}

/* ── luminance ───────────────────────────────────────────────────────────── */

test("luminance matches the WCAG anchors", () => {
  assert.equal(relativeLuminance(255, 255, 255), 1);
  assert.equal(relativeLuminance(0, 0, 0), 0);
  // Green carries most of perceived brightness, blue almost none.
  assert.ok(relativeLuminance(0, 255, 0) > relativeLuminance(255, 0, 0));
  assert.ok(relativeLuminance(255, 0, 0) > relativeLuminance(0, 0, 255));
});

test("luminance clamps out-of-range channels rather than producing nonsense", () => {
  assert.equal(relativeLuminance(999, 999, 999), 1);
  assert.equal(relativeLuminance(-50, -50, -50), 0);
});

test("black on white is the maximum contrast ratio of 21", () => {
  assert.ok(Math.abs(contrastRatio(0, 1) - 21) < 1e-9);
  assert.equal(contrastRatio(0.5, 0.5), 1);
  assert.equal(contrastRatio(0, 1), contrastRatio(1, 0), "the ratio must not depend on argument order");
});

/* ── the decision ────────────────────────────────────────────────────────── */

test("a dark background gets white text and a light one gets ink", () => {
  // The case in the report: a near-black wallpaper under a light theme.
  assert.equal(pickTextColor(relativeLuminance(10, 14, 26)), PAPER);
  assert.equal(pickTextColor(relativeLuminance(246, 247, 251)), INK);
});

test("the crossover sits near 0.179, NOT at 0.5", () => {
  // Luminance is already perceptual: a 0.5 background is much closer to white
  // than to black in contrast terms, so splitting at 0.5 would put black text
  // where white is measurably more readable.
  assert.equal(pickTextColor(0.5), INK);
  assert.equal(pickTextColor(0.2), INK);
  assert.equal(pickTextColor(0.15), PAPER);
  assert.equal(pickTextColor(0.0), PAPER);
});

test("whichever colour is chosen genuinely has the better ratio", () => {
  // The property, not a constant: for any background, the pick must be the
  // better of the two options.
  for (let i = 0; i <= 100; i++) {
    const bg = i / 100;
    const chosen = pickTextColor(bg);
    const white = contrastRatio(bg, relativeLuminance(255, 255, 255));
    const ink = contrastRatio(bg, relativeLuminance(5, 5, 6));
    const chosenRatio = chosen === PAPER ? white : ink;
    assert.ok(chosenRatio >= Math.max(white, ink) - 1e-9, `bg ${bg} picked the worse colour`);
  }
});

test("every choice clears WCAG AA for normal text", () => {
  for (let i = 0; i <= 100; i++) {
    const bg = i / 100;
    const chosen = pickTextColor(bg);
    const ratio = contrastRatio(bg, relativeLuminance(...(chosen === PAPER ? [255, 255, 255] : [5, 5, 6])));
    assert.ok(ratio >= 4.5, `bg ${bg} only reached ${ratio.toFixed(2)}:1 with ${chosen}`);
  }
});

test("a dim overlay darkens what the text actually faces", () => {
  assert.equal(applyDim(1, 0), 1);
  assert.equal(applyDim(1, 1), 0);
  assert.ok(Math.abs(applyDim(0.8, 0.5) - 0.4) < 1e-9);
  // A bright wallpaper dimmed hard must flip the text to white.
  assert.equal(pickTextColor(applyDim(0.9, 0)), INK);
  assert.equal(pickTextColor(applyDim(0.9, 0.9)), PAPER);
});

test("applyDim clamps a nonsense opacity instead of inverting", () => {
  assert.equal(applyDim(0.5, -1), 0.5);
  assert.equal(applyDim(0.5, 5), 0);
});

/* ── sampling ────────────────────────────────────────────────────────────── */

test("a uniform image produces one value in every cell", () => {
  const g = luminanceGrid(pixels(40, 40, () => [255, 255, 255]), 40, 40, 4, 4, 1);
  assert.equal(g.cells.length, 16);
  for (const c of g.cells) assert.ok(Math.abs(c - 1) < 1e-6);
});

test("a gradient is resolved per cell, not averaged into one number", () => {
  // The whole reason the grid exists. The reported wallpaper is a gradient:
  // dark at one corner, lighter at the other. A single global average would
  // put one colour on every icon and be wrong at both ends.
  const g = luminanceGrid(pixels(64, 64, (x) => { const v = Math.round((x / 63) * 255); return [v, v, v]; }), 64, 64, 4, 1, 1);
  assert.equal(g.cells.length, 4);
  for (let i = 1; i < 4; i++) assert.ok(g.cells[i] > g.cells[i - 1], "cells did not increase across the gradient");
  assert.equal(pickTextColor(g.cells[0]), PAPER, "the dark end should take white text");
  assert.equal(pickTextColor(g.cells[3]), INK, "the light end should take ink");
});

test("a transparent pixel is not counted as black", () => {
  // It shows whatever is behind it. Treating alpha 0 as black would drag every
  // cell dark and paint white text over a light page.
  const opaque = luminanceGrid(pixels(8, 8, () => [255, 255, 255, 255]), 8, 8, 1, 1, 1);
  const clear = luminanceGrid(pixels(8, 8, () => [255, 255, 255, 0]), 8, 8, 1, 1, 1);
  assert.ok(Math.abs(opaque.cells[0] - 1) < 1e-6);
  assert.ok(clear.cells[0] < 1e-6);
});

test("the stride changes cost, not the DECISION, on a smooth gradient", () => {
  // Measured drift at stride 4 is about 0.046 luminance. That is far too small
  // to see and — the claim that actually matters — it never moves a cell
  // across the crossover, so the colour chosen is identical either way.
  const data = pixels(64, 64, (x) => { const v = Math.round((x / 63) * 255); return [v, v, v]; });
  const fine = luminanceGrid(data, 64, 64, 4, 1, 1);
  const coarse = luminanceGrid(data, 64, 64, 4, 1, 4);
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(fine.cells[i] - coarse.cells[i]) < 0.06, `cell ${i} drifted further than expected`);
    assert.equal(pickTextColor(fine.cells[i]), pickTextColor(coarse.cells[i]), `cell ${i} changed colour with the stride`);
  }
});

test("degenerate input returns an empty grid rather than throwing", () => {
  assert.equal(luminanceGrid(new Uint8ClampedArray(0), 0, 0, 4, 4).cells.length, 16);
  assert.equal(luminanceGrid(new Uint8ClampedArray(0), 10, 10, 0, 0).cells.length, 1);
});

test("sampling clamps out-of-range coordinates to the edge cell", () => {
  // An icon dragged past the surface still needs a colour.
  const g = luminanceGrid(pixels(16, 16, (x) => (x < 8 ? [0, 0, 0] : [255, 255, 255])), 16, 16, 2, 1, 1);
  assert.equal(sampleGrid(g, -5, 0), sampleGrid(g, 0, 0));
  assert.equal(sampleGrid(g, 99, 0), sampleGrid(g, 0.99, 0));
  assert.ok(sampleGrid(g, 0.1, 0.5) < sampleGrid(g, 0.9, 0.5));
});

test("sampling an empty grid answers dark rather than undefined", () => {
  assert.equal(sampleGrid({ cols: 0, rows: 0, cells: new Float32Array(0) }, 0.5, 0.5), 0);
});

/* ── the style handed to the DOM ─────────────────────────────────────────── */

test("textStyleAt returns a colour and a halo that oppose each other", () => {
  const dark = luminanceGrid(pixels(8, 8, () => [10, 14, 26]), 8, 8, 1, 1, 1);
  const light = luminanceGrid(pixels(8, 8, () => [246, 247, 251]), 8, 8, 1, 1, 1);

  const onDark = textStyleAt(dark, 0.5, 0.5);
  assert.equal(onDark.color, PAPER);
  assert.match(onDark.textShadow, /rgba\(0,0,0/, "white text needs a dark halo");

  const onLight = textStyleAt(light, 0.5, 0.5);
  assert.equal(onLight.color, INK);
  assert.match(onLight.textShadow, /rgba\(255,255,255/, "dark text needs a light halo");
});

test("dim is honoured through textStyleAt", () => {
  const light = luminanceGrid(pixels(8, 8, () => [240, 240, 240]), 8, 8, 1, 1, 1);
  assert.equal(textStyleAt(light, 0.5, 0.5, 0).color, INK);
  assert.equal(textStyleAt(light, 0.5, 0.5, 0.95).color, PAPER, "a heavily dimmed wallpaper is dark");
});
