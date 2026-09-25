/**
 * The harness-upgrade rule: the model never marks its own work passing. A run
 * the model "finished" but the definition of done failed must not count.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runPassed } from "../.test-build/harness/passed.js";

test("finished + verdict pass is done", () => {
  assert.equal(runPassed({ status: "finished", verdict: { pass: true, pendingHuman: [] } }).pass, true);
});

test("the model saying finish is not enough: failed or missing verdicts do not pass", () => {
  assert.equal(runPassed({ status: "finished", verdict: { pass: false, pendingHuman: [] } }).pass, false);
  assert.equal(runPassed({ status: "finished", verdict: null }).pass, false);
});

test("a pending human criterion is not a pass yet", () => {
  const r = runPassed({ status: "finished", verdict: { pass: true, pendingHuman: ["Chris"] } });
  assert.equal(r.pass, false);
  assert.match(r.why, /Chris/);
});

test("anything but finished fails, whatever the verdict says", () => {
  assert.equal(runPassed({ status: "cap_exhausted", verdict: { pass: true } }).pass, false);
});
