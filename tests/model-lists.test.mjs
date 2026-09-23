/* Model lists: live listing merged with the catalogue, and every provider's
 * listing shape parsed.
 *
 * The rule under test: curated catalogue ids lead, the rest of the live list
 * follows newest first, and catalogue ids the provider no longer lists are
 * kept at the end, flagged — a refresh never makes the picker shorter.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  normaliseEntries, sortNewestFirst, mergeModelLists,
  parseAnthropicModels, parseGoogleModels, parseOpenAIModels,
  ago, describeRefresh,
} from "../.test-build/model-lists.js";

const ids = (list) => list.map((m) => m.id);

/* ── merge ───────────────────────────────────────────────────────────────── */

test("catalogue ids lead in catalogue order, then live extras newest first, then unlisted", () => {
  const live = [
    { id: "old-x", name: "old-x", created: 100 },
    { id: "b", name: "B live", created: 50, inUsd: 2 },
    { id: "new-y", name: "new-y", created: 900 },
    { id: "a", name: "A live", created: 10 },
  ];
  const merged = mergeModelLists(live, ["a", "b", "retired"]);
  assert.deepEqual(ids(merged), ["a", "b", "new-y", "old-x", "retired"]);
  // Live metadata wins for catalogue ids: it is the fresher fact.
  assert.equal(merged[1].name, "B live");
  assert.equal(merged[1].inUsd, 2);
  assert.equal(merged[0].unlisted, undefined);
  assert.equal(merged[4].unlisted, true);
});

test("no live list returns the catalogue unchanged, never an empty picker", () => {
  assert.deepEqual(ids(mergeModelLists(null, ["a", "b"])), ["a", "b"]);
  assert.deepEqual(ids(mergeModelLists([], ["a", "b"])), ["a", "b"]);
  assert.equal(mergeModelLists([], ["a"])[0].unlisted, undefined);
});

test("duplicates are removed, first occurrence wins, blanks dropped", () => {
  const merged = mergeModelLists(["x", "x", " ", { id: "y", name: "" }], ["x", "x"]);
  assert.deepEqual(ids(merged), ["x", "y"]);
  assert.equal(merged[1].name, "y");
});

test("normaliseEntries tolerates the old bare-string shape and trims ids", () => {
  assert.deepEqual(normaliseEntries(["  gpt-6-sol ", null, { id: "a", name: "A" }]), [
    { id: "gpt-6-sol", name: "gpt-6-sol" },
    { id: "a", name: "A" },
  ]);
});

test("sortNewestFirst: newest first, undated last, ties by id", () => {
  const out = sortNewestFirst([{ id: "c", name: "c" }, { id: "b", name: "b", created: 5 }, { id: "a", name: "a", created: 5 }, { id: "z", name: "z", created: 9 }]);
  assert.deepEqual(ids(out), ["z", "a", "b", "c"]);
});

/* ── provider shapes ─────────────────────────────────────────────────────── */

test("Anthropic: data[].id, display_name, ISO created_at -> newest first", () => {
  const out = parseAnthropicModels({
    data: [
      { type: "model", id: "claude-sonnet-5", display_name: "Claude Sonnet 5", created_at: "2026-06-30T00:00:00Z" },
      { type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-09-22T00:00:00Z" },
      { type: "model", id: "", display_name: "blank" },
    ],
    has_more: false,
  });
  assert.deepEqual(ids(out), ["claude-opus-5-5", "claude-sonnet-5"]);
  assert.equal(out[0].name, "Claude Opus 5.5");
  assert.equal(out[0].created, Date.parse("2026-09-22T00:00:00Z") / 1000);
});

test("Google: strips models/ and keeps only generateContent models", () => {
  const out = parseGoogleModels({
    models: [
      { name: "models/gemini-3.8-flash", displayName: "Gemini 3.8 Flash", inputTokenLimit: 1048576, supportedGenerationMethods: ["generateContent", "countTokens"] },
      { name: "models/text-embedding-005", displayName: "Embedding", supportedGenerationMethods: ["embedContent"] },
      { name: "models/gemini-3.1-pro-preview", supportedGenerationMethods: ["generateContent"] },
      { name: "models/no-methods" },
    ],
  });
  assert.deepEqual(ids(out), ["gemini-3.8-flash", "gemini-3.1-pro-preview"]);
  assert.equal(out[0].context, 1048576);
  assert.equal(out[1].name, "gemini-3.1-pro-preview");
});

test("OpenAI-dialect (and Ollama / LM Studio /v1/models): data[].id", () => {
  const out = parseOpenAIModels({ object: "list", data: [{ id: "llama3.2", created: 1 }, { id: "gemma4", created: 2 }, { object: "model" }] });
  assert.deepEqual(ids(out), ["gemma4", "llama3.2"]);
});

test("garbage in, empty list out, for every parser", () => {
  for (const p of [parseAnthropicModels, parseGoogleModels, parseOpenAIModels]) {
    assert.deepEqual(p(null), []);
    assert.deepEqual(p({}), []);
    assert.deepEqual(p({ data: "nope", models: 3 }), []);
  }
});

/* ── saying what happened ────────────────────────────────────────────────── */

test("ago uses the injected clock", () => {
  const now = 10_000_000;
  assert.equal(ago(now - 10_000, now), "just now");
  assert.equal(ago(now - 5 * 60_000, now), "5 min ago");
  assert.equal(ago(now - 3 * 3_600_000, now), "3 h ago");
  assert.equal(ago(now - 3 * 86_400_000, now), "3 d ago");
  assert.equal(ago(now + 60_000, now), "just now");
});

test("describeRefresh says plainly when a refresh fell back to the catalogue", () => {
  const now = 1_000_000;
  assert.match(describeRefresh(undefined, now), /not refreshed yet/);
  assert.equal(describeRefresh({ source: "live", at: now, count: 12 }, now), "live from the provider · 12 models · refreshed just now");
  const fb = describeRefresh({ source: "catalog", at: now - 120_000, count: 4, reason: "no API key for Anthropic" }, now);
  assert.match(fb, /fell back to the catalogue: no API key for Anthropic/);
  assert.match(fb, /2 min ago/);
});
