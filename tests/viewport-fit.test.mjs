/* The iOS 26+ installed-web-app gap: recognising it, and never stretching over
   it. The numbers are the ones measured on the iOS 27 iPhone Air simulator
   with a probe page (lib/viewport-fit.ts header). */
import test from "node:test";
import assert from "node:assert/strict";
import { diagnoseViewport, orientedScreenHeight, STATUS_BAR_META, isStatusBarPref, DEFAULT_STATUS_BAR } from "../.test-build/viewport-fit.js";

// iPhone Air in portrait: 420 x 912 CSS px, a 62px status bar area.
const air = { screenW: 420, screenH: 912, innerW: 420, innerH: 850, safeTop: 62, safeBottom: 34, standalone: true, ios: true, statusBar: "translucent" };

test("the iOS 26 signature: short by exactly the top inset, translucent bar", () => {
  const v = diagnoseViewport(air);
  assert.equal(v.kind, "ios-top-inset-gap");
  assert.equal(v.gap, 62);
  // The band is outside what the page can draw: stretching into it only hid
  // the bottom of the OS. Measured: a 100lvh element stopped at 844 of 912.
  assert.equal(v.fillHeight, null, "never stretch");
  assert.equal(v.reinstall, true);
  assert.match(v.advice, /Standard/);
  assert.match(v.advice, /add it again/);
});

test("measured, see-through bar: 844 of 912 with a 68px inset", () => {
  const v = diagnoseViewport({ ...air, innerH: 844, safeTop: 68 });
  assert.equal(v.kind, "ios-top-inset-gap");
  assert.equal(v.gap, 68);
  assert.equal(v.fillHeight, null);
});

test("measured, opaque bar: 844 of 912 with no inset is the app filling the screen", () => {
  const v = diagnoseViewport({ ...air, innerH: 844, safeTop: 0, statusBar: "solid" });
  assert.equal(v.kind, "status-bar");
  assert.equal(v.gap, 68);
  assert.equal(v.reinstall, false);
});

test("the style is frozen at install: Standard chosen, but the numbers say see-through", () => {
  const v = diagnoseViewport({ ...air, innerH: 844, safeTop: 68, statusBar: "solid" });
  assert.equal(v.kind, "ios-top-inset-gap", "decided from the numbers, not from the setting");
  assert.equal(v.reinstall, true);
  assert.match(v.advice, /Remove Web-AIOS from the Home Screen/);
  assert.doesNotMatch(v.advice, /Choose Standard/, "the setting is already right; only a re-add helps");
});

test("a full-height report needs nothing", () => {
  const v = diagnoseViewport({ ...air, innerH: 912 });
  assert.equal(v.kind, "fits");
  assert.equal(v.fillHeight, null);
});

test("a browser tab is never stretched: its toolbars are real", () => {
  const v = diagnoseViewport({ ...air, standalone: false, innerH: 700 });
  assert.equal(v.kind, "browser-tab");
  assert.equal(v.fillHeight, null);
});

test("a window smaller than the screen is not stretched (iPad Stage Manager, desktop PWA)", () => {
  assert.equal(diagnoseViewport({ ...air, screenW: 1024, screenH: 1366, innerW: 700, innerH: 900, safeTop: 24 }).kind, "windowed");
  assert.equal(diagnoseViewport({ ...air, ios: false, screenW: 1920, screenH: 1080, innerW: 1200, innerH: 800, safeTop: 0 }).kind, "windowed");
  assert.equal(diagnoseViewport({ ...air, screenW: 1024, screenH: 1366, innerW: 700, innerH: 900 }).fillHeight, null);
});

test("with the solid bar the same gap is expected (the bar takes it), so no stretch", () => {
  const v = diagnoseViewport({ ...air, statusBar: "solid", safeTop: 0 });
  assert.notEqual(v.kind, "ios-top-inset-gap");
  assert.equal(v.kind, "status-bar");
  assert.equal(v.fillHeight, null);
});

test("a gap that is not the inset is reported, not papered over", () => {
  const v = diagnoseViewport({ ...air, innerH: 800 });
  assert.equal(v.kind, "short");
  assert.equal(v.gap, 112);
  assert.equal(v.fillHeight, null);
  assert.equal(v.reinstall, true);
});

test("an opaque-bar gap taller than any status bar is still reported", () => {
  assert.equal(diagnoseViewport({ ...air, innerH: 812, safeTop: 0 }).kind, "short");
});

test("landscape uses the short side of the screen", () => {
  assert.equal(orientedScreenHeight({ screenW: 420, screenH: 912, innerW: 912, innerH: 400 }), 420);
  assert.equal(orientedScreenHeight({ screenW: 420, screenH: 912, innerW: 420, innerH: 850 }), 912);
  // Landscape iPhone: the top inset is 0, so no signature; must not stretch.
  assert.equal(diagnoseViewport({ ...air, innerW: 912, innerH: 400, safeTop: 0 }).fillHeight, null);
});

test("status-bar preference maps to the Apple meta values", () => {
  assert.equal(STATUS_BAR_META.translucent, "black-translucent");
  // Apple's opaque "default" bar is the one measured to leave no gap.
  assert.equal(STATUS_BAR_META.solid, "default");
  assert.equal(DEFAULT_STATUS_BAR, "solid", "new installs fill the screen");
  assert.ok(isStatusBarPref("solid"));
  assert.ok(!isStatusBarPref("default"));
});
