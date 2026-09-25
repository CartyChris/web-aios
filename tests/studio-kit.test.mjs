/**
 * AI Studio build loop: the console bridge (a trust boundary), the repair
 * prompt, the line diff and per-build version history.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  TEMPLATES, injectBridge, readBridge, pushConsole, fixPrompt, errorCount,
  lineDiff, diffStats, hunks, pushBuildVersion, changedPath, BRIDGE_KEY,
} from "../.test-build/studio-kit.js";
import { TARGETS } from "../.test-build/scaffold.js";

test("every template names a real build target", () => {
  const ids = new Set(TARGETS.map((t) => t.id));
  for (const t of TEMPLATES) assert.ok(ids.has(t.target), `${t.id} -> ${t.target}`);
});

test("the bridge goes first inside <head>, addressed to the parent origin only", () => {
  const out = injectBridge("<!doctype html><html><head><title>x</title></head><body></body></html>", "tok1", "https://os.example");
  const i = out.indexOf("<script>");
  assert.ok(i > out.indexOf("<head>") && i < out.indexOf("<title>"));
  assert.ok(out.includes('"o":"https://os.example"'));
  assert.ok(out.includes('"t":"tok1"'));
  // No head: after <html>. Nothing at all: prepended.
  assert.ok(injectBridge("<html><body>x</body></html>", "t", "o").startsWith("<html><script>"));
  assert.ok(injectBridge("<p>x</p>", "t", "o").startsWith("<script>"));
});

test("a token cannot break out of the bridge script", () => {
  const out = injectBridge("<head></head>", "</script><script>alert(1)</script>", "o");
  assert.equal(out.split("</script>").length - 1, 1, "only the bridge's own closing tag");
});

test("readBridge accepts only this run's token and a known level", () => {
  assert.deepEqual(readBridge({ [BRIDGE_KEY]: "t", level: "error", text: "boom" }, "t"), { level: "error", text: "boom" });
  assert.equal(readBridge({ [BRIDGE_KEY]: "other", level: "error", text: "x" }, "t"), null);
  assert.equal(readBridge({ [BRIDGE_KEY]: "t", level: "alert", text: "x" }, "t"), null);
  assert.equal(readBridge({ [BRIDGE_KEY]: "", level: "error" }, ""), null, "an empty token never matches");
  assert.equal(readBridge("error", "t"), null);
  assert.equal(readBridge({ __preview: "error", message: "x" }, "t"), null);
});

test("pushConsole folds repeats and keeps the newest", () => {
  let l = [];
  for (let i = 0; i < 60; i++) l = pushConsole(l, { level: "error", text: "frame" });
  assert.equal(l.length, 1);
  assert.equal(l[0].count, 60);
  for (let i = 0; i < 10; i++) l = pushConsole(l, { level: "log", text: `n${i}` }, 5);
  assert.deepEqual(l.map((e) => e.text), ["n5", "n6", "n7", "n8", "n9"]);
});

test("fixPrompt lists distinct errors, adds warnings as context, and is empty without errors", () => {
  assert.equal(fixPrompt([{ level: "warn", text: "w" }, { level: "log", text: "l" }]), "");
  const p = fixPrompt([
    { level: "error", text: "TypeError: x is undefined" },
    { level: "error", text: "TypeError: x is undefined" },
    { level: "warn", text: "deprecated" },
    { level: "error", text: "ReferenceError: y" },
  ]);
  assert.match(p, /these 2 errors/);
  assert.equal(p.match(/TypeError/g).length, 1);
  assert.match(p, /Warnings that may be related:\n- deprecated/);
  assert.equal(errorCount([{ level: "error", text: "a" }, { level: "warn", text: "b" }]), 1);
});

test("lineDiff is a real diff: an insertion is one added line, not a rewrite", () => {
  const a = "a\nb\nc\nd";
  const b = "a\nb\nX\nc\nd";
  const d = lineDiff(a, b);
  assert.deepEqual(diffStats(d), { added: 1, removed: 0 });
  assert.deepEqual(d.find((l) => l.op === "add"), { op: "add", text: "X" });
  // Replaying the diff reproduces both sides.
  assert.equal(d.filter((l) => l.op !== "add").map((l) => l.text).join("\n"), a);
  assert.equal(d.filter((l) => l.op !== "del").map((l) => l.text).join("\n"), b);
});

test("lineDiff on a moved line counts one add and one delete", () => {
  const d = lineDiff("1\n2\n3\n4", "2\n3\n4\n1");
  assert.deepEqual(diffStats(d), { added: 1, removed: 1 });
});

test("hunks keeps context around changes and marks gaps", () => {
  const a = Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n");
  const b = a.replace("l15", "CHANGED");
  const h = hunks(lineDiff(a, b), 1);
  assert.equal(h[0].op, "gap");
  assert.equal(h[0].skipped, 14);
  assert.deepEqual(h.slice(1, 5).map((x) => x.op), ["same", "del", "add", "same"]);
  assert.equal(h[h.length - 1].op, "gap");
});

test("pushBuildVersion skips no-op versions and pins the first under the cap", () => {
  const v = (id, c) => ({ id, at: 0, label: id, files: [{ path: "index.html", content: c }] });
  let list = pushBuildVersion([], v("v1", "a"));
  list = pushBuildVersion(list, v("v1b", "a"));
  assert.equal(list.length, 1, "identical content is not a new step");
  for (let i = 2; i <= 10; i++) list = pushBuildVersion(list, v(`v${i}`, `c${i}`), 4);
  assert.deepEqual(list.map((x) => x.id), ["v1", "v8", "v9", "v10"]);
});

test("changedPath prefers index.html and sees removed files", () => {
  const A = [{ path: "a.js", content: "1" }, { path: "index.html", content: "x" }];
  assert.equal(changedPath(A, [{ path: "a.js", content: "2" }, { path: "index.html", content: "y" }]), "index.html");
  assert.equal(changedPath(A, [{ path: "a.js", content: "2" }, { path: "index.html", content: "x" }]), "a.js");
  assert.equal(changedPath(A, [{ path: "index.html", content: "x" }]), "a.js");
  assert.equal(changedPath(A, A), null);
});
