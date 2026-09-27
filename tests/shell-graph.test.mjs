/* What the shell loads before anything is opened.
 *
 * Measured 2026-09-26 in a production build with no windows open: startup
 * JavaScript was 338 KB gzipped, of which the DeepSeek Harness runtime, the
 * service catalogue and the Desk app were pulled in only because the shell
 * imported them statically. Loading them on first use took it to 276 KB.
 *
 * These tests walk the STATIC import graph from shell/Desktop.tsx (dynamic
 * import() and type-only imports are not edges) and fail if any of them comes
 * back, so a convenient top-level import cannot quietly undo that.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not .pathname: this repo lives under a folder with spaces.
const root = fileURLToPath(new URL("..", import.meta.url));

function resolve(from, spec) {
  let base;
  if (spec.startsWith("@/")) base = join(root, "src", spec.slice(2));
  else if (spec.startsWith(".")) base = normalize(join(dirname(from), spec));
  else return null;
  for (const ext of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    const p = base + ext;
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

const IMPORT = /^\s*(import|export)\s+(?!type\b)(?:[^;]*?\s+from\s+)?["']([^"']+)["']/gm;

function staticGraph(entry) {
  const seen = new Map([[entry, null]]);
  const queue = [entry];
  while (queue.length) {
    const f = queue.shift();
    for (const m of readFileSync(f, "utf8").matchAll(IMPORT)) {
      const r = resolve(f, m[2]);
      if (r && !seen.has(r)) { seen.set(r, f); queue.push(r); }
    }
  }
  return seen;
}

const graph = staticGraph(join(root, "src/shell/Desktop.tsx"));
const rel = (p) => p.slice(root.length);
const chain = (p) => { const out = []; for (let f = p; f; f = graph.get(f)) out.push(rel(f)); return out.join(" <- "); };

test("the graph walk sees the shell (sanity: it can find what IS imported)", () => {
  assert.ok(graph.size > 40, `only ${graph.size} modules`);
  assert.ok([...graph.keys()].some((f) => f.endsWith("src/kernel/wm.ts")));
  assert.ok([...graph.keys()].some((f) => f.endsWith("src/lib/harness-triggers.ts")), "the trigger runner itself stays at boot");
});

const MUST_BE_LAZY = [
  ["src/lib/harness-runtime.ts", "the harness runtime (loaded when a trigger fires)"],
  ["src/lib/harness/loop.ts", "the harness loop"],
  ["src/lib/harness/tools.ts", "the harness tools"],
  ["src/lib/harness/fixtures.ts", "the harness fixtures"],
  ["src/lib/services.ts", "the service catalogue (loaded with a data widget)"],
  ["src/shell/ThreeUIWallpaper.tsx", "the ThreeUI wallpapers and three.js (loaded when chosen)"],
  ["src/lib/office/formula.ts", "the office suite (loaded when an office app opens)"],
];

for (const [file, what] of MUST_BE_LAZY) {
  test(`startup does not statically import ${what}`, () => {
    const hit = [...graph.keys()].find((f) => f.endsWith(file));
    assert.equal(hit, undefined, hit && `imported at startup via ${chain(hit)}`);
  });
}

test("startup does not statically import any app (apps load when opened)", () => {
  const apps = [...graph.keys()].filter((f) => rel(f).startsWith("src/apps/"));
  assert.deepEqual(apps.map(chain), []);
});
