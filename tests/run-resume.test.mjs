/**
 * Resumable runs: which steps remain, interrupted steps, and URL batches.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { remainingSteps, stepProgress, markInterrupted, parseUrlBatch } from "../.test-build/run-resume.js";

test("remaining skips ready and verified; blocked is optional", () => {
  const st = [{ id: "1", status: "verified" }, { id: "2", status: "ready" }, { id: "3", status: "blocked" }, { id: "4", status: "pending" }, { id: "5", status: "invalidated" }];
  assert.deepEqual(remainingSteps(st).map((s) => s.id), ["3", "4", "5"]);
  assert.deepEqual(remainingSteps(st, false).map((s) => s.id), ["4", "5"]);
  assert.deepEqual(stepProgress(st), { done: 2, total: 5, fraction: 0.4 });
  assert.deepEqual(stepProgress([]), { done: 0, total: 0, fraction: null });
});

test("an active step after reload was interrupted and goes back to pending", () => {
  const r = markInterrupted([{ status: "active" }, { status: "ready" }]);
  assert.equal(r.interrupted, 1);
  assert.equal(r.steps[0].status, "pending");
  assert.equal(r.steps[1].status, "ready");
});

test("URL batches: http(s) only, trailing punctuation trimmed, deduped, capped", () => {
  const got = parseUrlBatch("https://a.test/x, http://b.test\njavascript:alert(1) https://a.test/x ftp://c https://d.test/.", ["http://b.test"]);
  assert.deepEqual(got, ["https://a.test/x", "https://d.test/"]);
  assert.equal(parseUrlBatch(Array.from({ length: 40 }, (_, i) => `https://h${i}.test`).join(" "), [], 25).length, 25);
});

import { toCsv } from "../.test-build/run-resume.js";

test("CSV quotes what needs quoting and defuses formulas", () => {
  const csv = toCsv(["title", "detail"], [["a,b", 'say "hi"'], ["=SUM(A1)", "line\nbreak"], [undefined, 3]]);
  assert.equal(csv, 'title,detail\r\n"a,b","say ""hi"""\r\n\'=SUM(A1),"line\nbreak"\r\n,3');
});
