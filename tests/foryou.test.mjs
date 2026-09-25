/* For You's local half: why a suggestion is shown, how More / Less re-weight
 * the profile, and exactly what would leave the device. Each check has a
 * control proving the same path can still say yes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyFeedback, rateSuggestion, muteTerm, unmuteTerm, isMuted, voteFactor, isDismissed, dropDismissed,
  matchTerms, explainTerm, explainSuggestion, outboundTerms, outboundAllowed, manifest, utf8Bytes,
  aiosHandoff, agoLabel, snippet, EMPTY_FEEDBACK, VOTE_CAP, VOTE_STEP, HANDOFF_MAX, RATED_CAP,
} from "../.test-build/foryou.js";
import { extractInterests, SOURCE_WEIGHT } from "../.test-build/interests.js";
import { suggestionPrompt } from "../.test-build/suggest.js";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const sig = (source, text, ageDays = 0, weight) => ({ source, text, at: NOW - ageDays * DAY, ...(weight === undefined ? {} : { weight }) });
const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

const allowed = () => ({
  widgetKinds: ["clock", "news", "data"],
  services: [{ id: "wiki", name: "Wikipedia", description: "Search encyclopedia articles.", params: [{ name: "query", required: true }] }],
  newsSources: [{ id: "nasa", name: "NASA Breaking", category: "space science" }],
  existing: { widgetKinds: ["clock"], customWidgetNames: ["Diary Mood Tracker"], appNames: ["Divorce Budget"] },
});

/* ── feedback ── */

test("no feedback is the identity on the top of the profile", () => {
  const signals = [sig("file", "astronomy telescope"), sig("chat", "gardening tomatoes", 2), sig("search", "volcanoes", 5)];
  const pool = extractInterests(signals, NOW, { limit: 40 });
  const top = extractInterests(signals, NOW, { limit: 3 });
  const ranked = applyFeedback(pool, EMPTY_FEEDBACK, 3);
  assert.deepEqual(ranked.map((r) => [r.term, r.score]), top.map((r) => [r.term, r.score]));
  for (const r of ranked) { assert.equal(r.factor, 1); assert.equal(r.base, r.score); }
});

test("a More tap lifts a term past a stronger one; a Less tap sinks it", () => {
  const profile = [{ term: "alpha", score: 1.2, sources: ["chat"] }, { term: "beta", score: 1.0, sources: ["chat"] }];
  const up = rateSuggestion(EMPTY_FEEDBACK, "beta widget", ["beta"], 1);
  assert.deepEqual(applyFeedback(profile, up, 5).map((r) => r.term), ["beta", "alpha"]);
  assert.ok(close(applyFeedback(profile, up, 5)[0].score, 1.0 * Math.pow(2, VOTE_STEP)));
  // Control: the same tap on the other suggestion's term leaves the order as it was.
  const down = rateSuggestion(EMPTY_FEEDBACK, "beta widget", ["beta"], -1);
  assert.deepEqual(applyFeedback(profile, down, 5).map((r) => r.term), ["alpha", "beta"]);
  assert.ok(applyFeedback(profile, down, 5)[1].score < 1.0);
});

test("tapping the same direction twice undoes it exactly; the other direction replaces it", () => {
  const once = rateSuggestion(EMPTY_FEEDBACK, "k", ["Alpha", "beta", "beta"], 1);
  assert.deepEqual(once.votes, { alpha: 1, beta: 1 });
  assert.deepEqual(once.rated.k, { dir: 1, terms: ["alpha", "beta"] });
  const undone = rateSuggestion(once, "k", ["alpha", "beta"], 1);
  assert.deepEqual(undone.votes, {});
  assert.deepEqual(undone.rated, {});
  const flipped = rateSuggestion(once, "k", ["alpha", "beta"], -1);
  assert.deepEqual(flipped.votes, { alpha: -1, beta: -1 });
  // The undo uses the terms remembered at tap time, not the ones passed now.
  const undoLater = rateSuggestion(once, "k", ["something else"], 1);
  assert.deepEqual(undoLater.votes, {});
  // Control: a tap on a different suggestion stacks rather than undoing.
  const two = rateSuggestion(once, "other", ["alpha"], 1);
  assert.equal(two.votes.alpha, 2);
});

