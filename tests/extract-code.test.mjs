/* The widget creator failed with "No HTML block came back" on replies that
 * plainly contained the widget. Each case below is a reply shape real models
 * produce; each used to return null. */
import test from "node:test";
import assert from "node:assert/strict";
import { extractCode, explainNoCode } from "../.test-build/extract-code.js";

const W = `<div class="w">3 days</div>\n<style>.w{color:var(--text)}</style>\n<script>let n=3;</script>`;

test("a normal fenced reply still works — the control", () => {
  assert.equal(extractCode("```html\n" + W + "\n```"), W);
});

test("prose before raw HTML: the prose is dropped, the widget kept", () => {
  assert.equal(extractCode(`Here's your countdown widget:\n\n${W}\n\nEnjoy!`), W);
});

test("a TRUNCATED reply (no closing fence) returns what was written", () => {
  const cut = "```html\n<div class=\"w\">3 days</div>\n<style>.w{color:red";
  assert.equal(extractCode(cut), '<div class="w">3 days</div>\n<style>.w{color:red');
});

test("a <think> block before the answer is ignored", () => {
  assert.equal(extractCode(`<think>The user wants a countdown. I should use <div>.</think>\n\`\`\`html\n${W}\n\`\`\``), W);
});

test("an UNCLOSED <think> means no code — not the reasoning as code", () => {
  assert.equal(extractCode("<think>Let me plan the <div> layout carefully and"), null);
});

test("tilde fences and four-backtick fences both work", () => {
  assert.equal(extractCode("~~~html\n" + W + "\n~~~"), W);
  assert.equal(extractCode("````html\n" + W + "\n````"), W);
});

test("the longest block wins when a reply shows a usage example first", () => {
  assert.equal(extractCode("Use it like:\n```\n<x/>\n```\nThe widget:\n```html\n" + W + "\n```"), W);
});

test("prose containing a bare '<' is NOT mistaken for markup", () => {
  assert.equal(extractCode("Keep the value < 10 and you are fine."), null);
});

test("JavaScript still extracts for the IDE", () => {
  assert.equal(extractCode("Sure:\nimport x from 'y';\nexport const a = 1;"), "import x from 'y';\nexport const a = 1;");
});

test("empty and whitespace replies return null", () => {
  assert.equal(extractCode(""), null);
  assert.equal(extractCode("   \n "), null);
});

test("the failure explanation says what actually came back", () => {
  assert.match(explainNoCode(""), /empty reply/);
  assert.match(explainNoCode("<think>still thinking"), /reasoning/);
  assert.match(explainNoCode("Error: model overloaded, try later"), /model overloaded/);
});
