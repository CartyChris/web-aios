/* Phone view versus full desktop.
 *
 * The bug this pins: a phone on its side is still under 768px wide, so a pure
 * width rule never gave it the desktop. The short side identifies a phone;
 * orientation says which shell it wants.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chooseShell, offerPhoneView, isPhoneHardware, shortSide, isPhoneMode } from "../.test-build/shell-mode.js";

const PORTRAIT = { w: 402, h: 874, touch: true };   // iPhone upright
const LANDSCAPE = { w: 874, h: 402, touch: true };  // same phone on its side
const SMALL_LAND = { w: 667, h: 375, touch: true }; // small phone on its side: still < 768 wide
const LAPTOP = { w: 1440, h: 900, touch: false };
const NARROW_DESKTOP = { w: 600, h: 900, touch: false }; // squeezed browser window
const TABLET = { w: 820, h: 1180, touch: true };

test("auto: a phone upright gets the phone view", () => {
  assert.equal(chooseShell("auto", PORTRAIT), "mobile");
});

test("auto: a phone on its side gets the full desktop, even under 768px wide", () => {
  // The regression: the old rule was `w < 768 => mobile`, which this fails.
  assert.equal(chooseShell("auto", SMALL_LAND), "desktop");
  assert.equal(chooseShell("auto", LANDSCAPE), "desktop");
});

test("auto: a narrow non-touch window keeps the width rule", () => {
  assert.equal(chooseShell("auto", NARROW_DESKTOP), "mobile");
  assert.equal(chooseShell("auto", LAPTOP), "desktop");
  assert.equal(chooseShell("auto", TABLET), "desktop");
});

test("phone: always the phone view, whatever the screen", () => {
  for (const v of [PORTRAIT, LANDSCAPE, SMALL_LAND, LAPTOP, TABLET]) assert.equal(chooseShell("phone", v), "mobile");
});

test("desktop: always the full desktop, even a phone upright", () => {
  for (const v of [PORTRAIT, LANDSCAPE, SMALL_LAND, NARROW_DESKTOP]) assert.equal(chooseShell("desktop", v), "desktop");
});

test("an unknown or missing mode behaves as auto", () => {
  assert.equal(chooseShell(undefined, PORTRAIT), "mobile");
  assert.equal(chooseShell("sideways", SMALL_LAND), "desktop");
  assert.equal(isPhoneMode("sideways"), false);
  assert.equal(isPhoneMode("desktop"), true);
});

test("phone hardware is judged on the short side, so rotation does not change it", () => {
  assert.equal(shortSide(PORTRAIT), shortSide(LANDSCAPE));
  assert.equal(isPhoneHardware(PORTRAIT), true);
  assert.equal(isPhoneHardware(LANDSCAPE), true);
  assert.equal(isPhoneHardware(TABLET), false);
  assert.equal(isPhoneHardware(NARROW_DESKTOP), false, "a mouse-driven narrow window is not a phone");
});

test("the Phone view button appears only on a phone forced into the desktop", () => {
  assert.equal(offerPhoneView("desktop", PORTRAIT), true);
  assert.equal(offerPhoneView("desktop", LANDSCAPE), true);
  assert.equal(offerPhoneView("auto", LANDSCAPE), false);
  assert.equal(offerPhoneView("desktop", LAPTOP), false);
  assert.equal(offerPhoneView("desktop", TABLET), false);
});