test("the multiplier is capped both ways and never reaches zero", () => {
  assert.equal(voteFactor(0), 1);
  assert.equal(voteFactor(VOTE_CAP + 10), voteFactor(VOTE_CAP));
  assert.equal(voteFactor(-VOTE_CAP - 10), voteFactor(-VOTE_CAP));
  assert.ok(voteFactor(-100) > 0);
  assert.ok(voteFactor(1) > 1 && voteFactor(-1) < 1);
  assert.equal(voteFactor(Number.NaN), 1);
});

test("a Less tap hides the suggestion now and drops it from later replies", () => {
  const fb = rateSuggestion(EMPTY_FEEDBACK, "space news", [], -1);
  assert.ok(isDismissed(fb, { title: "  Space   NEWS " }));
  const r = dropDismissed([{ type: "app", title: "Space news", why: "", prompt: "x".repeat(20) }, { type: "app", title: "Star log", why: "", prompt: "y".repeat(20) }], fb);
  assert.deepEqual(r.kept.map((s) => s.title), ["Star log"]);
  assert.equal(r.dropped[0].title, "Space news");
  // Control: a More tap does not hide anything.
  assert.ok(!isDismissed(rateSuggestion(EMPTY_FEEDBACK, "space news", [], 1), { title: "Space news" }));
});

test("ratings are capped, oldest first", () => {
  let fb = EMPTY_FEEDBACK;
  for (let i = 0; i < RATED_CAP + 5; i++) fb = rateSuggestion(fb, `s${i}`, [], -1);
  assert.equal(Object.keys(fb.rated).length, RATED_CAP);
  assert.ok(!("s0" in fb.rated));
  assert.ok(`s${RATED_CAP + 4}` in fb.rated);
});

test("mute removes a term, and a muted word removes its bigrams", () => {
  const profile = [
    { term: "tokyo trip", score: 3, sources: ["file"] },
    { term: "tokyo", score: 2, sources: ["chat"] },
    { term: "ramen", score: 1, sources: ["chat"] },
  ];
  const fb = muteTerm(EMPTY_FEEDBACK, " Tokyo ");
  assert.deepEqual(applyFeedback(profile, fb, 10).map((r) => r.term), ["ramen"]);
  assert.ok(isMuted("tokyo trip", fb.muted));
  // Control: muting the bigram leaves the single word alone.
  const bi = muteTerm(EMPTY_FEEDBACK, "tokyo trip");
  assert.deepEqual(applyFeedback(profile, bi, 10).map((r) => r.term), ["tokyo", "ramen"]);
  assert.deepEqual(unmuteTerm(fb, "TOKYO").muted, []);
  assert.equal(muteTerm(fb, "tokyo"), fb, "muting twice is a no-op");
});

/* ── why am I seeing this ── */

test("matchTerms finds terms in title, why, prompt and config, and nothing else", () => {
  const interests = [{ term: "volcano" }, { term: "machine learning" }, { term: "nasa" }, { term: "knitting" }];
  const s = { type: "widget", kind: "news", title: "Volcanoes daily", why: "Fits your machine-learning reading.", config: { sourceId: "nasa" } };
  assert.deepEqual(matchTerms(s, interests), ["volcano", "machine learning", "nasa"]);
  // Control: a word inside another word is not a match, and a split bigram is not.
  assert.deepEqual(matchTerms({ type: "app", title: "Unasalted learning machine", why: "", prompt: "x" }, [{ term: "nasa" }, { term: "machine learning" }]), []);
});

