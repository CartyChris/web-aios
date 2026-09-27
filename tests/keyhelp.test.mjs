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

/* ── the cheat sheet ─────────────────────────────────────────────────────── */

import { sheetRows, FIXED_SHORTCUTS } from "../.test-build/keyhelp.js";
import { readFileSync } from "node:fs";

test("sheet: editable rows are the live bindings, with conflicts flagged", () => {
  const { shell } = sheetRows({ "window.tile": "mod+shift+t", "shell.x": "shift+mod+t", "window.close": "mod+w", "off.one": "" }, [], "", true);
  assert.deepEqual(shell.map((r) => r.id), ["window.tile", "shell.x", "window.close"], "an unbound action is not listed as if it had keys");
  assert.deepEqual(shell.filter((r) => r.conflict).map((r) => r.id).sort(), ["shell.x", "window.tile"]);
});

test("sheet: a filter matches labels, places and the keys as shown", () => {
  const binds = { "window.tile": "mod+shift+t", "window.close": "mod+w" };
  const fixed = [{ where: "Terminal", keys: "ctrl+l", what: "Clear the screen" }];
  assert.deepEqual(sheetRows(binds, fixed, "tile", true).shell.map((r) => r.id), ["window.tile"]);
  assert.deepEqual(sheetRows(binds, fixed, "cmd shift", true).shell.map((r) => r.id), ["window.tile"], "Mac users search the keys they see");
  assert.deepEqual(sheetRows(binds, fixed, "cmd shift", false).shell, [], "and elsewhere it says Ctrl");
  assert.equal(sheetRows(binds, fixed, "terminal", true).apps.length, 1);
  assert.equal(sheetRows(binds, fixed, "nothing-like-this", true).apps.length, 0);
});

/* The sheet is only honest if the bindings it lists are the ones the shell
   handles. These read the source, so adding a binding without a handler (or a
   handler without a default binding) fails here instead of shipping a sheet
   that lists a key that does nothing. */
const settingsSrc = readFileSync(new URL("../src/kernel/settings.ts", import.meta.url), "utf8");
const desktopSrc = readFileSync(new URL("../src/shell/Desktop.tsx", import.meta.url), "utf8");
const defaults = [...settingsSrc.slice(settingsSrc.indexOf("DEFAULT_KEYBINDS")).split("};")[0].matchAll(/"([a-z]+\.[A-Za-z]+)":/g)].map((m) => m[1]);

test("sheet: every default binding has a handler in the shell", () => {
  assert.ok(defaults.length >= 14, `found ${defaults.length} default bindings`);
  for (const id of defaults) {
    assert.ok(desktopSrc.includes(`"${id}"`), `${id} has a default key but shell/Desktop.tsx never handles it`);
  }
});

test("sheet: every action the shell handles has a default binding", () => {
  const handled = [...desktopSrc.matchAll(/kb\["([a-z]+\.[A-Za-z]+)"\]|\["([a-z]+\.[A-Za-z]+)", \(\) =>/g)].map((m) => m[1] ?? m[2]);
  assert.ok(handled.length >= 14);
  for (const id of handled) assert.ok(defaults.includes(id), `shell/Desktop.tsx handles ${id} but it has no default binding`);
});

test("sheet: the fixed list covers the shell's hard-wired keys", () => {
  const text = FIXED_SHORTCUTS.map((f) => `${f.keys} ${f.what}`).join("\n");
  assert.match(text, /^\? /m, "? opens the sheet");
  assert.match(text, /mod\+1 .*workspace/i);
  assert.match(text, /mod\+alt\+1 .*layout/i);
  assert.match(text, /mod\+shift\+` .*backwards/i, "shift reverses window cycling, and the sheet says so");
});

import { chordMatches } from "../.test-build/keyhelp.js";

const press = (key, mods = {}, code) => ({ key, code, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });

test("chords: exact modifiers, mod means Cmd or Ctrl, named keys", () => {
  assert.ok(chordMatches(press("k", { metaKey: true }), "mod+k"));
  assert.ok(chordMatches(press("k", { ctrlKey: true }), "mod+k"));
  assert.ok(!chordMatches(press("k", { metaKey: true, shiftKey: true }), "mod+k"), "an extra Shift is a different chord");
  assert.ok(chordMatches(press("ArrowLeft", { metaKey: true, altKey: true }), "mod+alt+left"));
  assert.ok(chordMatches(press("T", { metaKey: true, shiftKey: true }), "mod+shift+t"));
});

test("chords: Shift+` reports '~', and still matches the backquote key when Shift is allowed", () => {
  const backwards = press("~", { metaKey: true, shiftKey: true }, "Backquote");
  assert.ok(!chordMatches(backwards, "mod+`"), "without allowShift, the old behaviour");
  assert.ok(chordMatches(backwards, "mod+`", true));
  assert.ok(chordMatches(press("`", { metaKey: true }, "Backquote"), "mod+`", true), "forwards still works");
  assert.ok(chordMatches(press("/", { metaKey: true }, "Slash"), "mod+/"));
});
