/* Intel watchlists: signal identity, merge-on-pull, the "since last time"
 * diff, harness schedule triggers, and the markdown export.
 * Every test pins its own clock and its own id generator. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  fingerprint, mergeSignals, parseExtraction, createWatch, markSeen, diffWatch, matchesWatch,
  feedsForWatch, buildWatchTrigger, watchTriggerId, scheduleState, firesToHandle, watchReportMarkdown,
  signalsMarkdown, signalContext, slugify, watchReportPath, fileStamp, untilText, agoText, watchNameFor,
  SEEN_CAP, snapshotOf, findWatchByScope, INTEL_REFRESH_DOD,
} from "../.test-build/intel-watch.js";
import { decideFire, createDedupeLedger } from "../.test-build/harness/triggers.js";
import { dodValidate, evaluateDod } from "../.test-build/harness/dod.js";
import { runPassed } from "../.test-build/harness/passed.js";

const T0 = Date.UTC(2026, 8, 25, 10, 0, 0);
const H = 3_600_000;

function ids(prefix = "sig") {
  let n = 0;
  return () => `${prefix}_${++n}`;
}

function sig(over) {
  return { id: over.id ?? `s_${over.title}`, title: "t", body: "", source: "Wire", severity: "low", tags: [], ts: T0, ...over };
}

/* ── identity and merge ─────────────────────────────────────────────────── */

test("fingerprint ignores case, punctuation and curly quotes but not the source", () => {
  assert.equal(fingerprint({ title: "Bank’s rate: UP!", source: "Wire" }), fingerprint({ title: "bank's rate up", source: "wire" }));
  assert.notEqual(fingerprint({ title: "Rate up", source: "Wire" }), fingerprint({ title: "Rate up", source: "Other" }));
});

test("re-pulling the same page updates in place instead of duplicating", () => {
  const makeId = ids();
  const first = mergeSignals([], [
    { title: "Outage in EU-West", body: "Partial.", source: "Status", severity: "medium", tags: ["cloud"] },
    { title: "New release 2.1", source: "Status", severity: "low" },
  ], { now: T0, makeId, feedId: "f1" });
  assert.equal(first.added, 2);
  assert.equal(first.signals.length, 2);
  assert.equal(first.signals[0].feedId, "f1");

  const second = mergeSignals(first.signals, [
    { title: "outage in eu-west!", body: "Full outage now.", source: "Status", severity: "critical", tags: ["cloud", "incident"] },
    { title: "New release 2.1", source: "Status", severity: "low" },
    { title: "Maintenance window", source: "Status", severity: "low" },
  ], { now: T0 + H, makeId, feedId: "f1" });

  assert.equal(second.signals.length, 3, "one new row, no duplicates");
  assert.equal(second.added, 1);
  assert.equal(second.updated, 1);
  assert.equal(second.unchanged, 1);
  const outage = second.signals.find((s) => s.title === "Outage in EU-West");
  assert.equal(outage.id, first.signals[0].id, "keeps its id");
  assert.equal(outage.ts, T0, "keeps its first-seen time");
  assert.equal(outage.updatedAt, T0 + H);
  assert.equal(outage.severity, "critical");
  assert.deepEqual(outage.tags, ["cloud", "incident"]);
  assert.equal(second.signals[0].title, "Maintenance window", "new rows go on top");
});

test("a duplicate inside one batch folds into the first copy and keeps the higher severity", () => {
  const r = mergeSignals([], [
    { title: "Breach at Acme", source: "News", severity: "medium" },
    { title: "BREACH AT ACME", source: "News", severity: "critical", body: "Confirmed." },
  ], { now: T0, makeId: ids() });
  assert.equal(r.added, 1);
  assert.equal(r.signals[0].severity, "critical");
  assert.equal(r.signals[0].body, "Confirmed.");
});

