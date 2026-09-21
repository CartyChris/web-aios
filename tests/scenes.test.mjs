/* Scenes: capture an arrangement, restore it somewhere else.
 *
 * The case that matters is restoring onto a screen that is not the one the
 * scene came from, so most of these capture on one area and restore on
 * another.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  captureScene, planRestore, parseScene, sceneToJson, describeScene, MAX_SCENE_WINDOWS,
} from "../.test-build/scenes.js";

const BIG = { x: 0, y: 40, w: 2560, h: 1400 };
const SMALL = { x: 0, y: 40, w: 1280, h: 700 };
const all = () => true;

const win = (appId, x, y, w, h, extra = {}) => ({
  appId, x, y, w, h, state: "normal", workspace: 1, ...extra,
});

/* ── capture ─────────────────────────────────────────────────────────────── */

test("capture stores geometry as fractions, not pixels", () => {
  const s = captureScene("Research", [win("chat", 0, 40, 1280, 700)], 1, BIG, 1000);
  const w = s.windows[0];
  assert.equal(w.fx, 0);
  assert.equal(w.fy, 0);
  assert.equal(w.fw, 0.5, "1280 of 2560");
  assert.equal(w.fh, 0.5, "700 of 1400");
});

test("capture keeps no runtime bookkeeping", () => {
  const s = captureScene("X", [{ ...win("chat", 0, 40, 100, 100), id: "w_1", z: 99, createdAt: 5 }], 1, BIG, 1000);
  assert.ok(!("id" in s.windows[0]));
  assert.ok(!("z" in s.windows[0]));
  assert.ok(!("createdAt" in s.windows[0]));
});

test("a nameless scene still gets a name, and names are bounded", () => {
  assert.equal(captureScene("   ", [win("chat", 0, 40, 10, 10)], 1, BIG, 1).name, "Untitled scene");
  assert.equal(captureScene("x".repeat(200), [win("chat", 0, 40, 10, 10)], 1, BIG, 1).name.length, 60);
});

test("a zero-sized work area cannot produce Infinity fractions", () => {
  // A hidden pane reports 0x0. Dividing by it would poison the scene forever.
  const s = captureScene("X", [win("chat", 0, 0, 800, 600)], 1, { x: 0, y: 0, w: 0, h: 0 }, 1);
  for (const v of [s.windows[0].fx, s.windows[0].fy, s.windows[0].fw, s.windows[0].fh]) {
    assert.ok(Number.isFinite(v), `${v} must be finite`);
  }
});

test("capture is capped, so one runaway desktop cannot produce an unbounded scene", () => {
  const many = Array.from({ length: 100 }, (_, i) => win(`app${i}`, 0, 40, 100, 100));
  assert.equal(captureScene("X", many, 1, BIG, 1).windows.length, MAX_SCENE_WINDOWS);
});

test("pinned and args survive, and absent ones are not invented", () => {
  const s = captureScene("X", [
    win("studio", 0, 40, 100, 100, { pinned: true, args: { tab: "build" } }),
    win("chat", 0, 40, 100, 100),
  ], 1, BIG, 1);
  assert.equal(s.windows[0].pinned, true);
  assert.deepEqual(s.windows[0].args, { tab: "build" });
  assert.ok(!("pinned" in s.windows[1]));
  assert.ok(!("args" in s.windows[1]));
});

/* ── restore onto a different screen ─────────────────────────────────────── */

test("a scene captured on a big screen restores in PROPORTION on a small one", () => {
  const scene = captureScene("R", [win("chat", 1280, 740, 1280, 700)], 1, BIG, 1);
  const { open } = planRestore(scene, SMALL, all);
  assert.deepEqual(open[0], {
    appId: "chat", title: undefined, x: 640, y: 390, w: 640, h: 350,
    state: "normal", workspace: 1,
  });
});

test("nothing lands outside the work area, however odd the target", () => {
  const scene = captureScene("R", [
    win("chat", 2400, 1300, 900, 600),   // hanging off the right and bottom
    win("notes", 0, 40, 2560, 1400),     // full screen
  ], 1, BIG, 1);
  for (const area of [SMALL, { x: 7, y: 41, w: 1001, h: 683 }, { x: 0, y: 0, w: 400, h: 300 }]) {
    for (const o of planRestore(scene, area, all).open) {
      assert.ok(o.x >= area.x, `left ${o.x} < ${area.x}`);
      assert.ok(o.y >= area.y, `top ${o.y} < ${area.y}`);
      assert.ok(o.x + o.w <= area.x + area.w, `right ${o.x + o.w} > ${area.x + area.w}`);
      assert.ok(o.y + o.h <= area.y + area.h, `bottom ${o.y + o.h} > ${area.y + area.h}`);
    }
  }
});

test("a window that keeps its place keeps it exactly", () => {
  // x 2000/2560 = 0.78125 -> 1000 on a 1280 screen; 1000 + 256 still fits, so
  // nothing is nudged and the proportional position is preserved exactly.
  const scene = captureScene("R", [win("chat", 2000, 40, 512, 280)], 1, BIG, 1);
  const { open } = planRestore(scene, SMALL, all);
  assert.equal(open[0].w, 256, "width scales with the screen");
  assert.equal(open[0].x, 1000, "position scales with the screen");
});

