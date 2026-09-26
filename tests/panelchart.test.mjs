/* Chart geometry for the AIOS Chat chart panel.
 *
 * Every bar and tick on screen comes from chartLayout, so the honesty of the
 * picture is pinned here: the axis includes zero, heights are proportional to
 * values, negatives hang below zero, and gaps stay gaps.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { niceStep, niceTicks, compactNumber, chartLayout } from "../.test-build/panelchart.js";

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("nice steps are 1, 2, 2.5 or 5 times a power of ten", () => {
  assert.equal(niceStep(17), 20);
  assert.equal(niceStep(20), 20);
  assert.equal(niceStep(21), 25);
  assert.equal(niceStep(0.3), 0.5);
  assert.equal(niceStep(0.1), 0.1);
  assert.equal(niceStep(3000), 5000);
  assert.equal(niceStep(0), 1);
  assert.equal(niceStep(NaN), 1);
});

test("ticks cover the data and always include zero", () => {
  assert.deepEqual(niceTicks(0, 87), [0, 25, 50, 75, 100]);
  assert.deepEqual(niceTicks(40, 87), [0, 25, 50, 75, 100], "an all-positive range still starts at zero");
  const neg = niceTicks(-30, 70);
  assert.ok(neg.includes(0));
  assert.ok(neg[0] <= -30 && neg.at(-1) >= 70);
  assert.deepEqual(niceTicks(0, 0), [0, 0.25, 0.5, 0.75, 1], "all zeros is a real axis, not a division by zero");
});

test("compact numbers", () => {
  assert.equal(compactNumber(0), "0");
  assert.equal(compactNumber(0.25), "0.25");
  assert.equal(compactNumber(1234), "1234");
  assert.equal(compactNumber(12345), "12.3k");
  assert.equal(compactNumber(2_500_000), "2.5M");
  assert.equal(compactNumber(-12000), "-12k");
});

const box = { w: 240, h: 140, left: 30, bottom: 20, top: 0, right: 10 };

test("bar heights are proportional to values and stand on the zero line", () => {
  const L = chartLayout({ kind: "bar", labels: ["a", "b"], series: [{ name: "s", values: [25, 50] }] }, box);
  const [a, b] = L.bars;
  close(b.h, 2 * a.h);
  close(a.y + a.h, L.zeroY);
  close(b.y + b.h, L.zeroY);
  // plot height 120; 50 needs steps of 20 (the next nice step above 50/4), so the axis runs to 60.
  assert.equal(L.ticks.at(-1).v, 60);
  close(b.h, 120 * 50 / 60);
  assert.ok(a.x < b.x, "bars follow label order");
});

test("a negative value hangs below the zero line", () => {
  const L = chartLayout({ kind: "bar", labels: ["up", "down"], series: [{ name: "s", values: [10, -10] }] }, box);
  const [up, down] = L.bars;
  close(up.y + up.h, L.zeroY);
  close(down.y, L.zeroY);
  close(up.h, down.h);
  assert.ok(L.zeroY > L.plot.y && L.zeroY < L.plot.y + L.plot.h, "zero is inside the plot");
});

test("grouped bars share a slot without overlapping", () => {
  const L = chartLayout({ kind: "bar", labels: ["a"], series: [{ name: "x", values: [1] }, { name: "y", values: [2] }] }, box);
  const [x, y] = L.bars;
  assert.equal(x.series, 0);
  assert.equal(y.series, 1);
  assert.ok(x.x + x.w <= y.x + 1e-9);
  assert.ok(y.x + y.w <= L.plot.x + L.plot.w);
});

test("gaps are not drawn: no bar, and a line breaks into runs", () => {
  const bar = chartLayout({ kind: "bar", labels: ["a", "b", "c"], series: [{ name: "s", values: [1, null, 3] }] }, box);
  assert.equal(bar.bars.length, 2);
  const line = chartLayout({ kind: "line", labels: ["a", "b", "c", "d"], series: [{ name: "s", values: [1, 2, null, 4] }] }, box);
  assert.deepEqual(line.lines[0].runs.map((r) => r.length), [2, 1]);
});

test("ticks are labelled and ordered top to bottom by value", () => {
  const L = chartLayout({ kind: "line", labels: ["a"], series: [{ name: "s", values: [87] }] }, box);
  assert.deepEqual(L.ticks.map((t) => t.label), ["0", "25", "50", "75", "100"]);
  for (let i = 1; i < L.ticks.length; i++) assert.ok(L.ticks[i].y < L.ticks[i - 1].y, "a higher value is higher on screen");
  close(L.ticks[0].y, L.plot.y + L.plot.h);
});

test("crowded category labels are thinned so they cannot overlap", () => {
  const labels = Array.from({ length: 24 }, (_, i) => `Label ${i}`);
  const L = chartLayout({ kind: "bar", labels, series: [{ name: "s", values: labels.map(() => 1) }] }, box);
  assert.ok(L.xLabels.length < 24);
  for (let i = 1; i < L.xLabels.length; i++) assert.ok(L.xLabels[i].x - L.xLabels[i - 1].x >= "Label 23".length * 6);
});
