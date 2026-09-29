/* The boot script in app/layout.tsx decides the Apple status-bar tag before
   first paint, and iOS freezes whatever it sees when the app is added to the
   Home Screen. So what it writes for each saved setting is pinned here, by
   running the real script against stand-in globals. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { STATUS_BAR_META } from "../.test-build/viewport-fit.js";

const src = readFileSync(new URL("../src/app/layout.tsx", import.meta.url), "utf8");
const script = /const BOOT_SCRIPT = `([^`]*)`/.exec(src)?.[1];

function boot(saved, { standalone = true } = {}) {
  const head = [];
  const root = { dataset: {} };
  const document = { documentElement: root, head: { appendChild: (m) => head.push(m) }, createElement: () => ({}) };
  const navigator = { standalone };
  const matchMedia = () => ({ matches: false });
  const localStorage = { getItem: () => (saved === undefined ? null : saved) };
  new Function("document", "navigator", "matchMedia", "localStorage", script)(document, navigator, matchMedia, localStorage);
  return { metas: head.filter((m) => m.name === "apple-mobile-web-app-status-bar-style"), root };
}
const saved = (statusBar) => JSON.stringify({ state: { statusBar } });

test("the boot script is found", () => assert.ok(script && script.length > 50));

test("a first visit (nothing saved) gets the opaque bar that fills the screen", () => {
  const { metas } = boot(undefined);
  assert.equal(metas.length, 1, "exactly one tag, or iOS picks one");
  assert.equal(metas[0].content, "default");
  assert.equal(metas[0].content, STATUS_BAR_META.solid);
});

test("each saved choice writes its Apple value", () => {
  assert.equal(boot(saved("solid")).metas[0].content, STATUS_BAR_META.solid);
  assert.equal(boot(saved("translucent")).metas[0].content, STATUS_BAR_META.translucent);
  assert.equal(boot(saved("translucent")).metas[0].content, "black-translucent");
});

test("garbage in storage falls back to the opaque bar, never throws", () => {
  assert.equal(boot("{not json").metas[0].content, "default");
  assert.equal(boot(saved("purple")).metas[0].content, "default");
  assert.equal(boot(JSON.stringify({ state: null })).metas[0].content, "default");
});

test("an installed app is marked before paint", () => {
  assert.equal(boot(undefined).root.dataset.displayMode, "standalone");
  assert.equal(boot(undefined, { standalone: false }).root.dataset.displayMode, "browser");
});