test("contributions are exact: they sum to the score, and a bigram shared by two signals is split between them", () => {
  const signals = [
    sig("chat", "machine learning basics", 0),
    sig("file", "machine learning notebook", 3),
    sig("search", "gardening", 1),
  ];
  const score = extractInterests(signals, NOW, { limit: 50 }).find((i) => i.term === "machine learning").score;
  const ex = explainTerm(signals, "machine learning", NOW, { maxEvidence: 5 });
  assert.ok(close(ex.base, score));
  assert.equal(ex.evidence.length, 2);
  const total = ex.evidence.reduce((a, e) => a + e.contribution, 0);
  assert.ok(close(total, score), `contributions ${total} should sum to ${score}`);
  assert.equal(ex.rest, 0);
  // The chat signal: weight 1.2, two terms ("machine learning", "basics"), age 0.
  const chat = ex.evidence.find((e) => e.source === "chat");
  assert.ok(close(chat.contribution, SOURCE_WEIGHT.chat));
  // The file signal is three days old at a 14-day half-life.
  const file = ex.evidence.find((e) => e.source === "file");
  assert.ok(close(file.contribution, SOURCE_WEIGHT.file * Math.pow(2, -3 / 14)));
  assert.equal(file.ageDays, 3);
  // Control: a term nobody mentioned has no evidence and no score.
  const none = explainTerm(signals, "knitting", NOW);
  assert.equal(none.base, 0);
  assert.deepEqual(none.evidence, []);
});

test("evidence beyond the shown rows is accounted for exactly in rest", () => {
  // One word per signal, so no recurring pair can absorb it.
  const signals = Array.from({ length: 6 }, (_, i) => sig("chat", "astronomy", i));
  const ex = explainTerm(signals, "astronomy", NOW, { maxEvidence: 2 });
  assert.equal(ex.evidence.length, 2);
  assert.equal(ex.restSignals, 4);
  const shown = ex.evidence.reduce((a, e) => a + e.contribution, 0);
  assert.ok(close(shown + ex.rest, ex.base));
  // Newest signals carry the most weight, so they are the ones shown.
  assert.deepEqual(ex.evidence.map((e) => e.ageDays), [0, 1]);
  // The scan cap is reported, not hidden.
  const capped = explainTerm(signals, "astronomy", NOW, { maxEvidence: 2, scanCap: 3 });
  assert.equal(capped.unscanned, 3);
  assert.ok(close(capped.evidence.reduce((a, e) => a + e.contribution, 0) + capped.rest, capped.base));
});

test("evidence snippets are redacted before they are shown", () => {
  const signals = [sig("chat", "astronomy with sk-live-abc123def456ghi789 and me@example.com")];
  const ex = explainTerm(signals, "astronomy", NOW);
  assert.equal(ex.evidence.length, 1);
  assert.doesNotMatch(ex.evidence[0].snippet, /sk-live|abc123|example\.com/);
  assert.match(ex.evidence[0].snippet, /astronomy/);
  assert.ok(snippet("x ".repeat(200)).length <= 90);
});

test("explainSuggestion ranks matched terms against the list that is sent", () => {
  const signals = [sig("file", "volcano survey"), sig("chat", "volcano photos"), sig("chat", "ramen", 1)];
  const ranked = applyFeedback(extractInterests(signals, NOW, { limit: 40 }), EMPTY_FEEDBACK, 12);
  const why = explainSuggestion({ type: "custom-widget", title: "Volcano watch", why: "", prompt: "A volcano activity widget." }, ranked, signals, NOW);
  assert.equal(why.terms.length, 1);
  assert.equal(why.terms[0].term, "volcano");
  assert.equal(why.terms[0].rank, 1);
  assert.equal(why.terms[0].explanation.evidence.length, 2);
  // Control: a suggestion naming nothing in the profile explains nothing.
  assert.deepEqual(explainSuggestion({ type: "app", title: "Chess clock", why: "", prompt: "x".repeat(20) }, ranked, signals, NOW).terms, []);
});

/* ── what leaves the device ── */

