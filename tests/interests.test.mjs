/* The interest profile decides what the OS suggests, so its ranking must be
 * explainable and must never leak a secret. Each check has a control that
 * proves it can still say no.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { extractInterests, redact, SIGNAL_UNIT_CAP, SOURCE_WEIGHT } from "../.test-build/interests.js";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const sig = (source, text, ageDays = 0, weight) => ({ source, text, at: NOW - ageDays * DAY, ...(weight === undefined ? {} : { weight }) });
const terms = (list) => list.map((i) => i.term);
const scoreOf = (list, term) => list.find((i) => i.term === term)?.score ?? 0;

test("newer beats older at equal frequency and source", () => {
  const out = extractInterests([sig("search", "astronomy", 30), sig("search", "gardening", 1)], NOW);
  assert.ok(scoreOf(out, "gardening") > scoreOf(out, "astronomy"));
  // Control: at equal age neither side is favoured, so the gap above is decay.
  const same = extractInterests([sig("search", "astronomy", 1), sig("search", "gardening", 1)], NOW);
  assert.equal(scoreOf(same, "gardening"), scoreOf(same, "astronomy"));
});

test("one half-life halves the score", () => {
  const out = extractInterests([sig("search", "astronomy", 7), sig("search", "gardening", 0)], NOW, { halfLifeDays: 7 });
  assert.ok(Math.abs(scoreOf(out, "astronomy") * 2 - scoreOf(out, "gardening")) < 1e-9);
});

test("source weighting: a saved file outweighs a one-off search", () => {
  assert.ok(SOURCE_WEIGHT.file > SOURCE_WEIGHT.search);
  const out = extractInterests([sig("search", "astronomy"), sig("file", "gardening")], NOW);
  assert.deepEqual(terms(out).slice(0, 2), ["gardening", "astronomy"]);
  // Control: the per-signal weight multiplier can overturn the source default.
  const boosted = extractInterests([sig("search", "astronomy", 0, 3), sig("file", "gardening")], NOW);
  assert.equal(terms(boosted)[0], "astronomy");
});

test("stopwords, OS boilerplate, short tokens and numbers are dropped", () => {
  const out = extractInterests([sig("file", "/notes/untitled-new-chat.md the and 2024 ab https www com volcanoes")], NOW);
  assert.deepEqual(terms(out), ["volcanoes"]);
});

test("secrets and emails never become terms", () => {
  const text = "debugging sk-live-abc123def456ghi789 for chris.person@example.com at https://api.example.org/v1?token=zzsecretqq9 AKIA1234567890ABCDEFGH";
  const out = terms(extractInterests([sig("chat", text), sig("chat", text)], NOW, { limit: 50 }));
  for (const t of out) {
    assert.ok(!/sk|live|abc123|chris|person|example\.com|token|zzsecretqq9|akia/.test(t), `leaked: ${t}`);
  }
  // Control: ordinary words in the same signal survive redaction.
  assert.ok(out.includes("debugging"));
  // The URL's host survives (its query string does not); repeated twice it
  // recurs, so it may arrive as part of a bigram.
  assert.ok(out.some((t) => t.split(" ").includes("api")));
});

test("redact spares long ordinary words but not long opaque runs", () => {
  assert.match(redact("internationalization"), /internationalization/);
  assert.doesNotMatch(redact("deadbeefdeadbeef0123456789"), /deadbeef/);
  assert.doesNotMatch(redact("mail me at a.b@c.io"), /c\.io/);
});

test("a recurring bigram is kept and its components are suppressed", () => {
  const out = extractInterests([sig("chat", "machine learning basics"), sig("file", "machine learning notebook")], NOW);
  assert.ok(terms(out).includes("machine learning"));
  assert.ok(!terms(out).includes("machine"));
  assert.ok(!terms(out).includes("learning"));
  // Control: a component used on its own elsewhere still earns credit there.
  const mixed = extractInterests([sig("chat", "machine learning"), sig("chat", "machine learning"), sig("chat", "learning spanish")], NOW);
  assert.ok(terms(mixed).includes("learning"));
  assert.ok(scoreOf(mixed, "machine learning") > scoreOf(mixed, "learning"));
});

test("a pair that appears in only one signal is not a bigram term", () => {
  const out = extractInterests([sig("chat", "quarterly report")], NOW);
  assert.ok(!terms(out).includes("quarterly report"));
  assert.ok(terms(out).includes("quarterly"));
});

test("one long signal cannot dominate the profile", () => {
  const essay = "zebra ".repeat(300) + Array.from({ length: 200 }, (_, i) => `topic${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`).join(" ");
  const out = extractInterests([sig("file", essay), sig("search", "quantum"), sig("search", "quantum physics")], NOW, { limit: 300 });
  assert.equal(terms(out)[0], "quantum");
  // The essay's whole contribution stays within its per-signal budget.
  const essayTotal = out.filter((i) => i.term !== "quantum" && i.term !== "physics").reduce((a, i) => a + i.score, 0);
  assert.ok(essayTotal <= SIGNAL_UNIT_CAP * SOURCE_WEIGHT.file + 1e-9);
  // Control: a short signal is not scaled down at all.
  const short = extractInterests([sig("file", "zebra")], NOW);
  assert.equal(scoreOf(short, "zebra"), SOURCE_WEIGHT.file);
});

test("output is deterministic: score desc then term asc, sources deduped", () => {
  const input = [sig("chat", "beta alpha"), sig("chat", "gamma"), sig("file", "gamma"), sig("chat", "gamma")];
  const a = extractInterests(input, NOW);
  const b = extractInterests([...input].reverse(), NOW);
  assert.deepEqual(a, b);
  assert.equal(a[0].term, "gamma");
  assert.deepEqual(a[0].sources, ["file", "chat"]);
  // Tied scores fall back to alphabetical order.
  assert.deepEqual(terms(a).slice(1), ["alpha", "beta"]);
});

test("empty input and non-positive limit return nothing", () => {
  assert.deepEqual(extractInterests([], NOW), []);
  assert.deepEqual(extractInterests([sig("chat", "gardening")], NOW, { limit: 0 }), []);
  assert.deepEqual(extractInterests([sig("chat", "gardening")], NOW, { limit: -3 }), []);
});

test("limit caps the list and defaults to 12", () => {
  const many = Array.from({ length: 20 }, (_, i) => sig("chat", `word${String.fromCharCode(97 + i)}x`));
  assert.equal(extractInterests(many, NOW).length, 12);
  assert.equal(extractInterests(many, NOW, { limit: 3 }).length, 3);
  // Control: a limit above the vocabulary returns everything, not padding.
  assert.equal(extractInterests(many, NOW, { limit: 100 }).length, 20);
});

test("a future timestamp counts as age zero, not as a boost", () => {
  const out = extractInterests([sig("chat", "astronomy", -30), sig("chat", "gardening", 0)], NOW);
  assert.equal(scoreOf(out, "astronomy"), scoreOf(out, "gardening"));
  assert.equal(scoreOf(out, "astronomy"), SOURCE_WEIGHT.chat);
});