test("merge drops untitled items, coerces bad severities, and respects the cap", () => {
  const existing = Array.from({ length: 5 }, (_, i) => sig({ id: `old${i}`, title: `old ${i}` }));
  const r = mergeSignals(existing, [
    { title: "", source: "X" },
    { title: "fresh", source: "X", severity: "apocalyptic", tags: "not-an-array" },
  ], { now: T0, makeId: ids(), cap: 4 });
  assert.equal(r.added, 1);
  assert.equal(r.signals.length, 4);
  assert.equal(r.evicted, 2);
  assert.equal(r.signals[0].severity, "low");
  assert.deepEqual(r.signals[0].tags, []);
  assert.equal(r.signals.at(-1).id, "old2", "the oldest fall off the end");
});

test("parseExtraction survives prose and fences, and refuses non-arrays", () => {
  const got = parseExtraction('Here you go:\n```json\n[{"title":"A"}, 3, {"title":"B"}]\n```');
  assert.deepEqual(got.map((x) => x.title), ["A", "B"]);
  assert.throws(() => parseExtraction('{"title":"A"}'), /JSON array/);
  assert.throws(() => parseExtraction("[not json]"), /did not parse/);
});

/* ── watches and the diff ───────────────────────────────────────────────── */

const FEEDS = { f1: "Status", f2: "Wire" };

test("matchesWatch: every term, the severity floor, and the feed scope", () => {
  const w = { query: "eu outage", minSeverity: "medium", feedIds: ["f1"] };
  assert.equal(matchesWatch(sig({ title: "Outage in EU-West", source: "Status", severity: "high", feedId: "f1" }), w, FEEDS), true);
  assert.equal(matchesWatch(sig({ title: "Outage in US", source: "Status", severity: "high", feedId: "f1" }), w, FEEDS), false, "missing a term");
  assert.equal(matchesWatch(sig({ title: "EU outage", source: "Status", severity: "low", feedId: "f1" }), w, FEEDS), false, "below the floor");
  assert.equal(matchesWatch(sig({ title: "EU outage", source: "Wire", severity: "high", feedId: "f2" }), w, FEEDS), false, "another feed");
  assert.equal(matchesWatch(sig({ title: "EU outage", source: "Status", severity: "high" }), w, FEEDS), true, "legacy row matched by feed name");
  assert.equal(matchesWatch(sig({ title: "anything", severity: "low" }), { query: "", minSeverity: "low", feedIds: [] }, FEEDS), true);
});

test("a new watch starts with today's matches seen, so its first diff is empty", () => {
  const signals = [sig({ title: "EU outage", severity: "high" }), sig({ title: "Unrelated", severity: "high" })];
  const w = createWatch({ id: "w_abcd", name: " EU ", query: "eu", minSeverity: "medium", now: T0, signals, feedNames: FEEDS });
  assert.equal(w.name, "EU");
  assert.equal(Object.keys(w.seen).length, 1);
  const d = diffWatch(signals, w, FEEDS);
  assert.equal(d.changed, 0);
  assert.equal(d.matches.length, 1);
});

test("diffWatch reports new, escalated, de-escalated and gone rows exactly", () => {
  const before = [
    sig({ id: "a", title: "EU outage", severity: "medium" }),
    sig({ id: "b", title: "EU fine", severity: "high" }),
    sig({ id: "c", title: "EU price change", severity: "low" }),
    sig({ id: "d", title: "EU steady", severity: "medium" }),
  ];
  const w = createWatch({ id: "w_1", name: "EU", query: "eu", minSeverity: "low", now: T0, signals: before, feedNames: FEEDS });
  const after = [
    sig({ id: "e", title: "EU new rule", severity: "high" }),
    { ...before[0], severity: "critical" },
    { ...before[1], severity: "low" },
    before[3],
  ]; // c is gone
  const d = diffWatch(after, w, FEEDS);
  assert.deepEqual(d.fresh.map((s) => s.id), ["e"]);
  assert.deepEqual(d.escalated.map((c) => [c.signal.id, c.from]), [["a", "medium"]]);
  assert.deepEqual(d.deescalated.map((c) => [c.signal.id, c.from]), [["b", "high"]]);
  assert.deepEqual(d.gone.map((g) => g.title), ["EU price change"]);
  assert.equal(d.changed, 4);
  assert.equal(d.matches.length, 4);

  const seen = markSeen(w, after, FEEDS, T0 + H);
  assert.equal(seen.seenAt, T0 + H);
  assert.equal(diffWatch(after, seen, FEEDS).changed, 0, "marking seen clears the diff");
});

