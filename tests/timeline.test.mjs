/** Timeline memory: dated, sourced entries, and plain time phrases. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, parseQuery, queryTimeline, timelineAnswer } from "../.test-build/timeline.js";

const DAY = 86_400_000;
// Thursday 2026-09-24 15:00 UTC; tz offset 0 keeps the arithmetic readable.
const NOW = Date.UTC(2026, 8, 24, 15, 0);

const entries = buildTimeline({
  activity: [{ source: "search", text: "volcano eruptions", at: NOW - 2 * 3600e3 }],
  files: [
    { path: "/notes/Plan.md", kind: "file", createdAt: NOW - DAY, updatedAt: NOW - DAY + 500 },
    { path: "/.trash/x", kind: "file", createdAt: NOW, updatedAt: NOW },
  ],
  tasks: [{ title: "Call Sam", createdAt: NOW - 2 * DAY }],
  jobs: [{ title: "Agent Loop: kart", status: "done", startedAt: NOW - 3 * DAY, endedAt: NOW - 3 * DAY + 60e3 }],
  focus: [{ endedAt: NOW - 60e3, minutes: 25, mode: "work" }],
  notifications: [],
});

test("entries are newest first, sourced, and trash is left out", () => {
  assert.deepEqual(entries.map((e) => e.kind), ["focus", "activity", "file", "task", "job"]);
  assert.equal(entries[2].text, "Created /notes/Plan.md");
  assert.equal(entries[2].target.appId, "notes");
});

test("time phrases become ranges, the rest are words", () => {
  assert.equal(queryTimeline(entries, "what did I do today", NOW).hits.length, 2);
  assert.deepEqual(queryTimeline(entries, "yesterday", NOW).hits.map((e) => e.kind), ["file"]);
  const tue = queryTimeline(entries, "tuesday", NOW);
  assert.equal(tue.query.label, "last Tuesday");
  assert.deepEqual(tue.hits.map((e) => e.kind), ["task"]);
  assert.deepEqual(queryTimeline(entries, "last week loop", NOW).hits.map((e) => e.kind), ["job"]);
  assert.equal(queryTimeline(entries, "volcano", NOW).hits.length, 1);
});

test("the same weekday name means the previous one, never today", () => {
  const q = parseQuery("thursday", NOW);
  assert.equal(q.to, Date.UTC(2026, 8, 18, 0, 0));
});

/* ── richer time phrases ─────────────────────────────────────────────────── */
// NOW is Thursday 2026-09-24 15:00 UTC; tz 0 unless stated.
const at = (y, m, d, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi);
const range = (q, tz = 0) => { const r = parseQuery(q, NOW, tz); return { from: r.from, to: r.to, label: r.label, words: r.words }; };

test("N days ago is that one calendar day, and the label names it", () => {
  const r = range("3 days ago");
  assert.equal(r.from, at(2026, 9, 21));
  assert.equal(r.to, at(2026, 9, 22));
  assert.equal(r.label, "3 days ago (Mon Sep 21)");
});

test("number words work, and 'a' means one", () => {
  assert.equal(range("two days ago").from, at(2026, 9, 22));
  assert.equal(range("a day ago").from, at(2026, 9, 23));
});

test("N weeks ago is the seven days starting N weeks back", () => {
  const r = range("2 weeks ago");
  assert.equal(r.from, at(2026, 9, 10));
  assert.equal(r.to, at(2026, 9, 17));
  assert.equal(r.label, "2 weeks ago (Thu Sep 10 to Wed Sep 16)");
});

test("a month ago is the previous CALENDAR month, not thirty days", () => {
  const r = range("a month ago");
  assert.equal(r.from, at(2026, 8, 1));
  assert.equal(r.to, at(2026, 9, 1));
  assert.equal(r.label, "a month ago (August 2026)");
});

test("last N days and past N weeks run up to now", () => {
  const r = range("last 10 days");
  assert.equal(r.from, at(2026, 9, 14));
  assert.equal(r.to, NOW + 1);
  assert.equal(range("past 2 weeks").from, at(2026, 9, 10));
  assert.equal(range("past 2 weeks").label, "the last 14 days");
});

test("this month runs to now; last month is the whole previous month", () => {
  assert.deepEqual([range("this month").from, range("this month").to], [at(2026, 9, 1), NOW + 1]);
  assert.deepEqual([range("last month").from, range("last month").to], [at(2026, 8, 1), at(2026, 9, 1)]);
});

test("since a weekday starts at the previous one and runs to now", () => {
  const r = range("since monday");
  assert.equal(r.from, at(2026, 9, 21));
  assert.equal(r.to, NOW + 1);
  assert.equal(r.label, "since Monday");
  // Today is Thursday, so "since thursday" is last Thursday, as the bare
  // weekday rule already decides.
  assert.equal(range("since thursday").from, at(2026, 9, 17));
});

test("since a month or a date", () => {
  assert.equal(range("since march").from, at(2026, 3, 1));
  assert.equal(range("since 2026-09-01").from, at(2026, 9, 1));
  assert.equal(range("since yesterday").from, at(2026, 9, 23));
});

