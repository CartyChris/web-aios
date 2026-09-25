/** Timeline memory: dated, sourced entries, and plain time phrases. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, parseQuery, queryTimeline } from "../.test-build/timeline.js";

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