test("snapshots are capped", () => {
  const many = Array.from({ length: SEEN_CAP + 50 }, (_, i) => sig({ id: `x${i}`, title: `item ${i}` }));
  assert.equal(Object.keys(snapshotOf(many)).length, SEEN_CAP);
});

test("feedsForWatch: empty scope means every feed", () => {
  const feeds = [{ id: "f1" }, { id: "f2" }];
  assert.deepEqual(feedsForWatch({ feedIds: [] }, feeds).map((f) => f.id), ["f1", "f2"]);
  assert.deepEqual(feedsForWatch({ feedIds: ["f2", "gone"] }, feeds).map((f) => f.id), ["f2"]);
});

test("watchNameFor names a watch from the filter", () => {
  assert.equal(watchNameFor("  ransomware ", "high"), "ransomware (high+)");
  assert.equal(watchNameFor("", "critical"), "Critical signals");
  assert.equal(watchNameFor("", "high"), "High+ signals");
  assert.equal(watchNameFor("", "all"), "All signals");
  assert.equal(watchNameFor("x", "low"), "x");
});

test("findWatchByScope matches the same scope regardless of term order or case", () => {
  const w = createWatch({ id: "w_1", name: "x", query: "EU outage", minSeverity: "high", feedIds: ["f2", "f1"], now: T0, signals: [], feedNames: FEEDS });
  assert.equal(findWatchByScope([w], { query: "outage  eu", minSeverity: "high", feedIds: ["f1", "f2"] })?.id, "w_1");
  assert.equal(findWatchByScope([w], { query: "outage eu", minSeverity: "medium", feedIds: ["f1", "f2"] }), undefined);
  assert.equal(findWatchByScope([w], { query: "outage", minSeverity: "high", feedIds: ["f1", "f2"] }), undefined);
  assert.equal(findWatchByScope([w], { query: "outage eu", minSeverity: "high", feedIds: [] }), undefined);
});

/* ── schedule, through the real harness trigger layer ───────────────────── */

test("buildWatchTrigger produces a spec the harness's own validator admits", () => {
  const w = { id: "w_abcd", name: "EU", query: "eu", minSeverity: "high" };
  const r = buildWatchTrigger(w, "every:6h", T0, ["Status"], "/intel/watches/eu-abcd.md");
  assert.equal(r.ok, true);
  assert.equal(r.spec.id, watchTriggerId("w_abcd"));
  assert.equal(r.spec.kind, "schedule");
  assert.equal(r.spec.enabled, true);
  assert.equal(r.spec.firedCount, 0);
  assert.match(r.spec.objectiveTemplate, /\{\{now\}\}/);
  assert.match(r.spec.objectiveTemplate, /\/intel\/watches\/eu-abcd\.md/);
});

test("a watch named like a placeholder cannot smuggle {{payload}} into the objective", () => {
  const r = buildWatchTrigger({ id: "w_1", name: "{{payload}}", query: "", minSeverity: "low" }, "every:1h", T0, [], "/p.md");
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.spec.objectiveTemplate, /\{\{payload/);
});

test("an interval under the harness minimum is refused, with the harness's reason", () => {
  const r = buildWatchTrigger({ id: "w_1", name: "x", query: "", minSeverity: "low" }, "every:10s", T0, [], "/p.md");
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(" "), /minimum interval/);
});

