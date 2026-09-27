/* The iOS 26 installed-web-app gap: when to stretch, and when not to. */
import test from "node:test";
import assert from "node:assert/strict";
import { diagnoseViewport, orientedScreenHeight, STATUS_BAR_META, isStatusBarPref } from "../.test-build/viewport-fit.js";

// iPhone Air in portrait: 420 x 912 CSS px, a 62px status bar area.
const air = { screenW: 420, screenH: 912, innerW: 420, innerH: 850, safeTop: 62, safeBottom: 34, standalone: true, ios: true, statusBar: "translucent" };

test("the iOS 26 signature: short by exactly the top inset, translucent bar", () => {
  const v = diagnoseViewport(air);
  assert.equal(v.kind, "ios-top-inset-gap");
  assert.equal(v.gap, 62);
  assert.equal(v.fillHeight, 912, "stretch to the whole screen");
  assert.match(v.advice, /Solid/);
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
  const v = diagnoseViewport({ ...air, statusBar: "solid" });
  assert.notEqual(v.kind, "ios-top-inset-gap");
  assert.equal(v.fillHeight, null);
});

test("a gap that is not the inset is reported, not papered over", () => {
  const v = diagnoseViewport({ ...air, innerH: 800 });
  assert.equal(v.kind, "short");
  assert.equal(v.gap, 112);
  assert.equal(v.fillHeight, null);
});

test("landscape uses the short side of the screen", () => {
  assert.equal(orientedScreenHeight({ screenW: 420, screenH: 912, innerW: 912, innerH: 400 }), 420);
  assert.equal(orientedScreenHeight({ screenW: 420, screenH: 912, innerW: 420, innerH: 850 }), 912);
  // Landscape iPhone: the top inset is 0, so no signature; must not stretch.
  assert.equal(diagnoseViewport({ ...air, innerW: 912, innerH: 400, safeTop: 0 }).fillHeight, null);
});

test("status-bar preference maps to the Apple meta values", () => {
  assert.equal(STATUS_BAR_META.translucent, "black-translucent");
  assert.equal(STATUS_BAR_META.solid, "black");
  assert.ok(isStatusBarPref("solid"));
  assert.ok(!isStatusBarPref("default"));
});
