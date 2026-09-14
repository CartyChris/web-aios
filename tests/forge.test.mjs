/**
 * Parsing what a model returns, and the particle simulation.
 *
 * Both fail quietly when they are wrong. A JSON extractor that gives up on a
 * reply with prose around it looks like "the model failed"; a particle system
 * that applies gravity per frame instead of per second looks like "the effect
 * is a bit fast" on one machine and broken on another.
 *
 * The lighting and projection tests that used to live here went with the
 * software rasteriser they covered — the GPU does that now, and what replaced
 * them is in forge3d.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJson } from "../.test-build/forge-schema.js";
import { stepParticles } from "../.test-build/forge-render.js";

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
