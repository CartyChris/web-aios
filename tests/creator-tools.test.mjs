/**
 * Undo history (Forge 3D, Asset Studio), update trials (Updates), arcade
 * tables, theme files (Personalize) and scene edits (Forge 3D, Assets).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { initHistory, record, undo, redo, canUndo, canRedo } from "../.test-build/undo-history.js";
import { startTrial, secondsLeft, fractionLeft, isExpired, outcome } from "../.test-build/trial.js";
import { insertScore } from "../.test-build/leaderboard.js";
import { exportTheme, importTheme, uniqueId } from "../.test-build/theme-io.js";
import { snapValue, snapVec, dropToGround, duplicatePosition, alignTo, sanitizeParts, localMinY } from "../.test-build/forge-ops.js";

/* ── undo ── */

test("undo and redo walk the steps and a new change clears redo", () => {
  let h = initHistory(0);
  h = record(h, 1, { now: 0 });
  h = record(h, 2, { now: 1000 });
  assert.equal(undo(h).present, 1);
  assert.equal(undo(undo(h)).present, 0);
  assert.equal(canUndo(undo(undo(h))), false);
  const back = undo(h);
  assert.equal(redo(back).present, 2);
  const branched = record(back, 9, { now: 2000 });
  assert.equal(canRedo(branched), false);
});

test("changes with the same key inside the window fold into one step", () => {
  let h = initHistory("a");
  h = record(h, "b", { now: 0, key: "drag" });
  h = record(h, "c", { now: 100, key: "drag" });
  h = record(h, "d", { now: 200, key: "drag" });
  assert.equal(h.past.length, 1, "one drag, one step");
  assert.equal(undo(h).present, "a");
  h = record(h, "e", { now: 2000, key: "drag" });
  assert.equal(h.past.length, 2, "a pause starts a new step");
  h = record(h, "f", { now: 2050, key: "other" });
  assert.equal(h.past.length, 3, "a different key starts a new step");
});

test("recording the same value is not a step, and the cap drops the oldest", () => {
  const same = initHistory(5);
  assert.equal(record(same, 5, { now: 0 }), same);
  let h = initHistory(0);
  for (let i = 1; i <= 10; i++) h = record(h, i, { now: i * 10_000, cap: 3 });
  assert.deepEqual(h.past, [7, 8, 9]);
});

/* ── trial ── */

test("a trial counts down in whole seconds, rounded up, and expires on time", () => {
  const t = startTrial("v1", "Night", 1000, 15_000);
  assert.equal(secondsLeft(t, 1000), 15);
  assert.equal(secondsLeft(t, 1001), 15);
  assert.equal(secondsLeft(t, 15_001), 1, "never shows 0 while time remains");
  assert.equal(secondsLeft(t, 16_000), 0);
  assert.equal(isExpired(t, 15_999), false);
  assert.equal(isExpired(t, 16_000), true);
  assert.equal(fractionLeft(t, 8_500), 0.5);
  assert.equal(fractionLeft(t, 99_999), 0);
});

test("only an explicit Keep keeps; silence reverts", () => {
  assert.equal(outcome("keep"), "kept");
  assert.equal(outcome("expired"), "reverted");
  assert.equal(outcome("revert"), "reverted");
  assert.equal(startTrial("v", "t", 0, 10).endsAt, 1000, "a trial is never shorter than a second");
});

/* ── leaderboard ── */

test("scores insert in order, ties keep the older entry above", () => {
  let l = [];
  l = insertScore(l, { score: 50, at: 1 }).list;
  l = insertScore(l, { score: 90, at: 2 }).list;
  const r = insertScore(l, { score: 50, at: 3 });
  assert.equal(r.rank, 3);
  assert.deepEqual(r.list.map((e) => e.at), [2, 1, 3]);
});

test("a score that does not make the table has no rank, and zero is never recorded", () => {
  let l = [];
  for (const s of [100, 90, 80, 70, 60]) l = insertScore(l, { score: s, at: s }).list;
  const miss = insertScore(l, { score: 10, at: 1 });
  assert.equal(miss.rank, null);
  assert.equal(miss.list.length, 5);
  assert.equal(insertScore([], { score: 0, at: 1 }).rank, null);
  assert.equal(insertScore(l, { score: 95, at: 9 }).rank, 2);
});

/* ── theme files ── */

