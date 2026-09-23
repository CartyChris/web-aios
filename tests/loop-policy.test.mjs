/**
 * The Agent Loop must always end with a result. These pin the decisions that
 * make that true without a model: which attempt counts, what files it holds,
 * and when the price cap stops the loop.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFiles, pickResult, withinCap, nextIterationEstimate, fallbackReport, isEmptyResult, substance } from "../.test-build/loop-policy.js";

const it = (n, action, pass = false, plan = `plan ${n}`) => ({ n, plan, action, verdict: { pass, reason: pass ? "ok" : "no" } });

test("the screenshot case: four empty results pick nothing, so the caller must spend a final pass", () => {
  assert.equal(pickResult([it(1, ""), it(2, "   "), it(3, ""), it(4, "\n")]), null);
});

test("a verified attempt wins over a longer failed one", () => {
  const r = pickResult([it(1, "x".repeat(5000)), it(2, "short but right", true)]);
  assert.equal(r.source, "verified");
  assert.equal(r.n, 2);
});

test("with no pass, the most substantial attempt is the result, code weighted", () => {
  const prose = "I would build a kart racer with five maps and animals. ".repeat(4);
  const code = "```html\n<!doctype html><html><body><canvas></canvas></body></html>\n```";
  const r = pickResult([it(1, prose), it(2, code), it(3, "")]);
  assert.equal(r.source, "best-attempt");
  assert.equal(r.n, 2);
  assert.ok(substance(code) > code.trim().length);
});

test("a verified but empty attempt is not a result", () => {
  const r = pickResult([it(1, "", true), it(2, "something")]);
  assert.equal(r.n, 2);
  assert.equal(r.source, "best-attempt");
});

test("fenced blocks become files, named from hints then language, never overwritten", () => {
  const text = [
    "Here is `kart.html`:",
    "```html",
    "<!doctype html><html></html>",
    "```",
    "```js title=\"physics.js\"",
    "export const g = 9.8;",
    "```",
    "```css",
    "a{}",
    "```",
    "```css",
    "b{}",
    "```",
  ].join("\n");
  const files = extractFiles(text);
  assert.deepEqual(files.map((f) => f.path), ["kart.html", "physics.js", "styles.css", "styles-2.css"]);
  assert.equal(files[1].content, "export const g = 9.8;");
});

test("an unfenced HTML document is still extracted as index.html", () => {
  const files = extractFiles("Sure!\n<!DOCTYPE html>\n<html><body>hi</body></html>\nEnjoy.");
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "index.html");
  assert.ok(files[0].content.startsWith("<!DOCTYPE html>"));
  assert.ok(files[0].content.endsWith("</html>"));
});

test("a hinted path cannot escape upward", () => {
  const files = extractFiles("../../etc/passwd.txt\n```txt\nx\n```");
  assert.ok(!files[0].path.includes(".."));
  assert.ok(!files[0].path.startsWith("/"));
});

test("price cap: no cap always continues; a cap stops before it is crossed", () => {
  assert.equal(withinCap(100, 0, 5), true);
  assert.equal(withinCap(0.09, 0.1, 0.02), false);
  assert.equal(withinCap(0.05, 0.1, 0.02), true);
});

test("next-step estimate is the mean of real costs, with a prior before any", () => {
  assert.equal(nextIterationEstimate([]), 0.005);
  assert.equal(nextIterationEstimate([0.02, 0.04, 0]), 0.03);
});

test("the fallback is never empty and says it is a fallback", () => {
  const r = fallbackReport("make a game", [it(1, "")], "every attempt was empty");
  assert.ok(!isEmptyResult(r));
  assert.match(r, /No artifact was produced/);
  assert.match(r, /plan 1/);
});

import { combineVotes, gauntletBar, clearsBar, parseDefects, shouldStop } from "../.test-build/loop-policy.js";

test("a judge panel passes only when every judge passes", () => {
  assert.equal(combineVotes([{ name: "Jev", pass: true, detail: "p=0.9" }, { name: "LLM", pass: false, detail: "no maps" }]).pass, false);
  assert.match(combineVotes([{ name: "Jev", pass: true, detail: "ok" }, { name: "LLM", pass: false, detail: "no maps" }]).reason, /LLM: no maps/);
  assert.equal(combineVotes([{ name: "Jev", pass: true, detail: "ok" }, { name: "LLM", pass: true, detail: "ok" }]).pass, true);
  assert.equal(combineVotes([]).pass, false);
});

test("the gauntlet bar only rises", () => {
  assert.equal(gauntletBar(1).redTeam, false);
  const d = [{ severity: "medium", issue: "laggy" }];
  assert.equal(clearsBar(d, gauntletBar(2).maxSeverity), true);
  assert.equal(clearsBar(d, gauntletBar(3).maxSeverity), false);
  assert.equal(clearsBar([{ severity: "high", issue: "crash" }], gauntletBar(2).maxSeverity), false);
  assert.equal(clearsBar([{ severity: "low", issue: "typo" }], gauntletBar(5).maxSeverity), true);
});

test("red-team replies: fenced, unknown severity counts as high, unreadable is null not empty", () => {
  const d = parseDefects('Here:\n```json\n{"defects":[{"severity":"Medium","issue":"no pause"},{"severity":"??","issue":"crash on load"},{"issue":""}]}\n```');
  assert.deepEqual(d, [{ severity: "medium", issue: "no pause" }, { severity: "high", issue: "crash on load" }]);
  assert.deepEqual(parseDefects('{"defects":[]}'), []);
  assert.equal(parseDefects("looks fine to me"), null);
});

test("stop-when-done: off runs every round; on stops at the first pass; a gauntlet only at the strictest bar", () => {
  assert.equal(shouldStop(true, { stopOnPass: false, gauntlet: false, round: 2 }), false);
  assert.equal(shouldStop(true, { stopOnPass: true, gauntlet: false, round: 2 }), true);
  assert.equal(shouldStop(false, { stopOnPass: true, gauntlet: false, round: 2 }), false);
  assert.equal(shouldStop(true, { stopOnPass: true, gauntlet: true, round: 2 }), false);
  assert.equal(shouldStop(true, { stopOnPass: true, gauntlet: true, round: 3 }), true);
});
