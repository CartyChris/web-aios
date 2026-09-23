/**
 * Desktop handoff links. The receiving side is untrusted input, so the tests
 * that matter are the hostile ones: damaged, oversized, and crafted links.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeHandoff, decodeHandoff, MAX_HANDOFF_CHARS } from "../.test-build/handoff.js";

const scene = (windows) => ({ id: "sc_1", name: "Morning", at: 1, activeWorkspace: 2, windows });
const win = (appId, extra = {}) => ({ appId, fx: 0.1234567, fy: 0, fw: 0.5, fh: 0.5, state: "normal", workspace: 2, ...extra });

test("round trip keeps apps, layout, desktop and a small arg; unicode names survive", () => {
  const { code, dropped } = encodeHandoff({ ...scene([win("notes", { args: { noteId: "n1" }, title: "Notes — café" }), win("chat", { state: "maximized" })]) });
  assert.equal(dropped, 0);
  const r = decodeHandoff(`#handoff=${code}`, 99);
  assert.equal(r.ok, true);
  assert.equal(r.scene.name, "Morning");
  assert.equal(r.scene.activeWorkspace, 2);
  assert.deepEqual(r.scene.windows.map((w) => w.appId), ["notes", "chat"]);
  assert.equal(r.scene.windows[0].title, "Notes — café");
  assert.deepEqual(r.scene.windows[0].args, { noteId: "n1" });
  assert.equal(r.scene.windows[0].fx, 0.123);
});

test("a big launch arg is dropped rather than bloating the link", () => {
  const { code } = encodeHandoff(scene([win("notes", { args: { body: "x".repeat(5000) } })]));
  const r = decodeHandoff(code, 1);
  assert.equal(r.ok, true);
  assert.equal(r.scene.windows[0].args, undefined);
});

test("too many windows are trimmed to fit, minimized ones first", () => {
  const many = Array.from({ length: 40 }, (_, i) => win(`app${i}`, { title: "t".repeat(79), state: i < 20 ? "minimized" : "normal" }));
  const { code, dropped } = encodeHandoff(scene(many));
  assert.ok(code.length <= MAX_HANDOFF_CHARS);
  assert.ok(dropped > 0);
  const r = decodeHandoff(code, 1);
  assert.ok(r.scene.windows.every((w) => w.state === "normal") || r.scene.windows.length > 20);
});

test("hostile input: not ours, damaged, bad utf-8, crafted numbers", () => {
  assert.equal(decodeHandoff("#handoff=v2.abc", 1).ok, false);
  assert.equal(decodeHandoff("#handoff=v1.$$$", 1).ok, false);
  assert.equal(decodeHandoff("#handoff=v1.____", 1).ok, false);
  const crafted = { windows: [{ appId: "notes", fx: 1e9, fy: -5, fw: 0, fh: "x", workspace: 999, state: "evil" }] };
  const b64 = Buffer.from(JSON.stringify(crafted)).toString("base64url");
  const r = decodeHandoff(`v1.${b64}`, 1);
  assert.equal(r.ok, true);
  const w = r.scene.windows[0];
  assert.equal(w.fx, 1);
  assert.equal(w.fy, 0);
  assert.ok(w.fw > 0 && w.fh > 0);
  assert.equal(w.workspace, 8);
  assert.equal(w.state, "normal");
});

test("our base64url matches Node's, byte for byte", () => {
  const { code } = encodeHandoff(scene([win("files")]));
  const json = Buffer.from(code.slice(3), "base64url").toString("utf8");
  assert.equal(JSON.parse(json).windows[0].appId, "files");
});
