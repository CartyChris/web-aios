/**
 * The 3D scene layer: parsing what a model returns, and the maths the
 * viewport runs sixty times a second.
 *
 * Both halves fail quietly if they are wrong. A JSON extractor that gives up
 * on a reply with prose around it looks like "the model failed"; lighting that
 * accumulates wrongly looks like "the renderer is a bit flat".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJson } from "../.test-build/forge-schema.js";
import { lightAt, stepParticles, hexToRgb, makeProjector, partFaces } from "../.test-build/forge-render.js";

/* ── Parsing what a model actually sends back ──────────────────────────── */

test("extractJson finds the object whether or not it is fenced", () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('```\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
});

test("extractJson survives the prose models put around it", () => {
  const reply = 'Sure! Here is the scene you asked for:\n\n```json\n{"entities":[{"name":"Crate"}]}\n```\n\nLet me know if you want it bigger.';
  assert.deepEqual(extractJson(reply), { entities: [{ name: "Crate" }] });
});

test("extractJson is not fooled by braces inside strings", () => {
  const reply = '{"name":"a } brace","color":"#ffffff"}';
  assert.deepEqual(extractJson(reply), { name: "a } brace", color: "#ffffff" });
});

test("extractJson handles escaped quotes inside strings", () => {
  assert.deepEqual(extractJson('{"name":"say \\"hi\\"","n":2}'), { name: 'say "hi"', n: 2 });
});

test("a truncated reply says it was truncated rather than throwing a parse error", () => {
  assert.throws(() => extractJson('{"entities":[{"name":"Half a cr'), /never closed|cut off/i);
});

test("a reply with no object at all is rejected", () => {
  assert.throws(() => extractJson("I cannot build that."), /No JSON object/);
});

/* ── Lighting ──────────────────────────────────────────────────────────── */

const white = (pos) => ({ id: "l", name: "l", kind: "directional", position: pos, color: "#ffffff", intensity: 1, range: 0 });

test("a face pointing at the light is lit; one facing away gets ambient only", () => {
  const lights = [white([0, 1, 0])];
  const up = lightAt([0, 1, 0], 0, 0, 0, lights, 0.2);
  const down = lightAt([0, -1, 0], 0, 0, 0, lights, 0.2);
  assert.ok(up[0] > 1.1, `top face should be lit, got ${up[0]}`);
  assert.deepEqual(down, [0.2, 0.2, 0.2], "a back face must never receive light");
});

test("light colour tints the surface rather than only brightening it", () => {
  const red = [{ ...white([0, 1, 0]), color: "#ff0000" }];
  const [r, g, b] = lightAt([0, 1, 0], 0, 0, 0, red, 0.1);
  assert.ok(r > g && r > b, "a red light must raise red more than green or blue");
  assert.equal(g, 0.1);
  assert.equal(b, 0.1);
});

test("a disabled or zero-intensity light contributes nothing", () => {
  const off = [{ ...white([0, 1, 0]), on: false }];
  const zero = [{ ...white([0, 1, 0]), intensity: 0 }];
  assert.deepEqual(lightAt([0, 1, 0], 0, 0, 0, off, 0.3), [0.3, 0.3, 0.3]);
  assert.deepEqual(lightAt([0, 1, 0], 0, 0, 0, zero, 0.3), [0.3, 0.3, 0.3]);
});

test("a point light falls off with distance and respects its range", () => {
  const lamp = [{ id: "p", name: "p", kind: "point", position: [0, 2, 0], color: "#ffffff", intensity: 2, range: 6 }];
  const near = lightAt([0, 1, 0], 0, 0, 0, lamp, 0);
  const far = lightAt([0, 1, 0], 0, 0, 40, lamp, 0);
  assert.ok(near[0] > far[0], "closer must be brighter");
  assert.ok(far[0] < 0.05, `a surface 40m from a 6m lamp should be dark, got ${far[0]}`);
});