test("an overhanging window is MOVED, not shrunk — the arrangement stays recognisable", () => {
  // x 2400/2560 = 0.9375 -> 1200, but 1200 + 256 would overhang 1280. The
  // window is pushed back to 1024 and KEEPS its full 256 width; shrinking it
  // to 80 to make it fit is what makes restored layouts look wrong.
  const scene = captureScene("R", [win("chat", 2400, 40, 512, 280)], 1, BIG, 1);
  const { open } = planRestore(scene, SMALL, all);
  assert.equal(open[0].w, 256, "width is not sacrificed to make it fit");
  assert.equal(open[0].x, 1024, "it is pushed just inside the right edge");
  assert.equal(open[0].x + open[0].w, 1280, "and sits flush against it");
});

test("a window never restores smaller than a usable size", () => {
  const scene = captureScene("R", [win("chat", 0, 40, 60, 40)], 1, BIG, 1);
  const [o] = planRestore(scene, SMALL, all).open;
  assert.ok(o.w >= 240, `too narrow: ${o.w}`);
  assert.ok(o.h >= 160, `too short: ${o.h}`);
});

test("state, workspace, pin and args come back", () => {
  const scene = captureScene("R", [
    win("studio", 0, 40, 800, 600, { state: "maximized", workspace: 3, pinned: true, args: { tab: "build" } }),
  ], 2, BIG, 1);
  const plan = planRestore(scene, SMALL, all);
  assert.equal(plan.open[0].state, "maximized");
  assert.equal(plan.open[0].workspace, 3);
  assert.equal(plan.open[0].pinned, true);
  assert.deepEqual(plan.open[0].args, { tab: "build" });
  assert.equal(plan.activeWorkspace, 2);
});

/* ── an app that no longer exists ────────────────────────────────────────── */

test("a removed app is reported, and everything else still restores", () => {
  const scene = captureScene("R", [
    win("chat", 0, 40, 800, 600),
    win("gone", 0, 40, 800, 600),
    win("notes", 0, 40, 800, 600),
  ], 1, BIG, 1);
  const plan = planRestore(scene, SMALL, (id) => id !== "gone");
  assert.deepEqual(plan.open.map((o) => o.appId), ["chat", "notes"]);
  assert.deepEqual(plan.missing, ["gone"]);
});

test("a removed app is reported once, however many windows it had", () => {
  const scene = captureScene("R", [win("gone", 0, 40, 10, 10), win("gone", 0, 40, 10, 10)], 1, BIG, 1);
  assert.deepEqual(planRestore(scene, SMALL, () => false).missing, ["gone"]);
});

/* ── import / export ─────────────────────────────────────────────────────── */

test("a scene survives a round trip through JSON", () => {
  const scene = captureScene("Round", [win("chat", 100, 140, 800, 600, { workspace: 2 })], 2, BIG, 1234);
  const back = parseScene(sceneToJson(scene), 9999);
  assert.equal(back.ok, true);
  assert.equal(back.scene.name, "Round");
  assert.equal(back.scene.activeWorkspace, 2);
  assert.deepEqual(back.scene.windows, scene.windows);
});

test("malformed input is refused with a reason, never thrown", () => {
  assert.match(parseScene("{", 1).reason, /Not valid JSON/);
  assert.match(parseScene("[]", 1).reason, /Not an object/);
  assert.match(parseScene('{"name":"x"}', 1).reason, /No windows array/);
  assert.match(parseScene('{"windows":[{"nope":1}]}', 1).reason, /No usable windows/);
});

test("a window with a nonsense size gets a usable default, never zero", () => {
  const r = parseScene('{"windows":[{"appId":"chat","fw":0,"fh":"big"}]}', 1);
  assert.equal(r.ok, true);
  assert.equal(r.scene.windows[0].fw, 0.5);
  assert.equal(r.scene.windows[0].fh, 0.5);
});

test("imported fractions and workspaces are clamped into range", () => {
  const r = parseScene('{"windows":[{"appId":"chat","fx":-9,"fy":42,"workspace":999}]}', 1);
  assert.equal(r.scene.windows[0].fx, 0);
  assert.equal(r.scene.windows[0].fy, 1);
  assert.equal(r.scene.windows[0].workspace, 8);
});

test("an import without an id or name still gets both", () => {
  const r = parseScene('{"windows":[{"appId":"chat"}]}', 777);
  assert.ok(r.scene.id.length > 0);
  assert.equal(r.scene.name, "Imported scene");
});

/* ── description ─────────────────────────────────────────────────────────── */

test("describeScene counts windows and desktops", () => {
  const one = captureScene("A", [win("chat", 0, 40, 10, 10)], 1, BIG, 1);
  assert.equal(describeScene(one), "1 window");
  const many = captureScene("B", [
    win("chat", 0, 40, 10, 10), win("notes", 0, 40, 10, 10, { workspace: 2 }),
  ], 1, BIG, 1);
  assert.equal(describeScene(many), "2 windows across 2 desktops");
});
