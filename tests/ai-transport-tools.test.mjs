/**
 * Native tool calling in the universal transport, for all three dialects.
 *
 * The frames below are shaped exactly like each provider's documented
 * streaming format (OpenAI chat.completions tool_calls deltas, Anthropic
 * content_block_start{tool_use} + input_json_delta, Gemini functionCall
 * parts). They are recorded shapes, not a live capture from this machine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseChunk, buildRequest, ToolCallAccumulator, parseToolArgs, toGoogleSchema } from "../.test-build/ai-transport.js";

const TOOLS = [{
  name: "read_file",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
}];
const base = { baseUrl: "https://x.test/v1", apiKey: "k", model: "m", stream: true };
const body = (r) => JSON.parse(r.init.body);

function fold(dialect, frames) {
  const acc = new ToolCallAccumulator();
  let text = "";
  for (const f of frames) {
    const c = parseChunk(dialect, typeof f === "string" ? f : JSON.stringify(f));
    if (!c) continue;
    text += c.delta;
    acc.add(c.toolCalls);
  }
  return { text, calls: acc.result() };
}

test("OpenAI: streamed tool_calls deltas assemble into complete calls", () => {
  const frames = [
    { choices: [{ delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "read_file", arguments: "" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"pa" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "th\":\"/a.txt\"}" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "list_dir", arguments: "{}" } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    "[DONE]",
  ];
  const { text, calls } = fold("openai", frames);
  assert.equal(text, "");
  assert.deepEqual(calls, [
    { id: "call_a", name: "read_file", args: "{\"path\":\"/a.txt\"}" },
    { id: "call_b", name: "list_dir", args: "{}" },
  ]);
});

test("Anthropic: tool_use block start + input_json_delta assemble", () => {
  const frames = [
    { type: "message_start", message: { id: "msg_1" } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Reading." } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "read_file", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"path\": \"/b" } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: ".md\"}" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } },
    { type: "message_stop" },
  ];
  const { text, calls } = fold("anthropic", frames);
  assert.equal(text, "Reading.");
  assert.deepEqual(calls, [{ id: "toolu_1", name: "read_file", args: "{\"path\": \"/b.md\"}" }]);
});

test("Google: whole functionCall parts, two chunks, positional ids", () => {
  const frames = [
    { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "read_file", args: { path: "/c" } } }] } }] },
    { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "read_file", args: { path: "/d" } } }] }, finishReason: "STOP" }] },
  ];
  const { calls } = fold("google", frames);
  assert.equal(calls.length, 2, "a second chunk's call at part index 0 must not merge into the first");
  assert.deepEqual(calls.map((c) => [c.id, c.name, JSON.parse(c.args).path]), [["call_0", "read_file", "/c"], ["call_1", "read_file", "/d"]]);
});

test("requests without tools are unchanged: no tools key, plain role/content messages", () => {
  const msgs = [{ role: "system", content: "s" }, { role: "user", content: "hi" }, { role: "assistant", content: "yo" }];
  const o = body(buildRequest({ ...base, dialect: "openai", messages: msgs }));
  assert.equal("tools" in o, false);
  assert.deepEqual(o.messages, [{ role: "system", content: "s" }, { role: "user", content: "hi" }, { role: "assistant", content: "yo" }]);
  const a = body(buildRequest({ ...base, dialect: "anthropic", messages: msgs }));
  assert.equal("tools" in a, false);
  assert.deepEqual(a.messages, [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }]);
  const g = body(buildRequest({ ...base, dialect: "google", messages: msgs }));
  assert.equal("tools" in g, false);
});

test("OpenAI request: tools declared, assistant tool_calls and tool results round-trip", () => {
  const msgs = [
    { role: "user", content: "read it" },
    { role: "assistant", content: "", toolCalls: [{ id: "call_a", name: "read_file", args: "{\"path\":\"/a\"}" }] },
    { role: "tool", content: "hello", toolCallId: "call_a", toolName: "read_file" },
  ];
  const o = body(buildRequest({ ...base, dialect: "openai", messages: msgs, tools: TOOLS }));
  assert.equal(o.tools[0].type, "function");
  assert.equal(o.tools[0].function.name, "read_file");
  assert.deepEqual(o.messages[1], { role: "assistant", content: null, tool_calls: [{ id: "call_a", type: "function", function: { name: "read_file", arguments: "{\"path\":\"/a\"}" } }] });
  assert.deepEqual(o.messages[2], { role: "tool", tool_call_id: "call_a", content: "hello" });
});

test("Anthropic request: tool_use blocks and merged tool_result user turn", () => {
  const msgs = [
    { role: "user", content: "go" },
    { role: "assistant", content: "ok", toolCalls: [{ id: "t1", name: "a", args: "{\"x\":1}" }, { id: "t2", name: "b", args: "not json" }] },
    { role: "tool", content: "r1", toolCallId: "t1", toolName: "a" },
    { role: "tool", content: "r2", toolCallId: "t2", toolName: "b" },
  ];
  const a = body(buildRequest({ ...base, dialect: "anthropic", messages: msgs, tools: TOOLS }));
  assert.equal(a.tools[0].input_schema.type, "object");
  assert.deepEqual(a.messages[1].content, [{ type: "text", text: "ok" }, { type: "tool_use", id: "t1", name: "a", input: { x: 1 } }, { type: "tool_use", id: "t2", name: "b", input: {} }]);
  assert.equal(a.messages.length, 3, "two results share one user turn");
  assert.deepEqual(a.messages[2].content.map((b) => b.tool_use_id), ["t1", "t2"]);
});

test("Google request: functionDeclarations with schema stripped to the portable subset", () => {
  const msgs = [
    { role: "user", content: "go" },
    { role: "assistant", content: "", toolCalls: [{ id: "call_0", name: "read_file", args: "{\"path\":\"/a\"}" }] },
    { role: "tool", content: "body", toolCallId: "call_0", toolName: "read_file" },
  ];
  const g = body(buildRequest({ ...base, dialect: "google", messages: msgs, tools: TOOLS }));
  const decl = g.tools[0].functionDeclarations[0];
  assert.equal(decl.name, "read_file");
  assert.equal("additionalProperties" in decl.parameters, false);
  assert.deepEqual(g.contents[1], { role: "model", parts: [{ functionCall: { name: "read_file", args: { path: "/a" } } }] });
  assert.deepEqual(g.contents[2], { role: "user", parts: [{ functionResponse: { name: "read_file", response: { content: "body" } } }] });
});

test("parseToolArgs reports bad JSON instead of throwing", () => {
  assert.deepEqual(parseToolArgs("{\"a\":1}"), { ok: true, value: { a: 1 } });
  assert.equal(parseToolArgs("{oops").ok, false);
  assert.equal(parseToolArgs("[1]").ok, false);
  assert.deepEqual(toGoogleSchema({ type: "object", $schema: "x", properties: { a: { type: "string", pattern: "p" } } }), { type: "object", properties: { a: { type: "string" } } });
});