test("several lights accumulate", () => {
  const one = lightAt([0, 1, 0], 0, 0, 0, [white([0, 1, 0])], 0);
  const two = lightAt([0, 1, 0], 0, 0, 0, [white([0, 1, 0]), white([0, 1, 0])], 0);
  assert.ok(Math.abs(two[0] - one[0] * 2) < 1e-9, "two identical lights should double the contribution");
});

/* ── Particles ─────────────────────────────────────────────────────────── */

const emitter = (over) => ({
  id: "e", name: "e", position: [0, 0, 0], color: "#fff", color2: "#000",
  rate: 60, life: 1, speed: 1, spread: 0.5, size: 0.1, gravity: 0, blend: "add", ...over,
});

test("particles are spawned, age, and are removed when their life ends", () => {
  const pool = [];
  stepParticles(pool, [emitter({})], 0.1);
  assert.ok(pool.length > 0, "a live emitter must spawn");
  const born = pool.length;
  for (let i = 0; i < 30; i++) stepParticles(pool, [emitter({ rate: 0 })], 0.1);
  assert.equal(pool.length, 0, `all ${born} particles should have expired`);
});

test("gravity is applied per second, not per frame", () => {
  const pool = [{ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0, life: 10, emitter: 0 }];
  const e = [emitter({ rate: 0, gravity: 10 })];
  stepParticles(pool, e, 1);
  assert.ok(Math.abs(pool[0].vy - 10) < 1e-9, `one second at 10 m/s² should give vy=10, got ${pool[0].vy}`);
});

test("a disabled emitter spawns nothing", () => {
  const pool = [];
  stepParticles(pool, [emitter({ on: false })], 0.5);
  assert.equal(pool.length, 0);
});

test("the pool is capped so a runaway emitter cannot lock the tab up", () => {
  const pool = [];
  const hose = [emitter({ rate: 200, life: 10 })];
  for (let i = 0; i < 400; i++) stepParticles(pool, hose, 0.1, 300);
  assert.ok(pool.length <= 300, `budget must hold, got ${pool.length}`);
});

test("stepParticles mutates the pool in place rather than allocating a new one", () => {
  const pool = [];
  const same = stepParticles(pool, [emitter({})], 0.1);
  assert.equal(same, pool, "returning a new array every frame is what makes particle systems stutter");
});

/* ── Geometry ──────────────────────────────────────────────────────────── */

test("hexToRgb handles both forms and refuses to throw on nonsense", () => {
  assert.deepEqual(hexToRgb("#ff8800"), [255, 136, 0]);
  assert.deepEqual(hexToRgb("#f80"), [255, 136, 0]);
  assert.deepEqual(hexToRgb("not a colour"), [136, 136, 136]);
});

test("a part expands to five faces with distinct normals", () => {
  const project = makeProjector({ yaw: 0.7, pitch: 0.5, zoom: 40, panX: 0, panY: 0 }, 800, 600);
  const faces = partFaces({ position: [0, 1, 0], scale: [2, 2, 2], color: "#ffffff" }, [0, 0, 0], [1, 1, 1], project);
  assert.equal(faces.length, 5);
  assert.deepEqual(faces[0].normal, [0, 1, 0], "the first face is the top");
  assert.equal(new Set(faces.map((f) => f.normal.join(","))).size, 5, "every face needs its own normal");
  for (const f of faces) assert.equal(f.pts.length, 4);
});

test("a part's face centres follow the entity scale", () => {
  const project = makeProjector({ yaw: 0, pitch: 0, zoom: 1, panX: 0, panY: 0 }, 100, 100);
  const at1 = partFaces({ position: [0, 1, 0], scale: [1, 1, 1] }, [0, 0, 0], [1, 1, 1], project);
  const at2 = partFaces({ position: [0, 1, 0], scale: [1, 1, 1] }, [0, 0, 0], [2, 2, 2], project);
  assert.ok(Math.abs(at2[0].cy - at1[0].cy * 2) < 1e-9, "doubling the entity scale must double the height");
});
