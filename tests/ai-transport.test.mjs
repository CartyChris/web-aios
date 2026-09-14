/**
 * Transport tests — run with: npm test
 *
 * The multi-dialect SSE client is the riskiest code in the project: it is
 * hand-written, it runs in two different runtimes, and a parsing bug shows up
 * as a silently empty answer rather than an error. These tests drive it with
 * recorded frames from all three provider dialects, including the framing
 * cases that actually break naive parsers — a chunk split mid-frame, several
 * `data:` lines in one frame, and CRLF line endings.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRequest, parseChunk, completeChat } from "../.test-build/ai-transport.js";

/** Serve a canned SSE body, optionally split at awkward byte boundaries. */
function mockFetch(frames, { status = 200, chunkAt = null } = {}) {
  const body = frames.join("");
  const pieces = chunkAt ? [body.slice(0, chunkAt), body.slice(chunkAt)] : [body];
  globalThis.fetch = async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    text: async () => body,
    body: {
      getReader() {
        let i = 0;
        const enc = new TextEncoder();
        return {
          read: async () =>
            i < pieces.length ? { done: false, value: enc.encode(pieces[i++]) } : { done: true, value: undefined },
        };
      },
    },
  });
}

/* ── Request shaping ───────────────────────────────────────────────────── */

test("openai dialect posts to /chat/completions with a bearer token", () => {
  const { url, init } = buildRequest({
    dialect: "openai", baseUrl: "https://api.example.com/v1/", apiKey: "sk-test",
    model: "m", messages: [{ role: "user", content: "hi" }], stream: true,
  });
  assert.equal(url, "https://api.example.com/v1/chat/completions");
  assert.equal(init.headers.authorization, "Bearer sk-test");
  const sent = JSON.parse(init.body);
  assert.equal(sent.model, "m");
  assert.equal(sent.stream, true);
});

test("anthropic dialect hoists the system prompt out of messages", () => {
  const { url, init } = buildRequest({
    dialect: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: "k", model: "claude",
    messages: [{ role: "system", content: "be terse" }, { role: "user", content: "hi" }],
  });
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.equal(init.headers["x-api-key"], "k");
  const sent = JSON.parse(init.body);
  assert.equal(sent.system, "be terse");
  assert.equal(sent.messages.length, 1, "system must not remain in messages[]");
  assert.equal(sent.messages[0].role, "user");
});

test("google dialect maps assistant->model and carries the key in the query", () => {
  const { url, init } = buildRequest({
    dialect: "google", baseUrl: "https://gen.example.com/v1beta", apiKey: "gk", model: "gemini-3-pro",
    messages: [{ role: "system", content: "sys" }, { role: "assistant", content: "prior" }],
    stream: true,
  });
  assert.match(url, /models\/gemini-3-pro:streamGenerateContent\?alt=sse&key=gk$/);
  const sent = JSON.parse(init.body);
  assert.equal(sent.systemInstruction.parts[0].text, "sys");
  assert.equal(sent.contents[0].role, "model", "assistant must map to 'model'");
});

/* ── Chunk parsing ─────────────────────────────────────────────────────── */

test("parseChunk reads a delta from each dialect", () => {
  assert.equal(parseChunk("openai", JSON.stringify({ choices: [{ delta: { content: "A" } }] })).delta, "A");
  assert.equal(parseChunk("anthropic", JSON.stringify({ type: "content_block_delta", delta: { text: "B" } })).delta, "B");
  assert.equal(parseChunk("google", JSON.stringify({ candidates: [{ content: { parts: [{ text: "C" }] } }] })).delta, "C");
});

test("parseChunk surfaces provider errors as thrown errors", () => {
  assert.throws(() => parseChunk("openai", JSON.stringify({ error: { message: "bad key" } })), /bad key/);
  assert.throws(() => parseChunk("anthropic", JSON.stringify({ type: "error", error: { message: "overloaded" } })), /overloaded/);
});

test("parseChunk tolerates junk instead of throwing", () => {
  assert.equal(parseChunk("openai", "not json"), null);
  assert.equal(parseChunk("openai", ""), null);
  assert.equal(parseChunk("openai", "[DONE]").done, true);
});

/* ── Streaming ─────────────────────────────────────────────────────────── */

test("streamChat reassembles a delta split across network chunks", async () => {
  const frames = [
    'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
    "data: [DONE]\n\n",
  ];
  // Split mid-frame: the classic way a naive SSE reader loses a token.
  mockFetch(frames, { chunkAt: 30 });
  const out = await completeChat({ dialect: "openai", baseUrl: "https://x/v1", apiKey: "k", model: "m", messages: [{ role: "user", content: "hi" }] });
  assert.equal(out.text, "Hello world");
});

test("streamChat handles CRLF framing and multi-line frames", async () => {
  mockFetch([
    'data: {"choices":[{"delta":{"content":"a"}}]}\r\ndata: {"choices":[{"delta":{"content":"b"}}]}\r\n\r\n',
    "data: [DONE]\r\n\r\n",
  ]);
  const out = await completeChat({ dialect: "openai", baseUrl: "https://x/v1", apiKey: "k", model: "m", messages: [{ role: "user", content: "hi" }] });
  assert.equal(out.text, "ab");
});

test("streamChat reports usage when the provider sends it", async () => {
  mockFetch([
    'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":4}}\n\n',
    "data: [DONE]\n\n",
  ]);
  const out = await completeChat({ dialect: "openai", baseUrl: "https://x/v1", apiKey: "k", model: "m", messages: [{ role: "user", content: "hi" }] });
  assert.equal(out.usage.inputTokens, 11);
  assert.equal(out.usage.outputTokens, 4);
});

test("anthropic message_stop ends the stream", async () => {
  mockFetch([
    'data: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n',
    'data: {"type":"message_stop"}\n\n',
    'data: {"type":"content_block_delta","delta":{"text":"NEVER"}}\n\n',
  ]);
  const out = await completeChat({ dialect: "anthropic", baseUrl: "https://a/v1", apiKey: "k", model: "c", messages: [{ role: "user", content: "hi" }] });
  assert.equal(out.text, "hi", "content after message_stop must be ignored");
});

test("a non-2xx response throws with the provider's body", async () => {
  mockFetch(['{"error":"nope"}'], { status: 401 });
  await assert.rejects(
    completeChat({ dialect: "openai", baseUrl: "https://x/v1", apiKey: "bad", model: "m", messages: [{ role: "user", content: "hi" }] }),
    /401/,
  );
});