test("a month and day in every common order", () => {
  for (const q of ["march 3", "mar 3", "3 march", "3rd of march", "March 3rd"]) {
    const r = range(q);
    assert.equal(r.from, at(2026, 3, 3), q);
    assert.equal(r.to, at(2026, 3, 4), q);
    assert.equal(r.label, "March 3", q);
  }
});

test("a date later this year means LAST year — this is a record of the past", () => {
  assert.equal(range("december 25").from, at(2025, 12, 25));
  // Same month, later day: still last year.
  assert.equal(range("september 30").from, at(2025, 9, 30));
  // Same month, earlier day: this year.
  assert.equal(range("september 20").from, at(2026, 9, 20));
});

test("a month alone is the most recent one, and the current month runs to now", () => {
  assert.deepEqual([range("in march").from, range("in march").to], [at(2026, 3, 1), at(2026, 4, 1)]);
  assert.equal(range("in december").from, at(2025, 12, 1));
  assert.deepEqual([range("september").from, range("september").to], [at(2026, 9, 1), NOW + 1]);
  assert.equal(range("march 2025").from, at(2025, 3, 1));
  assert.equal(range("march 2025").to, at(2025, 4, 1));
});

test("a bare 'may' is a word, 'in may' is the month", () => {
  const bare = range("may notes");
  assert.equal(bare.from, 0, "no range");
  assert.ok(bare.words.includes("may"), "kept as a word to search for");
  assert.equal(range("in may").from, at(2026, 5, 1));
});

test("a bare abbreviation is a word; with 'in' or a day it is a month", () => {
  assert.equal(range("dec budget").from, 0);
  assert.equal(range("in dec").from, at(2025, 12, 1));
  assert.equal(range("dec 5").from, at(2025, 12, 5));
});

test("an ISO date is that day", () => {
  const r = range("2026-09-20");
  assert.equal(r.from, at(2026, 9, 20));
  assert.equal(r.to, at(2026, 9, 21));
});

test("every candidate is tried, not only the first word-number pair", () => {
  // "week 3" comes first and is not a date; stopping there missed "march 5".
  const r = range("week 3 plan march 5");
  assert.equal(r.from, at(2026, 3, 5));
  assert.deepEqual(r.words, ["week", "3", "plan"]);
});

test("the time phrase is removed and the rest are search words", () => {
  assert.deepEqual(range("3 days ago loop").words, ["loop"]);
  assert.deepEqual(range("notes since monday").words, ["notes"]);
});

test("months and days follow the user's zone, not UTC", () => {
  // UTC+10 (getTimezoneOffset -600): 15:00 UTC is already 01:00 Friday there.
  assert.equal(range("this month", -600).from, Date.UTC(2026, 7, 31, 14, 0), "local Sep 1 00:00 is Aug 31 14:00 UTC");
  assert.equal(range("yesterday", -600).from, Date.UTC(2026, 8, 23, 14, 0), "local Thursday");
  assert.equal(range("3 days ago", -600).label, "3 days ago (Tue Sep 22)");
});

test("the richer phrases answer real questions end to end", () => {
  assert.deepEqual(queryTimeline(entries, "3 days ago", NOW).hits.map((e) => e.kind), ["job"]);
  assert.deepEqual(queryTimeline(entries, "since monday loop", NOW).hits.map((e) => e.kind), ["job"]);
  assert.equal(queryTimeline(entries, "this month", NOW).hits.length, entries.length);
  assert.equal(queryTimeline(entries, "last month", NOW).hits.length, 0);
});

/* ── the answer a model reads ────────────────────────────────────────────── */

test("each line has a local time, a source, and a way back to it", () => {
  const text = timelineAnswer(queryTimeline(entries, "yesterday", NOW), 0);
  assert.match(text, /^1 entry from yesterday:/);
  assert.match(text, /2026-09-23 15:00 {2}file/);
  assert.match(text, /\[Files\]/);
  // The provenance link is the exact tool call that reopens the source.
  assert.match(text, /-> open_app \{"appId":"notes","args":\{"path":"\/notes\/Plan\.md"\}\}/);
});

test("an entry with nothing to open gets no link rather than a broken one", () => {
  const text = timelineAnswer(queryTimeline(entries, "3 days ago", NOW), 0);
  assert.match(text, /Agent Loop: kart \(done\) {2}\[Jobs\]$/m);
  assert.ok(!text.includes("open_app"));
});

test("times are shown in the user's zone", () => {
  assert.match(timelineAnswer(queryTimeline(entries, "last 10 days", NOW), -600), /2026-09-24 01:00/, "15:00 UTC is 01:00 in UTC+10");
});

test("no hits is a sentence that says what was searched, never an empty string", () => {
  const text = timelineAnswer(queryTimeline(entries, "last month", NOW), 0);
  assert.match(text, /^Nothing in the timeline for last month\./);
  assert.match(text, /this device only/);
});
