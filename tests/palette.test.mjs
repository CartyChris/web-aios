/* Theme from wallpaper. The one property that matters: whatever image goes
 * in, the theme that comes out passes the same legibility gates every shipped
 * theme must pass. A pretty palette with unreadable text is a regression. */
import test from "node:test";
import assert from "node:assert/strict";
import { quantize, deriveTheme, passesGates, DERIVED_VARS } from "../.test-build/palette.js";

function image(w, h, fn) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b, a = 255] = fn(x, y, w, h);
    const i = (y * w + x) * 4;
    d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a;
  }
  return d;
}
const hue = (t) => {
  const k = (n) => (n + t * 6) % 6;
  const f = (n) => Math.round(255 * (1 - Math.max(0, Math.min(k(n), 4 - k(n), 1))));
  return [f(5), f(3), f(1)];
};

const IMAGES = {
  greyscale: image(48, 32, (x, _y, w) => { const v = Math.round((x / (w - 1)) * 255); return [v, v, v]; }),
  twoTone: image(48, 32, (x) => (x < 24 ? [20, 40, 120] : [240, 200, 40])),
  rainbow: image(48, 32, (x, _y, w) => hue(x / w)),
  nearWhite: image(48, 32, () => [250, 250, 248]),
  nearBlack: image(48, 32, () => [6, 6, 10]),
  flat: image(48, 32, () => [180, 60, 90]),
};

for (const [name, data] of Object.entries(IMAGES)) {
  for (const prefer of ["auto", "dark", "light"]) {
    test(`${name} / ${prefer}: the derived theme passes every legibility gate`, () => {
      const t = deriveTheme(quantize(data, 48, 32), { prefer });
      const g = passesGates(t.vars);
      assert.ok(g.ok, `${name}/${prefer} failed: ${g.failures.join("; ")}`);
      for (const v of DERIVED_VARS) assert.ok(t.vars[v], `${name}/${prefer} is missing ${v}`);
    });
  }
}

test("prefer dark and prefer light are honoured", () => {
  const sw = quantize(IMAGES.rainbow, 48, 32);
  assert.equal(deriveTheme(sw, { prefer: "dark" }).dark, true);
  assert.equal(deriveTheme(sw, { prefer: "light" }).dark, false);
});

test("derivation is deterministic — the same wallpaper always gives the same theme", () => {
  const a = deriveTheme(quantize(IMAGES.rainbow, 48, 32));
  const b = deriveTheme(quantize(IMAGES.rainbow, 48, 32));
  assert.deepEqual(a, b);
});

test("a greyscale image says it had no colour to use", () => {
  const t = deriveTheme(quantize(IMAGES.greyscale, 48, 32));
  assert.ok(t.notes.length > 0, "a fallback accent was chosen silently");
});

test("quantize weights sum to one and ignore transparent pixels", () => {
  const sw = quantize(IMAGES.twoTone, 48, 32);
  const total = sw.reduce((n, s) => n + s.weight, 0);
  assert.ok(Math.abs(total - 1) < 1e-6, `weights sum to ${total}`);
  const clear = quantize(image(8, 8, () => [255, 0, 0, 0]), 8, 8);
  assert.equal(clear.length, 0, "fully transparent pixels were counted");
});

test("NEGATIVE CONTROL: passesGates rejects an illegible palette", () => {
  // Proves the gate the property test relies on can actually say no.
  const good = deriveTheme(quantize(IMAGES.rainbow, 48, 32)).vars;
  const bad = { ...good, "--muted": good["--panel-solid"], "--accent2": good["--accent"] };
  const g = passesGates(bad);
  assert.equal(g.ok, false);
  assert.ok(g.failures.length >= 2, `only ${g.failures.length} failure(s) reported`);
});
