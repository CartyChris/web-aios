/**
 * "Ask about this window" sends a window's visible text to the model. It must
 * fit a prompt, and when it cannot, keep the end: that is where the newest
 * output and the error usually are.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { digestWindowText } from "../.test-build/ctxmenu.js";

test("short text passes through with whitespace collapsed", () => {
  assert.equal(digestWindowText("a   b\t c\n\n\n\n d"), "a b c\n\nd");
});

test("long text keeps head and tail, marks the cut, and fits the budget", () => {
  const raw = "HEAD " + "x".repeat(20000) + " ERROR: undefined is not a function";
  const out = digestWindowText(raw, 1000);
  assert.ok(out.startsWith("HEAD"));
  assert.ok(out.endsWith("ERROR: undefined is not a function"));
  assert.match(out, /characters omitted/);
  assert.ok(out.length < 1100);
});