const goodVars = {
  "--bg": "#0b0f18", "--bg2": "#121a2b", "--panel": "#161f33", "--panel-solid": "#161f33",
  "--text": "#eef3ff", "--muted": "#9fb0cc", "--accent": "#6ea8fe", "--accent2": "#c4b5fd",
  "--border": "rgb(255 255 255 / 0.12)", "--on-accent": "#04121c", "--on-accent2": "#0b0a1a",
};

test("a theme round-trips through its file", () => {
  const text = exportTheme({ id: "probe", name: "Probe", dark: true, vars: goodVars });
  const r = importTheme(text, []);
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  assert.equal(r.theme.id, "probe");
  assert.equal(r.theme.vars["--accent"], "#6ea8fe");
  assert.equal(r.renamed, false);
});

test("an imported theme never takes an existing id", () => {
  const text = exportTheme({ id: "midnight", name: "Midnight", dark: true, vars: goodVars });
  const r = importTheme(text, ["midnight", "midnight-2"]);
  assert.equal(r.theme.id, "midnight-3");
  assert.equal(r.renamed, true);
  assert.equal(uniqueId("x", []), "x");
});

test("unreadable, malformed and foreign theme files are refused with a reason", () => {
  const unreadable = importTheme(exportTheme({ id: "bad", name: "Bad", dark: true, vars: { ...goodVars, "--text": "#10141c" } }), []);
  assert.equal(unreadable.ok, false);
  assert.match(unreadable.error, /Rejected/);
  assert.equal(importTheme("{nope", []).ok, false);
  assert.match(importTheme(JSON.stringify({ format: "other-os", theme: {} }), []).error, /Unknown format/);
  assert.equal(importTheme(JSON.stringify({ format: "web-aios-theme", theme: { name: "X", vars: { ...goodVars, "--accent": "red" } } }), []).ok, false);
  assert.equal(importTheme("x".repeat(70_000), []).ok, false);
});

/* ── scene edits ── */

test("snapping lands on the grid without float dust", () => {
  assert.equal(snapValue(0.3 * 3, 0.1), 0.9);
  assert.equal(snapValue(1.26, 0.5), 1.5);
  assert.ok(Object.is(snapValue(-7, 15), 0), "no negative zero");
  assert.deepEqual(snapVec([1.24, 44, -0.26], 0.5), [1, 44, -0.5]);
  assert.equal(snapValue(3.3, 0), 3.3, "step 0 means off");
});

test("dropToGround rests the lowest part on y = 0, honouring entity scale", () => {
  const parts = [{ shape: "box", position: [0, 0.5, 0], scale: [1, 1, 1] }, { shape: "sphere", position: [0, -1, 0], scale: [1, 0.4, 1] }];
  assert.equal(localMinY(parts), -1.2);
  assert.deepEqual(dropToGround([3, 7, 2], parts, [1, 2, 1]), [3, 2.4, 2]);
  assert.deepEqual(dropToGround([0, 5, 0], [], [1, 1, 1]), [0, 0, 0]);
});

test("a duplicate is placed clear of everything already there", () => {
  assert.deepEqual(duplicatePosition([0, 0, 0], [[0, 0, 0], [2, 0, 0]]), [4, 0, 0]);
  assert.deepEqual(duplicatePosition([0, 0, 0], []), [2, 0, 0]);
});

test("alignTo copies one axis only", () => {
  assert.deepEqual(alignTo([[1, 2, 3], [4, 5, 6]], [9, 9, 9], 1), [[1, 9, 3], [4, 9, 6]]);
});

test("sanitizeParts keeps what can be drawn and counts what could not", () => {
  const r = sanitizeParts([
    { name: "ok", shape: "box", position: [0, 1, 0], scale: [1, 1, 1], color: "#AABBCC", roughness: 3 },
    { shape: "blob", position: [0, 0, 0] },
    { position: [0, "x", 0] },
    { position: [0, 0, 0], scale: [0, 1, 1] },
    null,
    { position: [1, 2] },
  ]);
  assert.equal(r.parts.length, 2);
  assert.equal(r.dropped, 4);
  assert.equal(r.reshaped, 1);
  assert.equal(r.parts[0].color, "#aabbcc");
  assert.equal(r.parts[0].roughness, 1);
  assert.equal(r.parts[1].shape, "box");
  assert.deepEqual(r.parts[1].scale, [1, 1, 1]);
  assert.deepEqual(sanitizeParts("nope"), { parts: [], dropped: 0, reshaped: 0 });
});
