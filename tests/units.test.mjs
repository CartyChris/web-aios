/* Calc: the unit converter. Factors are definitions, so exact where exact. */
import test from "node:test";
import assert from "node:assert/strict";
import { convert, parseConversion, findUnit, formatNumber, UNITS, DIMENSIONS } from "../.test-build/units.js";

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} != ${b}`);

test("length, mass, volume", () => {
  near(convert(1, "mi", "km").value, 1.609344);
  near(convert(12, "in", "ft").value, 1);
  near(convert(1, "lb", "g").value, 453.59237);
  near(convert(1, "gal", "l").value, 3.785411784);
  near(convert(16, "tbsp", "cup").value, 1, 1e-6);
});

test("temperature is affine, not a factor", () => {
  near(convert(100, "c", "f").value, 212);
  near(convert(32, "F", "C").value, 0);
  near(convert(0, "k", "c").value, -273.15);
  near(convert(-40, "c", "f").value, -40);
  assert.equal(convert(-500, "c", "k").ok, false, "below absolute zero is refused");
});

test("data: decimal and binary prefixes differ", () => {
  near(convert(1, "gib", "gb").value, 1.073741824);
  near(convert(1, "mb", "kb").value, 1000);
});

test("speed and time and area", () => {
  near(convert(100, "kph", "mph").value, 62.13711922373339);
  near(convert(1, "wk", "h").value, 168);
  near(convert(1, "ha", "acre").value, 2.471053814671653);
});

test("cross-dimension conversions are refused", () => {
  const r = convert(1, "kg", "m");
  assert.equal(r.ok, false);
  assert.match(r.reason, /Cannot convert mass/);
  assert.equal(convert(1, "furlong", "m").ok, false);
});

test("aliases resolve", () => {
  assert.equal(findUnit("Miles").id, "mi");
  assert.equal(findUnit("km/h").id, "kph");
  assert.equal(findUnit("litres").id, "l");
});

test("parse '5 km to mi', '72F in C', '3.5 cups -> ml'", () => {
  assert.deepEqual(parseConversion("5 km to mi"), { value: 5, from: "km", to: "mi" });
  assert.deepEqual(parseConversion("72F in C"), { value: 72, from: "F", to: "C" });
  assert.deepEqual(parseConversion("3.5 cups -> ml"), { value: 3.5, from: "cups", to: "ml" });
  assert.equal(parseConversion("5 + 3"), null);
  assert.equal(parseConversion("5 bananas to apples"), null);
});

test("every unit id is unique and every dimension has units", () => {
  const ids = UNITS.map((u) => u.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const d of DIMENSIONS) assert.ok(UNITS.some((u) => u.dim === d), d);
});

test("formatNumber", () => {
  assert.equal(formatNumber(1.609344), "1.609344");
  assert.equal(formatNumber(0.1 + 0.2), "0.3");
  assert.equal(formatNumber(0), "0");
});