test("the built trigger actually fires under decideFire when due, and not before", () => {
  const { spec } = buildWatchTrigger({ id: "w_1", name: "x", query: "", minSeverity: "low" }, "every:6h", T0, [], "/p.md");
  const ledger = createDedupeLedger();
  const first = decideFire({ spec, kind: "schedule", signal: "", payload: {}, now: T0, dedupeMs: 60_000, ledger });
  assert.equal(first.fire, true, "never fired, so due now");
  const fired = { ...spec, firedCount: 1, lastFiredAt: T0 };
  const early = decideFire({ spec: fired, kind: "schedule", signal: "", payload: {}, now: T0 + 5 * H, dedupeMs: 60_000, ledger });
  assert.equal(early.fire, false);
  const due = decideFire({ spec: fired, kind: "schedule", signal: "", payload: {}, now: T0 + 6 * H, dedupeMs: 60_000, ledger });
  assert.equal(due.fire, true);
});

test("the refresh DoD is valid, and passes or fails a scheduled run on what it actually did", async () => {
  assert.deepEqual(dodValidate(INTEL_REFRESH_DOD), { ok: true });
  const { spec } = buildWatchTrigger({ id: "w_1", name: "x", query: "", minSeverity: "low" }, "every:6h", T0, [], "/p.md");
  assert.equal(spec.dodId, INTEL_REFRESH_DOD.id);
  const totals = { steps: 1, llmCalls: 1, repairCalls: 0, toolCalls: 0, toolErrors: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, ms: 0 };
  const run = (answer, steps = 1) => ({
    runId: "run_1", configId: "default", agentId: null, objective: spec.objectiveTemplate,
    trigger: { triggerId: spec.id, kind: "schedule", at: T0, payload: {}, dedupeKey: "k" },
    status: "finished", answer, steps: [], transcript: "", spans: [], verdict: null, flags: [],
    totals: { ...totals, steps }, startedAt: T0, endedAt: T0 + 1000, fingerprint: "fp",
  });
  const good = await evaluateDod(INTEL_REFRESH_DOD, run("The Intel watch refresh is scheduled."), null);
  assert.equal(runPassed({ status: "finished", verdict: good }).pass, true, "no human is left waiting");
  const silent = await evaluateDod(INTEL_REFRESH_DOD, run("OK."), null);
  assert.equal(silent.pass, false);
  const wandered = await evaluateDod(INTEL_REFRESH_DOD, run("Refresh done.", 9), null);
  assert.equal(wandered.pass, false);
});

test("scheduleState reads the trigger store, including a trigger deleted in Harness", () => {
  const { spec } = buildWatchTrigger({ id: "w_1", name: "x", query: "", minSeverity: "low" }, "every:6h", T0, [], "/p.md");
  assert.deepEqual(scheduleState({}, [spec], T0), { kind: "none" });
  assert.deepEqual(scheduleState({ triggerId: "trg_intel_gone" }, [spec], T0), { kind: "missing", triggerId: "trg_intel_gone" });
  const st = scheduleState({ triggerId: spec.id }, [{ ...spec, firedCount: 2, lastFiredAt: T0 }], T0 + H);
  assert.equal(st.kind, "scheduled");
  assert.equal(st.label, "Every 6 hours");
  assert.equal(st.firedCount, 2);
  assert.equal(st.nextAt, T0 + 6 * H);
});

test("firesToHandle: only a trigger that fired after the last handled fire", () => {
  const trg = { id: "trg_intel_w1", lastFiredAt: T0 };
  const w = { id: "w1", triggerId: "trg_intel_w1" };
  assert.deepEqual(firesToHandle([w], [trg]), [{ watchId: "w1", firedAt: T0 }]);
  assert.deepEqual(firesToHandle([{ ...w, handledFireAt: T0 }], [trg]), [], "already handled");
  assert.deepEqual(firesToHandle([{ ...w, handledFireAt: T0 - 1 }], [trg]).length, 1);
  assert.deepEqual(firesToHandle([w], [{ id: "trg_intel_w1" }]), [], "never fired");
  assert.deepEqual(firesToHandle([{ id: "w2" }], [trg]), [], "unscheduled watch");
  assert.deepEqual(firesToHandle([{ ...w, triggerId: "other" }], [trg]), [], "someone else's trigger");
});

