/**
 * Observatory span filtering and cost per completed task.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { filterSpans, costPerTask, spanStatus } from "../.test-build/span-query.js";

const S = (o) => ({ parentId: null, kind: "model", startedAt: 0, endedAt: 1, text: "ok", ...o });

test("filter by kind, status and every search term", () => {
  const spans = [
    S({ id: "1", name: "plan step", text: "alpha beta" }),
    S({ id: "2", name: "tool read", kind: "tool", text: "alpha" }),
    S({ id: "3", name: "act", error: "429 rate limit" }),
    S({ id: "4", name: "open", endedAt: undefined }),
  ];
  assert.deepEqual(filterSpans(spans, { query: "alpha", kind: "all", status: "all" }).map((s) => s.id), ["1", "2"]);
  assert.deepEqual(filterSpans(spans, { query: "alpha beta", kind: "all", status: "all" }).map((s) => s.id), ["1"]);
  assert.deepEqual(filterSpans(spans, { query: "", kind: "tool", status: "all" }).map((s) => s.id), ["2"]);
  assert.deepEqual(filterSpans(spans, { query: "rate", kind: "all", status: "error" }).map((s) => s.id), ["3"]);
  assert.equal(spanStatus(spans[3]), "open");
});

test("cost per completed task charges failures to the successes", () => {
  const spans = [
    // task A: completed, $0.10 over two spans in one run
    S({ id: "a1", runId: "A", costUsd: 0.04 }), S({ id: "a2", runId: "A", costUsd: 0.06 }),
    // task B: failed (error), $0.10
    S({ id: "b1", runId: "B", costUsd: 0.1, error: "boom" }),
    // task C: root + child without runId, completed, $0.20
    S({ id: "c1", name: "root", costUsd: 0.05 }), S({ id: "c2", parentId: "c1", costUsd: 0.15 }),
    // task D: running, excluded from spend
    S({ id: "d1", runId: "D", costUsd: 5, endedAt: undefined }),
  ];
  const r = costPerTask(spans);
  assert.equal(r.completed, 2);
  assert.equal(r.failed, 1);
  assert.equal(r.running, 1);
  assert.ok(Math.abs(r.spentUsd - 0.4) < 1e-9);
  assert.ok(Math.abs(r.costPerCompletedUsd - 0.2) < 1e-9, "0.40 spent / 2 completed, not 0.30/2");
  assert.ok(Math.abs(r.successRate - 2 / 3) < 1e-9);
});

test("a task whose model calls all returned nothing failed; no completions gives null, not zero", () => {
  const r = costPerTask([S({ id: "x", runId: "X", text: "  ", costUsd: 0.01 })]);
  assert.equal(r.failed, 1);
  assert.equal(r.costPerCompletedUsd, null);
  assert.equal(costPerTask([]).successRate, null);
});
