/**
 * The in-browser project linker.
 *
 * This is what makes "generate a React app" produce something you can look at
 * instead of a folder you have to npm install. The failure mode it guards
 * against is silent: a missing import-map entry does not error, it just leaves
 * a blank white iframe.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPreview } from "../.test-build/preview.js";

const f = (path, content) => ({ path, content });
const importMapOf = (html) => JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]).imports;

test("a single HTML document previews as itself", () => {
  const html = "<!doctype html><html><body>hi</body></html>";
  const out = buildPreview([f("index.html", html)], "single-html");
  assert.equal(out.html, html);
});

test("a React project is linked, and react-dom is pinned to share one React", () => {
  const out = buildPreview([
    f("index.html", '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>'),
    f("src/main.tsx", 'import { createRoot } from "react-dom/client";\nimport App from "./App";\ncreateRoot(document.getElementById("root")).render(<App />);'),
    f("src/App.tsx", 'export default function App() { return <h1>hi</h1>; }'),
  ], "vite-react");

  assert.ok(out.html, out.reason);
  const map = importMapOf(out.html);
  // Without ?external=react, esm.sh serves react-dom its own React copy and
  // every hook throws "invalid hook call" in a project that is perfectly fine.
  assert.match(map["react-dom/client"], /external=react/);
  assert.ok(map["react/jsx-runtime"], "Babel's automatic runtime import must be mapped");
  assert.match(out.html, /window\.__ENTRY = "src\/main\.tsx"/);
  assert.ok(out.html.includes('"src/App.tsx"'), "every source file must be shipped into the frame");
});

test("the project's own body markup survives, but its module script does not", () => {
  const out = buildPreview([
    f("index.html", '<!doctype html><html><body><main id="app">placeholder</main><script type="module" src="/src/main.ts"></script></body></html>'),
    f("src/main.ts", 'document.querySelector("#app").textContent = "ready";'),
  ], "vite-vanilla");
  assert.match(out.html, /<main id="app">placeholder<\/main>/);
  assert.ok(!out.html.includes('src="/src/main.ts"'), "the original entry script must be removed — the loader replaces it");
});

test("three.js and its addon path both resolve to the same pinned version", () => {
  const out = buildPreview([
    f("index.html", '<!doctype html><html><body><script type="module" src="/src/main.ts"></script></body></html>'),
    f("src/main.ts", 'import * as THREE from "three";\nimport { OrbitControls } from "three/addons/controls/OrbitControls.js";'),
  ], "three-scene");
  const map = importMapOf(out.html);
  const version = map.three.match(/three@([\d.]+)/)[1];
  assert.ok(map["three/addons/controls/OrbitControls.js"].includes(`three@${version}`), "the addon must not pull a second copy of three");
});

test("an unpinned bare dependency still gets a CDN entry", () => {
  const out = buildPreview([
    f("index.html", '<html><body><script type="module" src="/src/main.ts"></script></body></html>'),
    f("src/main.ts", 'import confetti from "canvas-confetti";'),
  ], "vite-vanilla");
  assert.equal(importMapOf(out.html)["canvas-confetti"], "https://esm.sh/canvas-confetti");
});

test("node: built-ins are never mapped — they would 404 and take the page down", () => {
  const out = buildPreview([
    f("index.html", '<html><body><script type="module" src="/src/main.ts"></script></body></html>'),
    f("src/main.ts", 'import fs from "node:fs";\nimport x from "lodash";'),
  ], "vite-vanilla");
  const map = importMapOf(out.html);
  assert.ok(!("node:fs" in map));
  assert.ok("lodash" in map);
});

test("a Next.js app gets a synthesised entry that mounts its page", () => {
  const out = buildPreview([
    f("app/page.tsx", "export default function Page() { return <div>home</div>; }"),
  ], "next-app");
  assert.ok(out.html, out.reason);
  assert.match(out.html, /window\.__ENTRY = "__preview_entry\.tsx"/);
  assert.ok(out.html.includes("app/page.tsx"), "the synthesised entry must import the real page");
});

test("targets with no browser runtime explain themselves instead of rendering blank", () => {
  for (const [target, pattern] of [["node-api", /Node/], ["python-api", /Python|uvicorn/], ["cli", /command-line/], ["godot", /Godot/], ["unity", /Unity/], ["unreal", /Unreal/]]) {
    const out = buildPreview([f("README.md", "x")], target);
    assert.ok(!out.html, `${target} must not claim a preview`);
    assert.match(out.reason, pattern);
  }
});

test("a project with no source files says so rather than producing an empty frame", () => {
  const out = buildPreview([f("README.md", "nothing here")], "vite-react");
  assert.ok(!out.html);
  assert.match(out.reason, /No source files/);
});

test("the generated document escapes a closing script tag hidden in source", () => {
  // A generated file containing </script> inside a string would otherwise end
  // the loader's own script tag early and break the whole page.
  const out = buildPreview([
    f("index.html", '<html><body><script type="module" src="/src/main.ts"></script></body></html>'),
    f("src/main.ts", 'const evil = "</script><h1>escaped</h1>";'),
  ], "vite-vanilla");
  assert.ok(!out.html.includes('"</script><h1>escaped</h1>"'), "the raw sequence must not survive into the document");
  assert.ok(out.html.includes("<\\/script>"), "it should be escaped, not dropped");
});
