/* Customizations: validated values, the day/night rule, and a ThreeUI
 * catalogue that names only components the installed package really has. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normaliseCustomize, themeForHour, iconRadius, SOUND_SETS, THREE_WALLPAPERS, threeProps, CUSTOMIZE_DEFAULTS } from "../.test-build/customize.js";

test("junk settings become defaults, values are clamped", () => {
  assert.deepEqual(normaliseCustomize(null), CUSTOMIZE_DEFAULTS);
  const c = normaliseCustomize({ screenFx: { grain: 9, vignette: -1, scanlines: "yes", tint: "red" }, cursorFx: "fireworks", windowAnim: "genie", uiVolume: 3, threeWallpaper: { id: "nope", speed: 99, hue: -999 } });
  assert.deepEqual(c.screenFx, { grain: 1, vignette: 0, scanlines: false, tint: null });
  assert.equal(c.cursorFx, "off");
  assert.equal(c.windowAnim, "genie");
  assert.equal(c.uiVolume, 1);
  assert.deepEqual(c.threeWallpaper, { id: "constellation", speed: 3, hue: -180 });
  assert.equal(normaliseCustomize({ autoTheme: { on: true, day: "ghost" } }, ["aurora", "paper"]).autoTheme.day, "aurora", "unknown themes fall back");
});

test("day/night: plain days, nights that wrap midnight, and equal starts", () => {
  const a = { on: true, day: "paper", night: "midnight", dayStart: 7, nightStart: 19 };
  assert.equal(themeForHour(6, a), "midnight");
  assert.equal(themeForHour(7, a), "paper");
  assert.equal(themeForHour(18, a), "paper");
  assert.equal(themeForHour(19, a), "midnight");
  assert.equal(themeForHour(0, a), "midnight");
  const owl = { ...a, dayStart: 20, nightStart: 4 };
  assert.equal(themeForHour(23, owl), "paper", "a 'day' from 20:00 to 04:00 wraps midnight");
  assert.equal(themeForHour(3, owl), "paper");
  assert.equal(themeForHour(12, owl), "midnight");
  assert.equal(themeForHour(12, { ...a, dayStart: 9, nightStart: 9 }), "paper");
});

test("icon shapes and sound sets are complete", () => {
  assert.equal(iconRadius("circle"), "50%");
  for (const set of Object.values(SOUND_SETS)) for (const ev of ["open", "close", "notify", "error", "click"]) {
    assert.ok(set[ev].length >= 1);
    for (const t of set[ev]) assert.ok(t.freq > 20 && t.freq < 20000 && t.ms > 0 && t.ms <= 400 && t.gain > 0 && t.gain <= 0.3);
  }
});

test("every ThreeUI wallpaper names a component the installed package exports, with no iframe or asset dependency", () => {
  const root = fileURLToPath(new URL("../node_modules/@designcodeio/threeui/lib-dist/", import.meta.url));
  const ids = new Set();
  for (const w of THREE_WALLPAPERS) {
    assert.ok(!ids.has(w.id), `duplicate ${w.id}`);
    ids.add(w.id);
    const entry = `${root}package-components/${w.component}.js`;
    assert.ok(existsSync(entry), `${w.component} is not in the package`);
    const target = /from "\.\.\/([^"]+)"/.exec(readFileSync(entry, "utf8"))[1];
    const src = readFileSync(`${root}${target}`, "utf8");
    assert.ok(!/<iframe|"iframe"|assets\//.test(src), `${w.component} needs iframes or assets`);
    if (w.variant) assert.ok(src.includes(`"${w.variant}"`), `${w.component} has no variant ${w.variant}`);
    for (const prop of [w.speed, w.hue].filter(Boolean)) {
      // The CRT component takes its options type from its renderer module.
      const dts = readFileSync(`${root}${target.replace(/\.js$/, ".d.ts")}`, "utf8") + (w.component === "CrtBackground" ? readFileSync(`${root}shaders/crt/crtRenderer.d.ts`, "utf8") : "");
      assert.match(dts, new RegExp(`\\b${prop}\\??:`), `${w.component} has no prop ${prop}`);
    }
  }
  assert.deepEqual(threeProps(THREE_WALLPAPERS.find((w) => w.id === "liquid-form"), { id: "liquid-form", speed: 2, hue: 40 }), { speed: 2, tintHue: 40 });
  assert.deepEqual(threeProps(THREE_WALLPAPERS[0], { id: "constellation", speed: 2, hue: 40 }), { variant: "constellation-field" });
});
