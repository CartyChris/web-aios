/* Focus: stats from the log of finished sessions. */
import test from "node:test";
import assert from "node:assert/strict";
import { focusStats, clampMinutes, sessionProgress } from "../.test-build/focusstats.js";

const NOW = new Date(2026, 8, 24, 18, 0);
const at = (d, h) => new Date(2026, 8, d, h, 0).getTime();

test("today, week, total, and breaks never count", () => {
  const log = [
    { endedAt: at(24, 9), minutes: 25, mode: "work" },
    { endedAt: at(24, 10), minutes: 50, mode: "work" },
    { endedAt: at(24, 11), minutes: 5, mode: "break" },
    { endedAt: at(20, 9), minutes: 25, mode: "work" },
    { endedAt: at(10, 9), minutes: 25, mode: "work" },
  ];
  const s = focusStats(log, NOW);
  assert.equal(s.todaySessions, 2);
  assert.equal(s.todayMinutes, 75);
  assert.equal(s.weekMinutes, 100);
  assert.equal(s.totalSessions, 4);
  assert.equal(s.totalMinutes, 125);
  assert.deepEqual(s.last7, [0, 0, 25, 0, 0, 0, 75]);
});

test("streak counts back from today, or from yesterday when today is empty", () => {
  const log = [22, 23, 24].map((d) => ({ endedAt: at(d, 9), minutes: 25, mode: "work" }));
  assert.equal(focusStats(log, NOW).streakDays, 3);
  assert.equal(focusStats(log.slice(0, 2), NOW).streakDays, 2, "yesterday still counts");
  assert.equal(focusStats(log.slice(0, 1), NOW).streakDays, 0, "a gap breaks it");
  assert.equal(focusStats([], NOW).streakDays, 0);
});

test("clamp and progress", () => {
  assert.equal(clampMinutes(0), 1);
  assert.equal(clampMinutes(999), 240);
  assert.equal(clampMinutes(NaN), 1);
  assert.equal(clampMinutes(12.6), 13);
  assert.equal(sessionProgress(1000, 1000, 500), 0.5);
  assert.equal(sessionProgress(1000, 1000, 5000), 1);
  assert.equal(sessionProgress(1000, 1000, -5000), 0);
});
