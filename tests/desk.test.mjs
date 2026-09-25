/** The Desk brief: every line from a record, urgency in the right order, and
 *  the things it cannot see always stated. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBrief, briefText, greeting } from "../.test-build/desk.js";

const NOW = Date.UTC(2026, 8, 25, 14, 0);
const H = 3_600_000;
const base = { now: NOW, hour: 14, endOfDay: NOW + 8 * H, tasks: [], doneColumns: ["done"], jobs: [], files: [], unreadNotifications: 0, focusMinutesToday: 30, focusStreakDays: 0 };

test("an empty device says nothing needs you, and still names its blind spots", () => {
  const b = buildBrief({ ...base, focusMinutesToday: 0, hour: 20 });
  assert.equal(b.headline, "Nothing needs you right now.");
  assert.equal(b.items.length, 0);
  assert.ok(b.blindSpots.some((s) => /inbox/.test(s)));
});

test("a blocked job outranks an overdue task, which outranks one due today", () => {
  const b = buildBrief({
    ...base,
    jobs: [{ id: "j1", title: "AIOS Chat: write file", status: "blocked", startedAt: NOW - 60_000, target: { appId: "loop" } }],
    tasks: [
      { id: "t1", title: "Due later", column: "todo", priority: "low", due: NOW + 2 * H, dueHasTime: true },
      { id: "t2", title: "Late", column: "todo", priority: "high", due: NOW - 26 * H },
    ],
  });
  assert.deepEqual(b.items.slice(0, 3).map((i) => i.id), ["job:j1", "task:t2", "task:t1"]);
  assert.equal(b.items[0].action.appId, "loop");
  assert.match(b.items[1].detail, /1 day overdue, high priority/);
  assert.match(b.items[2].detail, /Due in 2 h/);
  assert.equal(b.headline, "2 things need you; 2 can wait.");
});

test("done and archived tasks never appear; overdue beyond three collapses", () => {
  const tasks = [
    { id: "d", title: "Finished", column: "done", priority: "high", due: NOW - H },
    { id: "a", title: "Archived", column: "todo", priority: "high", due: NOW - H, archivedAt: NOW - 1 },
    ...[1, 2, 3, 4, 5].map((n) => ({ id: `o${n}`, title: `Late ${n}`, column: "todo", priority: "low", due: NOW - n * H })),
  ];
  const b = buildBrief({ ...base, tasks });
  const ids = b.items.map((i) => i.id);
  assert.ok(!ids.includes("task:d") && !ids.includes("task:a"));
  assert.deepEqual(ids.filter((i) => i.startsWith("task:")), ["task:o5", "task:o4", "task:o3", "task:overdue-rest"]);
  assert.equal(b.items.find((i) => i.id === "task:overdue-rest").title, "2 more overdue tasks");
});

test("old failures drop off; drafts, recent files and the focus nudge are counted", () => {
  const b = buildBrief({
    ...base, focusMinutesToday: 0, focusStreakDays: 3,
    jobs: [{ id: "old", title: "x", status: "error", startedAt: NOW - 30 * H, endedAt: NOW - 30 * H }],
    files: [
      { path: "/Mail/Drafts/a.txt", kind: "file", updatedAt: NOW - H, size: 10 },
      { path: "/Mail/Drafts/b.txt", kind: "file", updatedAt: NOW - 2 * H, size: 10 },
      { path: "/notes/Plan.md", kind: "file", updatedAt: NOW - 5 * 60_000, size: 10 },
      { path: "/.trash/x", kind: "file", updatedAt: NOW, size: 1 },
    ],
  });
  const ids = b.items.map((i) => i.id);
  assert.ok(!ids.includes("job:old"));
  assert.equal(b.items.find((i) => i.id === "mail:drafts").title, "2 email drafts not sent");
  assert.equal(b.items.find((i) => i.id === "file:/notes/Plan.md").action.appId, "notes");
  assert.ok(!ids.some((i) => i.includes(".trash")));
  assert.match(b.items.find((i) => i.id === "focus:none").detail, /3-day streak/);
  assert.match(briefText(b), /Cannot see:/);
});

test("greeting follows the local hour", () => {
  assert.equal(greeting(8), "Good morning");
  assert.equal(greeting(13), "Good afternoon");
  assert.equal(greeting(21), "Good evening");
  assert.equal(greeting(2), "Still up");
});
