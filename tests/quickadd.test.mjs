/* Tasks: natural-language quick add, due buckets, and .ics export.
 * Every test pins its own clock: Thursday 2026-09-24 10:00 local. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseQuickAdd, dueBucket, matchesFilter, formatDue, tasksToIcs, toLocalIso, fromLocalIso, checklistProgress,
} from "../.test-build/quickadd.js";

const NOW = new Date(2026, 8, 24, 10, 0); // Thu
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const eod = (y, mo, d) => new Date(y, mo - 1, d, 23, 59, 59, 999).getTime();

test("tomorrow 3pm call Sam", () => {
  const r = parseQuickAdd("tomorrow 3pm call Sam", NOW);
  assert.equal(r.title, "call Sam");
  assert.equal(r.due, at(2026, 9, 25, 15));
  assert.equal(r.hasTime, true);
  assert.equal(r.priority, null);
});

test("time inside the sentence, with 'at' and minutes", () => {
  const r = parseQuickAdd("call Sam tomorrow at 3:30pm", NOW);
  assert.equal(r.title, "call Sam");
  assert.equal(r.due, at(2026, 9, 25, 15, 30));
});

test("a bare time that already passed today rolls to tomorrow", () => {
  assert.equal(parseQuickAdd("standup 9am", NOW).due, at(2026, 9, 25, 9));
  assert.equal(parseQuickAdd("lunch noon", NOW).due, at(2026, 9, 24, 12));
});

test("24h clock", () => {
  assert.equal(parseQuickAdd("deploy 17:45", NOW).due, at(2026, 9, 24, 17, 45));
});

test("12am is midnight and 12pm is noon", () => {
  assert.equal(parseQuickAdd("x tomorrow 12am", NOW).due, at(2026, 9, 25, 0));
  assert.equal(parseQuickAdd("x tomorrow 12pm", NOW).due, at(2026, 9, 25, 12));
});

test("date-only dues are the end of that day and carry no time", () => {
  const r = parseQuickAdd("file taxes friday", NOW);
  assert.equal(r.title, "file taxes");
  assert.equal(r.due, eod(2026, 9, 25));
  assert.equal(r.hasTime, false);
});

test("a weekday said on that weekday means next week", () => {
  assert.equal(parseQuickAdd("review thursday", NOW).due, eod(2026, 10, 1));
  assert.equal(parseQuickAdd("review mon", NOW).due, eod(2026, 9, 28));
});

test("weekday names do not match inside words", () => {
  const r = parseQuickAdd("read about Saturn", NOW);
  assert.equal(r.due, null);
  assert.equal(r.title, "read about Saturn");
});

test("ISO date, in N days, in N hours, tonight", () => {
  assert.equal(parseQuickAdd("renew 2026-10-03", NOW).due, eod(2026, 10, 3));
  assert.equal(parseQuickAdd("water plants in 3 days", NOW).due, eod(2026, 9, 27));
  assert.equal(parseQuickAdd("check oven in 2 hours", NOW).due, at(2026, 9, 24, 12));
  assert.equal(parseQuickAdd("check oven in 2 hours", NOW).title, "check oven");
  assert.equal(parseQuickAdd("call mum tonight", NOW).due, at(2026, 9, 24, 20));
});

test("priorities: !high, !!!, p3", () => {
  assert.equal(parseQuickAdd("ship it !high", NOW).priority, "high");
  assert.equal(parseQuickAdd("ship it !!!", NOW).priority, "high");
  assert.equal(parseQuickAdd("ship it p3", NOW).priority, "low");
  assert.equal(parseQuickAdd("ship it !high", NOW).title, "ship it");
});

test("numbers without am/pm are not times", () => {
  const r = parseQuickAdd("buy 2 apples", NOW);
  assert.equal(r.due, null);
  assert.equal(r.title, "buy 2 apples");
});

test("an input that is only a date keeps a title", () => {
  assert.equal(parseQuickAdd("tomorrow", NOW).title, "tomorrow");
});

test("buckets and filters", () => {
  assert.equal(dueBucket(at(2026, 9, 24, 9), NOW), "overdue");
  assert.equal(dueBucket(at(2026, 9, 24, 18), NOW), "today");
  assert.equal(dueBucket(eod(2026, 9, 24), NOW), "today");
  assert.equal(dueBucket(at(2026, 9, 25, 0), NOW), "upcoming");
  assert.equal(dueBucket(undefined, NOW), "none");
  const late = { due: at(2026, 9, 23), done: false };
  assert.equal(matchesFilter(late, "today", NOW), true, "overdue is today's problem");
  assert.equal(matchesFilter({ ...late, done: true }, "today", NOW), false);
  assert.equal(matchesFilter({ ...late, done: true }, "done", NOW), true);
  assert.equal(matchesFilter({ due: at(2026, 9, 30), done: false }, "upcoming", NOW), true);
  assert.equal(matchesFilter({ done: false }, "upcoming", NOW), false);
});

test("formatDue", () => {
  assert.equal(formatDue(at(2026, 9, 24, 15), true, NOW), "Today 3:00 PM");
  assert.equal(formatDue(eod(2026, 9, 25), false, NOW), "Tomorrow");
  assert.equal(formatDue(eod(2026, 9, 28), false, NOW), "Mon");
  assert.equal(formatDue(eod(2026, 10, 8), false, NOW), "Thu Oct 8");
  assert.equal(formatDue(at(2027, 1, 2, 9, 5), true, NOW), "Sat Jan 2 2027 9:05 AM");
});

test("local ISO round trip", () => {
  const t = at(2026, 9, 24, 7, 5);
  assert.equal(toLocalIso(t), "2026-09-24T07:05");
  assert.equal(fromLocalIso("2026-09-24T07:05"), t);
  assert.equal(fromLocalIso("not a date"), null);
});

test(".ics export goes through the shared builder, skips undated tasks", () => {
  const r = tasksToIcs([
    { title: "call Sam", due: at(2026, 9, 25, 15), dueHasTime: true },
    { title: "taxes; forms", due: eod(2026, 9, 25), dueHasTime: false },
    { title: "someday" },
  ], "20260924T100000Z", "seed");
  assert.equal(r.ok, true);
  assert.equal(r.count, 2);
  assert.equal(r.skipped, 1);
  assert.match(r.ics, /DTSTART:20260925T150000\r\nDTEND:20260925T153000/);
  assert.match(r.ics, /DTSTART:20260925T000000\r\nDTEND:20260925T235900/);
  assert.ok(r.ics.includes("SUMMARY:taxes\\; forms"), "RFC 5545 escaping from the shared builder");
  assert.match(r.ics, /PRODID:-\/\/Web-AIOS/);
  assert.equal(tasksToIcs([{ title: "x" }], "s", "u").ok, false);
});

test("checklist progress", () => {
  assert.deepEqual(checklistProgress([{ id: "a", text: "a", done: true }, { id: "b", text: "b", done: false }]), { done: 1, total: 2 });
  assert.deepEqual(checklistProgress(undefined), { done: 0, total: 0 });
});
