/* Settings: chord display, conflicts, and settings search. */
import test from "node:test";
import assert from "node:assert/strict";
import { chordKeys, normalizeChord, findConflicts, actionLabel, searchSettings } from "../.test-build/keyhelp.js";

test("chords display per platform", () => {
  assert.deepEqual(chordKeys("mod+shift+t", true), ["Cmd", "Shift", "T"]);
  assert.deepEqual(chordKeys("mod+alt+left", false), ["Ctrl", "Alt", "Left"]);
  assert.deepEqual(chordKeys("mod+space", true), ["Cmd", "Space"]);
  assert.deepEqual(chordKeys("mod++", false), ["Ctrl", "+"]);
});

test("conflicts ignore modifier order", () => {
  assert.equal(normalizeChord("shift+mod+T"), "mod+shift+t");
  const c = findConflicts({ "a.x": "mod+k", "b.y": "mod+j", "c.z": "MOD+K" });
  assert.deepEqual(c, [{ chord: "mod+k", actions: ["a.x", "c.z"] }]);
  assert.deepEqual(findConflicts({ a: "mod+k", b: "mod+shift+k" }), []);
});

test("action labels", () => {
  assert.equal(actionLabel("window.snapLeft"), "Window: snap left");
  assert.equal(actionLabel("palette.open"), "Palette: open");
});

test("settings search needs every word, and ranks label hits first", () => {
  const idx = [
    { tab: "keys", tabLabel: "Keyboard", label: "Shortcuts", keywords: "keybinds hotkeys" },
    { tab: "ai", tabLabel: "AI", label: "Budget", keywords: "spend cost limit usd" },
    { tab: "privacy", tabLabel: "Privacy", label: "Clear spend history", keywords: "budget" },
  ];
  assert.deepEqual(searchSettings(idx, "budget").map((e) => e.label), ["Budget", "Clear spend history"]);
  assert.deepEqual(searchSettings(idx, "hotkeys").map((e) => e.tab), ["keys"]);
  assert.deepEqual(searchSettings(idx, "budget keyboard"), []);
  assert.deepEqual(searchSettings(idx, "  "), []);
});
