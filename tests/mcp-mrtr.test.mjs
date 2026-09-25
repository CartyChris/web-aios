/**
 * MCP Multi Round-Trip Requests, client side (spec 2026-07-28, basic/patterns/mrtr).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyResult, buildRetryParams, runMrtr, parseElicitSchema, coerceElicit, samplingToChat, samplingResult,
  specMeta, capabilitiesObject, parseRpcBody, toolResultText, unanswered, elicitAccept,
} from "../.test-build/mcp-mrtr.js";

const ALL = { elicitation: true, sampling: true, roots: true };
const FORM = {
  method: "elicitation/create",
  params: {
    mode: "form", message: "Please provide your GitHub username",
    requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
};
const SAMPLE = {
  method: "sampling/createMessage",
  params: { messages: [{ role: "user", content: { type: "text", text: "What is the capital of France?" } }], systemPrompt: "You are a helpful assistant.", maxTokens: 100 },
};

test("absent resultType is complete (older servers); unknown resultType is invalid", () => {
  assert.equal(classifyResult("tools/call", { content: [] }, ALL).kind, "complete");
  assert.equal(classifyResult("tools/call", { resultType: "complete" }, ALL).kind, "complete");
  assert.equal(classifyResult("tools/call", { resultType: "maybe" }, ALL).kind, "invalid");
});

test("the spec example parses into one form elicitation and one sampling request", () => {
  const c = classifyResult("tools/call", { resultType: "input_required", inputRequests: { github_login: FORM, capital_of_france: SAMPLE }, requestState: "AEAD-protected blob" }, ALL);
  assert.equal(c.kind, "input_required");
  assert.deepEqual(c.requests.map((r) => [r.key, r.kind]), [["github_login", "elicit-form"], ["capital_of_france", "sampling"]]);
  assert.equal(c.requests[0].fields[0].name, "name");
  assert.equal(c.requests[0].fields[0].required, true);
  assert.equal(c.requestState, "AEAD-protected blob");
});

test("input_required is refused where the spec forbids it, or when it is empty", () => {
  assert.equal(classifyResult("tools/list", { resultType: "input_required", requestState: "s" }, ALL).kind, "invalid");
  assert.equal(classifyResult("prompts/get", { resultType: "input_required", requestState: "s" }, ALL).kind, "input_required");
  assert.equal(classifyResult("tools/call", { resultType: "input_required" }, ALL).kind, "invalid");
  assert.equal(classifyResult("tools/call", { resultType: "input_required", requestState: 7 }, ALL).kind, "invalid");
});

test("a request for an undeclared capability is a server fault", () => {
  const noSampling = { elicitation: true, sampling: false, roots: false };
  const c = classifyResult("tools/call", { resultType: "input_required", inputRequests: { s: SAMPLE } }, noSampling);
  assert.equal(c.kind, "invalid");
  assert.match(c.reason, /did not declare/);
  assert.equal(classifyResult("tools/call", { resultType: "input_required", inputRequests: { x: { method: "evil/run" } } }, ALL).kind, "invalid");
});

test("retry echoes requestState exactly, omits it when absent, and replaces last round's fields", () => {
  const orig = { name: "deploy", arguments: { env: "prod" } };
  const r1 = buildRetryParams(orig, { approval: { action: "accept", content: { ticket: "OPS-2575" } } }, "opaque-deploy-state-v1");
  assert.deepEqual(r1, { name: "deploy", arguments: { env: "prod" }, inputResponses: { approval: { action: "accept", content: { ticket: "OPS-2575" } } }, requestState: "opaque-deploy-state-v1" });
  const r2 = buildRetryParams({ ...r1 }, {}, undefined);
  assert.equal("requestState" in r2, false, "MUST NOT include requestState the server did not send");
  assert.equal("inputResponses" in r2, false);
  // Whitespace and odd bytes survive untouched.
  assert.equal(buildRetryParams(orig, {}, "  a+b/=\n").requestState, "  a+b/=\n");
});

test("the loop answers, retries with fresh params and completes", async () => {
  const sent = [];
  const out = await runMrtr(
    "tools/call",
    { name: "t", arguments: {} },
    async (p, round) => {
      sent.push(p);
      if (round === 1) return { resultType: "input_required", inputRequests: { github_login: FORM }, requestState: "S1" };
      return { resultType: "complete", content: [{ type: "text", text: "hello octocat" }] };
    },
    async (reqs) => ({ [reqs[0].key]: elicitAccept({ name: "octocat" }) }),
    { caps: ALL },
  );
  assert.equal(out.status, "complete");
  assert.equal(out.rounds, 2);
  assert.equal("inputResponses" in sent[0], false);
  assert.deepEqual(sent[1].inputResponses, { github_login: { action: "accept", content: { name: "octocat" } } });
  assert.equal(sent[1].requestState, "S1");
  assert.equal(toolResultText(out.result).text, "hello octocat");
});

test("state-only input_required retries immediately without asking anyone", async () => {
  let asked = 0;
  const out = await runMrtr("tools/call", { name: "t" },
    async (_p, round) => (round < 3 ? { resultType: "input_required", requestState: `s${round}` } : { content: [] }),
    async () => { asked++; return {}; }, { caps: ALL });
  assert.equal(out.status, "complete");
  assert.equal(asked, 0);
});

test("the loop is bounded and can be cancelled", async () => {
  const forever = async () => ({ resultType: "input_required", inputRequests: { k: FORM } });
  const ex = await runMrtr("tools/call", {}, forever, async () => ({ k: elicitAccept({ name: "x" }) }), { caps: ALL, maxRounds: 3 });
  assert.deepEqual(ex, { status: "exhausted", rounds: 3 });
  const cancel = await runMrtr("tools/call", {}, forever, async () => null, { caps: ALL });
  assert.deepEqual(cancel, { status: "cancelled", rounds: 1 });
});

test("elicitation forms: flat primitives only, validated answers, empty optionals omitted", () => {
  assert.equal(parseElicitSchema({ type: "object", properties: { a: { type: "object" } } }).ok, false);
  const p = parseElicitSchema({ type: "object", properties: {
    n: { type: "integer" }, c: { type: "string", enum: ["red", "blue"] }, ok: { type: "boolean" }, note: { type: "string" },
  }, required: ["n", "c"] });
  assert.equal(p.ok, true);
  const bad = coerceElicit(p.fields, { n: "1.5", c: "green" });
  assert.equal(bad.ok, false);
  assert.deepEqual(Object.keys(bad.errors).sort(), ["c", "n"]);
  const good = coerceElicit(p.fields, { n: "3", c: "red", ok: true, note: "  " });
  assert.deepEqual(good, { ok: true, content: { n: 3, c: "red", ok: true } });
});

test("sampling maps to a chat call and back to a CreateMessageResult", () => {
  const chat = samplingToChat(SAMPLE.params);
  assert.equal(chat.system, "You are a helpful assistant.");
  assert.deepEqual(chat.messages, [{ role: "user", content: "What is the capital of France?" }]);
  assert.equal(chat.maxTokens, 100);
  assert.equal(samplingToChat({ messages: [], maxTokens: 10_000_000 }).maxTokens, 8192);
  assert.deepEqual(samplingResult("Paris", "m"), { role: "assistant", content: { type: "text", text: "Paris" }, model: "m", stopReason: "endTurn" });
});

test("_meta uses the spec's key names and declares capabilities", () => {
  const m = specMeta("2026-07-28", { name: "Web-AIOS", version: "2" }, { elicitation: true, sampling: false, roots: false });
  assert.equal(m["io.modelcontextprotocol/protocolVersion"], "2026-07-28");
  assert.deepEqual(m["io.modelcontextprotocol/clientCapabilities"], { elicitation: { form: {} } });
  assert.deepEqual(m["io.modelcontextprotocol/clientInfo"], { name: "Web-AIOS", version: "2" });
  assert.deepEqual(capabilitiesObject({ elicitation: false, sampling: true, roots: true }), { sampling: {}, roots: {} });
});

test("rpc bodies: JSON, or the last result frame of an SSE stream", () => {
  assert.deepEqual(parseRpcBody("application/json", '{"result":{"a":1}}'), { result: { a: 1 } });
  const sse = 'data: {"method":"notifications/progress"}\n\ndata: {"jsonrpc":"2.0","id":1,"result":{"resultType":"input_required","requestState":"s"}}\n\n';
  assert.equal(parseRpcBody("text/event-stream", sse).result.requestState, "s");
  assert.equal(parseRpcBody("application/json", ""), null);
  assert.deepEqual(unanswered([{ key: "a" }, { key: "b" }], { a: 1 }), ["b"]);
});