/* ── text ───────────────────────────────────────────────────────────────── */

test("the watch report states real counts and lists each section", () => {
  const before = [sig({ id: "a", title: "EU outage", severity: "medium" }), sig({ id: "c", title: "EU old", severity: "low" })];
  const w = createWatch({ id: "w_abcd", name: "EU", query: "eu", minSeverity: "low", now: T0, signals: before, feedNames: FEEDS });
  const after = [sig({ id: "e", title: "EU new", severity: "high", url: "https://x.test/a(b)" }), { ...before[0], severity: "critical" }];
  const md = watchReportMarkdown(w, diffWatch(after, w, FEEDS), T0 + H, ["Status"]);
  assert.match(md, /^# Intel watch: EU\n/);
  assert.match(md, /\*\*1 new, 1 escalated, 0 de-escalated, 1 no longer matching\. 2 matching now\.\*\*/);
  assert.match(md, /## New\n\n- \*\*\[high\] EU new\*\*/);
  assert.match(md, /\(was medium\)/);
  assert.match(md, /## No longer matching\n\n- \[low\] EU old/);
  assert.match(md, /https:\/\/x\.test\/a%28b%29/, "parentheses cannot end the link early");
  assert.match(md, /Generated 2026-09-25 11:00 UTC/);
});

test("signalsMarkdown groups by severity, most severe first, and never links a non-http url", () => {
  const md = signalsMarkdown({
    title: "Signals",
    now: T0,
    note: "filter: eu",
    signals: [sig({ title: "Low one" }), sig({ title: "Crit one", severity: "critical", url: "javascript:alert(1)", tags: ["a b"] })],
  });
  assert.ok(md.indexOf("### Critical (1)") < md.indexOf("### Low (1)"));
  assert.doesNotMatch(md, /javascript:/);
  assert.match(md, /#a-b/);
  assert.match(md, /2 signals \(filter: eu\)/);
  assert.match(signalsMarkdown({ title: "x", signals: [], now: T0 }), /Nothing matched\./);
});

test("signalContext carries what the chat needs and nothing empty", () => {
  const txt = signalContext(sig({ title: "EU outage", severity: "high", body: "Details.", url: "https://s.test", tags: ["cloud"] }));
  assert.match(txt, /^Title: EU outage\nSeverity \(as extracted\): high\nSource: Wire <https:\/\/s\.test>\nFirst seen: 2026-09-25 10:00 UTC\nTags: cloud\n\nDetails\.$/);
  assert.doesNotMatch(signalContext(sig({ title: "x" })), /Tags:/);
});

test("paths, stamps and relative times", () => {
  assert.equal(slugify("EU / Outages: 2026!"), "eu-outages-2026");
  assert.equal(slugify("!!!"), "watch");
  assert.equal(watchReportPath({ id: "w_12345678", name: "EU" }), "/intel/watches/eu-5678.md");
  assert.equal(fileStamp(T0), "2026-09-25T10-00-00");
  assert.equal(untilText(T0 - 1, T0), "due now");
  assert.equal(untilText(T0 + 5 * 60_000, T0), "in 5m");
  assert.equal(untilText(T0 + 2 * H + 5 * 60_000, T0), "in 2h 5m");
  assert.equal(untilText(T0 + 26 * H, T0), "in 1d 2h");
  assert.equal(agoText(T0 - 3 * H, T0), "3h ago");
  assert.equal(agoText(T0 + 10, T0), "just now");
});
