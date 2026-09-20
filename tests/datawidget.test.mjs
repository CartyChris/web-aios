/* Live Data widget config. A pinned widget's settings outlive the catalogue
 * they were written against, so these pin what happens when they stop making
 * sense — refused with a reason, never a widget that spins forever. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  normaliseDataConfig, isStale, compactRows, cacheKey, DATA_PRESETS, presetArgs,
  REFRESH_MIN, REFRESH_MAX, REFRESH_DEFAULT, ROWS_MIN, ROWS_MAX, ROWS_DEFAULT,
} from "../.test-build/datawidget.js";
import { SERVICES } from "../.test-build/services.js";

/* A small catalogue of our own so the tests do not depend on which services
 * happen to exist today. */
const noop = () => ({ rows: [], summary: "none", empty: true });
const FAKE = [
  {
    id: "needs", name: "Needs", category: "dev", description: "", provider: "P", licence: "L", docs: "", reach: "direct",
    params: [
      { name: "query", label: "Query", placeholder: "", required: true, kind: "text" },
      { name: "limit", label: "Limit", placeholder: "", required: false, kind: "number", default: "5" },
    ],
    url: () => "https://example.com", parse: noop,
  },
  {
    id: "free", name: "Free", category: "dev", description: "", provider: "P", licence: "L", docs: "", reach: "proxy",
    params: [], url: () => "https://example.com", parse: noop,
  },
];

test("a complete config normalises and gains declared defaults", () => {
  const r = normaliseDataConfig({ serviceId: "needs", args: { query: "rust" } }, FAKE);
  assert.equal(r.ok, true);
  assert.equal(r.config.args.query, "rust");
  assert.equal(r.config.args.limit, "5", "declared default applied");
  assert.equal(r.config.refreshMin, REFRESH_DEFAULT);
  assert.equal(r.config.rows, ROWS_DEFAULT);
});

test("unknown service and non-object input are refused, not thrown", () => {
  const r = normaliseDataConfig({ serviceId: "gone", args: {} }, FAKE);
  assert.equal(r.ok, false);
  assert.match(r.reason, /gone/);
  for (const bad of [undefined, null, 3, "x", [], {}]) {
    assert.equal(normaliseDataConfig(bad, FAKE).ok, false);
  }
});

test("a missing required param is refused and named", () => {
  const r = normaliseDataConfig({ serviceId: "needs", args: { query: "   " } }, FAKE);
  assert.equal(r.ok, false);
  assert.match(r.reason, /query/);
  // Negative control: the parameterless service passes with no args at all.
  assert.equal(normaliseDataConfig({ serviceId: "free" }, FAKE).ok, true);
});

test("non-string args are coerced when primitive and dropped otherwise", () => {
  const r = normaliseDataConfig(
    { serviceId: "needs", args: { query: 42, limit: { evil: 1 }, flag: true, list: ["a"], nan: NaN } },
    FAKE,
  );
  assert.equal(r.ok, true);
  assert.equal(r.config.args.query, "42");
  assert.equal(r.config.args.flag, "true");
  // The object was dropped, so the declared default took its place.
  assert.equal(r.config.args.limit, "5");
  assert.equal("list" in r.config.args, false);
  assert.equal("nan" in r.config.args, false);
  for (const v of Object.values(r.config.args)) assert.equal(typeof v, "string");
  // An object as the only source of a required param leaves it missing.
  assert.equal(normaliseDataConfig({ serviceId: "needs", args: { query: { a: 1 } } }, FAKE).ok, false);
});

test("refresh interval and row count clamp at both ends", () => {
  const cfg = (refreshMin, rows) => normaliseDataConfig({ serviceId: "free", refreshMin, rows }, FAKE).config;
  assert.equal(cfg(0, 0).refreshMin, REFRESH_MIN);
  assert.equal(cfg(0, 0).rows, ROWS_MIN);
  assert.equal(cfg(1e9, 1e9).refreshMin, REFRESH_MAX);
  assert.equal(cfg(1e9, 1e9).rows, ROWS_MAX);
  assert.equal(cfg("abc", "xyz").refreshMin, REFRESH_DEFAULT);
  // An in-range value is kept, so the clamp is not just a constant.
  assert.equal(cfg(17, 3).refreshMin, 17);
  assert.equal(cfg(17, 3).rows, 3);
  assert.equal(cfg("60", "2").refreshMin, 60);
});