test("the panel's terms are exactly the ones in the prompt, and muted terms and raw signals are not", () => {
  const signals = [
    sig("file", "/notes/Plans for Tokyo trip.md"),
    sig("file", "/notes/tokyo trip budget.md", 1),
    sig("chat", "ramen recipes for a crowd", 2),
    sig("search", "divorce lawyer fees", 0),
  ];
  const profile = extractInterests(signals, NOW, { limit: 40 });
  const fb = muteTerm(EMPTY_FEEDBACK, "divorce");
  const ranked = applyFeedback(profile, fb, 12);
  const a = allowed();
  const prompt = suggestionPrompt(ranked, outboundAllowed(a, false), 8);
  const m = manifest(ranked, profile, fb, a, false, signals);

  assert.ok(prompt.includes(JSON.stringify(m.terms)), "panel terms must equal the serialised <interests> block");
  assert.ok(m.terms.some((t) => t.term === "tokyo trip"));
  assert.ok(m.heldBack.includes("divorce"));
  assert.doesNotMatch(prompt, /divorce/i, "a muted word never reaches the request");
  for (const s of signals) assert.ok(!prompt.includes(s.text), `raw signal leaked: ${s.text}`);
  assert.ok(!prompt.includes(String(NOW)), "timestamps stay local");
  // Names withheld by default: not in the prompt, counted in the panel.
  assert.doesNotMatch(prompt, /Diary Mood Tracker|Divorce Budget/);
  assert.equal(m.withheldNames, 2);
  assert.deepEqual(m.names, { customWidgets: [], apps: [] });
  assert.equal(m.local.total, 4);
  assert.equal(m.local.bySource.file, 2);
  // Control: with sharing on, the names go and the panel says so.
  const shared = suggestionPrompt(ranked, outboundAllowed(a, true), 8);
  assert.match(shared, /Diary Mood Tracker/);
  assert.deepEqual(manifest(ranked, profile, fb, a, true, signals).names.apps, ["Divorce Budget"]);
});

test("outboundTerms rounds like the prompt does", () => {
  assert.deepEqual(outboundTerms([{ term: "a", score: 1.23456 }, { term: "b", score: 0.005 }]), [{ term: "a", score: 1.23 }, { term: "b", score: 0.01 }]);
});

test("utf8Bytes agrees with Buffer", () => {
  for (const s of ["", "ascii", "café", "日本", "\u{1F600}x", "a…b"]) assert.equal(utf8Bytes(s), Buffer.byteLength(s, "utf8"), s);
});

/* ── hand-off and labels ── */

test("the AIOS hand-off carries the suggestion and nothing else", () => {
  const s = { type: "widget", kind: "data", title: "Volcano facts", why: "You read about volcanoes.", config: { serviceId: "wiki", args: { query: "volcano" } } };
  const text = aiosHandoff(s);
  assert.match(text, /Volcano facts/);
  assert.match(text, /wiki data service/);
  assert.match(text, /"query":"volcano"/);
  assert.match(text, /Do not change anything/);
  const app = aiosHandoff({ type: "app", title: "Star log", why: "", prompt: "A log for night-sky observations." });
  assert.match(app, /The app would be: A log for night-sky/);
  assert.ok(aiosHandoff({ type: "app", title: "t", why: "w".repeat(3000), prompt: "p" }).length <= HANDOFF_MAX);
});

test("agoLabel", () => {
  assert.equal(agoLabel(10_000), "just now");
  assert.equal(agoLabel(5 * 60_000), "5 min ago");
  assert.equal(agoLabel(3 * 3_600_000), "3 h ago");
  assert.equal(agoLabel(3 * DAY), "3 days ago");
  assert.equal(agoLabel(Number.NaN), "just now");
});

test("explaining a profile of 600 signals stays interactive", () => {
  const words = ["astronomy", "gardening", "ramen", "volcano", "chess", "knitting", "tokyo", "python"];
  const signals = Array.from({ length: 600 }, (_, i) => sig(i % 3 ? "chat" : "file", `${words[i % 8]} ${words[(i * 3) % 8]} notes about ${words[(i * 5) % 8]} item${i}`, i % 40));
  const t0 = process.hrtime.bigint();
  const ex = explainTerm(signals, "astronomy", NOW);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ex.base > 0 && ex.evidence.length > 0);
  assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms`);
  console.error(`explainTerm over 600 signals: ${ms.toFixed(0)} ms`);
});
