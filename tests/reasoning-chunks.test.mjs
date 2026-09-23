/**
 * Reasoning-model frames. A model that spends its whole token budget thinking
 * streams nothing but reasoning and then stops for length. Before this, the
 * parser read only `content`, so that reply looked identical to a model that
 * answered with nothing at all, and the Agent Loop recorded four empty
 * results in a row with no way to tell why.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseChunk, buildRequest } from "../.test-build/ai-transport.js";

test("OpenRouter reasoning deltas are kept apart from the answer", () => {
  const c = parseChunk("openai", JSON.stringify({ choices: [{ delta: { content: "", reasoning: "Let me plan the track" } }] }));
  assert.equal(c.delta, "");
  assert.equal(c.reasoning, "Let me plan the track");
});

test("DeepSeek reasoning_content is read as reasoning", () => {
  const c = parseChunk("openai", JSON.stringify({ choices: [{ delta: { reasoning_content: "thinking" } }] }));
  assert.equal(c.reasoning, "thinking");
  assert.equal(c.delta, "");
});

test("finish_reason length is surfaced so a truncation is visible", () => {
  const c = parseChunk("openai", JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] }));
  assert.equal(c.finish, "length");
  const d = parseChunk("openai", JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }));
  assert.equal(d.finish, "stop");
});

test("a null content with reasoning does not become the string 'null'", () => {
  const c = parseChunk("openai", JSON.stringify({ choices: [{ delta: { content: null, reasoning: "x" } }] }));
  assert.equal(c.delta, "");
});

test("Anthropic thinking_delta and max_tokens stop reason", () => {
  const t = parseChunk("anthropic", JSON.stringify({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } }));
  assert.equal(t.reasoning, "hmm");
  assert.equal(t.delta, "");
  const m = parseChunk("anthropic", JSON.stringify({ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 9 } }));
  assert.equal(m.finish, "length");
});

test("Gemini thought parts are reasoning, not answer text", () => {
  const g = parseChunk("google", JSON.stringify({ candidates: [{ content: { parts: [{ text: "plan", thought: true }, { text: "answer" }] }, finishReason: "MAX_TOKENS" }] }));
  assert.equal(g.delta, "answer");
  assert.equal(g.reasoning, "plan");
  assert.equal(g.finish, "length");
});

test("reasoning effort goes to OpenRouter as reasoning.effort, and nowhere unknown", () => {
  const or = JSON.parse(buildRequest({ dialect: "openai", baseUrl: "https://openrouter.ai/api/v1", apiKey: "k", model: "m", messages: [{ role: "user", content: "hi" }], reasoningEffort: "low" }).init.body);
  assert.deepEqual(or.reasoning, { effort: "low" });
  const ds = JSON.parse(buildRequest({ dialect: "openai", baseUrl: "https://api.deepseek.com/v1", apiKey: "k", model: "m", messages: [{ role: "user", content: "hi" }], reasoningEffort: "low" }).init.body);
  assert.equal(ds.reasoning, undefined);
  assert.equal(ds.reasoning_effort, undefined);
});