test("isStale flips exactly at the interval", () => {
  const now = 1_000_000_000;
  const min = 10;
  assert.equal(isStale(undefined, min, now), true);
  assert.equal(isStale(now, min, now), false);
  assert.equal(isStale(now - min * 60_000 + 1, min, now), false);
  assert.equal(isStale(now - min * 60_000, min, now), true);
  // A reading from the future is not trusted to be fresh.
  assert.equal(isStale(now + 5, min, now), true);
});

test("compactRows truncates and keeps only http(s) links", () => {
  const long = "x".repeat(200);
  const result = {
    empty: false, summary: "s",
    rows: [
      { title: long, detail: long, url: "javascript:alert(1)", meta: "m" },
      { title: "ok", detail: "short", url: "https://example.com/a" },
      { title: "data", detail: "d", url: "data:text/html,<b>" },
      { title: "extra", detail: "e" },
    ],
  };
  const rows = compactRows(result, 3);
  assert.equal(rows.length, 3);
  assert.ok(rows[0].title.length <= 60 && rows[0].title.endsWith("…"));
  assert.ok(rows[0].detail.length <= 90 && rows[0].detail.endsWith("…"));
  assert.equal(rows[0].url, undefined, "javascript: must not survive");
  assert.equal(rows[2].url, undefined, "data: must not survive");
  // Negative control: an https url and short text pass through untouched.
  assert.equal(rows[1].url, "https://example.com/a");
  assert.equal(rows[1].title, "ok");
  assert.equal(compactRows(result, 0).length, 0);
});

test("cacheKey ignores arg order but not arg values", () => {
  const a = { serviceId: "s", args: { a: "1", b: "2" }, refreshMin: 30, rows: 4 };
  const b = { serviceId: "s", args: { b: "2", a: "1" }, refreshMin: 60, rows: 2 };
  assert.equal(cacheKey(a), cacheKey(b));
  assert.notEqual(cacheKey(a), cacheKey({ ...a, args: { a: "1", b: "3" } }));
  assert.notEqual(cacheKey(a), cacheKey({ ...a, serviceId: "t" }));
});

test("every preset is a valid config against the real catalogue", () => {
  const now = Date.UTC(2026, 2, 7, 23, 30);
  assert.ok(DATA_PRESETS.length >= 6);
  const ids = new Set();
  for (const p of DATA_PRESETS) {
    assert.equal(ids.has(p.id), false, `duplicate preset id ${p.id}`);
    ids.add(p.id);
    const args = presetArgs(p.id, now);
    assert.ok(args, p.id);
    const r = normaliseDataConfig({ serviceId: p.serviceId, args, presetId: p.id }, SERVICES);
    assert.equal(r.ok, true, `${p.id}: ${r.ok ? "" : r.reason}`);
    assert.equal(r.config.presetId, p.id);
    // The url builder must accept it too, or the widget fails on first fetch.
    const def = SERVICES.find((s) => s.id === p.serviceId);
    assert.match(def.url(r.config.args), /^https:\/\//);
  }
  assert.equal(presetArgs("no-such-preset", now), null);
});

test("dated presets derive month and day from the injected clock in UTC", () => {
  // 23:30 UTC on 7 March: a local-time implementation east of UTC would say the 8th.
  const args = presetArgs("onthisday", Date.UTC(2026, 2, 7, 23, 30));
  assert.equal(args.month, "03");
  assert.equal(args.day, "07");
  const later = presetArgs("onthisday", Date.UTC(2026, 11, 25, 0, 0));
  assert.equal(later.month, "12");
  assert.equal(later.day, "25");
  // Without the date, the preset would be refused — which is why it is dated.
  assert.equal(normaliseDataConfig({ serviceId: "onthisday", args: {} }, SERVICES).ok, false);
});

test("a presetId that does not match its service is dropped", () => {
  const r = normaliseDataConfig({ serviceId: "free", presetId: "onthisday" }, FAKE);
  assert.equal(r.ok, true);
  assert.equal(r.config.presetId, undefined);
});
