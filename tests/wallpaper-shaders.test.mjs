/* Shader wallpapers as a node graph. The graph must resolve (every node a
 * recipe needs exists, each is emitted once, dependencies first), every recipe
 * must be wired into the wallpaper registry and name a real theme, and the
 * colour and sizing helpers must be exact — a NaN uniform blanks the desktop. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SHADER_NODES, SHADER_RECIPES, SHADER_WALLPAPER_IDS, VERTEX_SHADER,
  resolveNodes, composeFragment, hexToLinear, linearLuminance, backingSize,
  isShaderWallpaper, shaderRecipe,
} from "../.test-build/wallpaper-shaders.js";

const themesSrc = readFileSync(new URL("../src/kernel/themes.ts", import.meta.url), "utf8");
const themeIds = new Set([...themesSrc.matchAll(/^\s*t\(\s*"([a-z0-9]+)"/gm)].map((m) => m[1]));
const wallBlock = themesSrc.slice(themesSrc.indexOf("export const WALLPAPERS"), themesSrc.indexOf("] as const"));
const wallIds = new Set([...wallBlock.matchAll(/id:\s*"([^"]+)"/g)].map((m) => m[1]));

test("at least six shader wallpapers, unique ids", () => {
  assert.ok(SHADER_RECIPES.length >= 6);
  assert.equal(new Set(SHADER_WALLPAPER_IDS).size, SHADER_WALLPAPER_IDS.length);
});

test("every recipe is in the wallpaper registry and pairs with a real theme", () => {
  assert.ok(themeIds.size >= 50, "theme parser stopped matching");
  for (const r of SHADER_RECIPES) {
    assert.ok(wallIds.has(r.id), `${r.id} missing from WALLPAPERS`);
    assert.ok(themeIds.has(r.theme), `${r.id} pairs with unknown theme ${r.theme}`);
    const entry = new RegExp(`id:\\s*"${r.id}",\\s*name:\\s*"[^"]+",\\s*theme:\\s*"${r.theme}"`);
    assert.match(wallBlock, entry, `${r.id} registry entry disagrees with its recipe's theme`);
  }
});

test("resolveNodes: dependencies first, each node once", () => {
  const order = resolveNodes(["warp", "finish", "fbm"]);
  assert.equal(new Set(order).size, order.length);
  for (const id of order) {
    for (const dep of SHADER_NODES[id].deps) {
      assert.ok(order.indexOf(dep) < order.indexOf(id), `${dep} must precede ${id}`);
    }
  }
  assert.deepEqual(order.slice(0, 4), ["hash", "noise", "fbm", "warp"]);
});

test("resolveNodes rejects unknown nodes and cycles", () => {
  assert.throws(() => resolveNodes(["nope"]), /unknown shader node "nope"/);
  const cyc = { a: { id: "a", deps: ["b"], glsl: "" }, b: { id: "b", deps: ["a"], glsl: "" } };
  assert.throws(() => resolveNodes(["a"], cyc), /cycle: a -> b -> a/);
});

test("every recipe composes to one well-formed GLSL ES 3.00 shader", () => {
  for (const r of SHADER_RECIPES) {
    const src = composeFragment(r);
    assert.ok(src.startsWith("#version 300 es\n"), `${r.id}: #version must be the first line`);
    assert.equal((src.match(/void main\(\)/g) || []).length, 1, `${r.id}: exactly one main`);
    assert.match(src, /fragColor = finish\(/, `${r.id}: must end in the shared finish node`);
    const opens = (src.match(/\{/g) || []).length;
    const closes = (src.match(/\}/g) || []).length;
    assert.equal(opens, closes, `${r.id}: unbalanced braces`);
    // Every node function is declared once, however many recipes nodes share it.
    for (const fn of ["hash12", "gnoise", "fbm", "shoulder", "grain"]) {
      const decls = src.match(new RegExp(`\\b(?:float|vec2|vec3|vec4) ${fn}\\(`, "g")) || [];
      assert.ok(decls.length <= 1, `${r.id}: ${fn} declared ${decls.length} times`);
    }
    assert.ok(r.scale > 0 && r.scale <= 1, `${r.id}: render scale out of range`);
    assert.ok(!/[^\x00-\x7f]/.test(src), `${r.id}: GLSL must be ASCII`);
  }
});

test("recipes only call node functions they declared", () => {
  const provides = {
    gnoise: "noise", fbm: "fbm", warped: "warp", vnoise3: "noise3", stars: "stars",
    vignette: "vignette", themeRamp: "palette", saturation: "palette", finish: "finish",
    hash12: "hash", hash22: "hash", hash13: "hash",
  };
  for (const r of SHADER_RECIPES) {
    const pulled = new Set(resolveNodes(r.nodes));
    for (const [fn, node] of Object.entries(provides)) {
      if (new RegExp(`\\b${fn}\\(`).test(r.main)) assert.ok(pulled.has(node), `${r.id} calls ${fn} but does not pull node ${node}`);
    }
  }
});

test("derivatives are never taken inside a branch", () => {
  for (const r of SHADER_RECIPES) {
    for (const block of r.main.matchAll(/\bif\s*\([^)]*\)\s*\{([^}]*)\}/g)) {
      assert.ok(!/\b(fwidth|dFdx|dFdy)\(/.test(block[1]), `${r.id}: derivative inside a branch`);
    }
  }
});

test("vertex shader needs no attributes", () => {
  assert.match(VERTEX_SHADER, /gl_VertexID/);
  assert.ok(!/\bin\s+vec/.test(VERTEX_SHADER));
});

test("hexToLinear: sRGB decode, every CSS form the tokens use", () => {
  assert.deepEqual(hexToLinear("#000000"), [0, 0, 0]);
  assert.deepEqual(hexToLinear("#ffffff"), [1, 1, 1]);
  const [r] = hexToLinear("#808080");
  assert.ok(Math.abs(r - 0.2158605) < 1e-6);
  assert.deepEqual(hexToLinear("#fff"), [1, 1, 1]);
  assert.deepEqual(hexToLinear("rgb(255 255 255 / 0.8)"), [1, 1, 1]);
  assert.deepEqual(hexToLinear("rgba(0, 0, 0, 0.5)"), [0, 0, 0]);
  assert.deepEqual(hexToLinear("  #FFFFFF "), [1, 1, 1]);
  for (const bad of ["", "red", "#12", "var(--x)", "#gggggg"]) {
    const v = hexToLinear(bad);
    assert.ok(v.every(Number.isFinite), `${bad} produced a non-finite channel`);
  }
});

test("linearLuminance sorts dark themes from light ones", () => {
  assert.ok(linearLuminance(hexToLinear("#07111f")) < 0.18);
  assert.ok(linearLuminance(hexToLinear("#f7f4fb")) > 0.18);
});

test("backingSize: dpr capped, scaled, budgeted, never zero", () => {
  assert.deepEqual(backingSize(1440, 900, 1, 0.5), { width: 720, height: 450 });
  const big = backingSize(1440, 900, 3, 1);
  assert.ok(big.width * big.height <= 1_600_000);
  assert.ok(Math.abs(big.width / big.height - 1.6) < 0.01, "aspect must survive the budget clamp");
  assert.deepEqual(backingSize(0, 0, 2, 0.5), { width: 1, height: 1 });
  assert.deepEqual(backingSize(100, 100, NaN, 1), { width: 100, height: 100 });
  assert.deepEqual(backingSize(100, 100, 2, 1, { maxDpr: 2 }), { width: 200, height: 200 });
});

test("lookup helpers", () => {
  assert.ok(isShaderWallpaper("nebula"));
  assert.ok(!isShaderWallpaper("mesh"));
  assert.equal(shaderRecipe("ink")?.theme, "sumi");
  assert.equal(shaderRecipe("mesh"), undefined);
});
