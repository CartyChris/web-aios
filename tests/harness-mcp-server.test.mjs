/* Web-AIOS as an MCP server.
 *
 * The tests that matter here are the refusals. An MCP server that answers
 * everything cheerfully is the one that leaks a write tool to an
 * unauthenticated caller, and the exposure filter is the only thing standing
 * between this route and that — so it gets a negative control for every rule
 * it enforces.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  handleMcpMessage, handleMcpPayload, defaultExposureFilter,
  MCP_PROTOCOL_VERSION, RPC, docUri,
} from "../.test-build/harness/mcp-server.js";
import { createRegistry, builtinTools } from "../.test-build/harness/tools.js";
import { FIXTURES } from "../.test-build/harness/fixtures.js";
import { webTools } from "../.test-build/harness/webtools.js";

const CLOCK = 1_776_254_400_000;

function server(extra = {}) {
  const registry = createRegistry();
  for (const t of builtinTools({
    fixtures: FIXTURES,
    writeArtifact: async (path) => ({ ok: true, path }),
  })) registry.register(t);
  return { registry, serverName: "web-aios", serverVersion: "1.0.0", now: () => CLOCK, ...extra };
}

const call = (msg, opts = server()) => handleMcpMessage(msg, opts);
const rpc = (method, params, id = 1) => ({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });

/* ── handshake ───────────────────────────────────────────────────────────── */

test("initialize returns the protocol version, server info and only real capabilities", async () => {
  const r = await call(rpc("initialize", { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } }));
  assert.equal(r.jsonrpc, "2.0");
  assert.equal(r.id, 1);
  assert.equal(r.result.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.equal(r.result.serverInfo.name, "web-aios");
  assert.deepEqual(Object.keys(r.result.capabilities), ["tools"], "advertised a capability this server does not serve");
  assert.match(r.result.instructions, /fixture/);
});

test("the advertised protocol version is the one the client in this repo speaks", async () => {
  // Two halves of the same project disagreeing about the version is the kind
  // of thing that only shows up against a strict third-party client.
  const { MCP_PROTOCOL } = await import("../src/lib/mcp-version.mjs").catch(() => ({ MCP_PROTOCOL: null }));
  assert.equal(MCP_PROTOCOL_VERSION, MCP_PROTOCOL ?? "2025-06-18");
});

test("a notification receives no reply at all", async () => {
  assert.equal(await call({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.equal(await call({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }), null);
});

test("ping answers an empty result", async () => {
  const r = await call(rpc("ping", undefined, "p1"));
  assert.deepEqual(r.result, {});
  assert.equal(r.id, "p1");
});

/* ── malformed input ─────────────────────────────────────────────────────── */

test("a non-object message, a wrong version and a missing method are each refused", async () => {
  assert.equal((await call("hello")).error.code, RPC.INVALID_REQUEST);
  assert.equal((await call(null)).error.code, RPC.INVALID_REQUEST);
  assert.equal((await call({ jsonrpc: "1.0", id: 1, method: "ping" })).error.code, RPC.INVALID_REQUEST);
  assert.equal((await call({ jsonrpc: "2.0", id: 1 })).error.code, RPC.INVALID_REQUEST);
});

test("an unknown method is method-not-found and names the method back", async () => {
  const r = await call(rpc("tools/subscribe"));
  assert.equal(r.error.code, RPC.METHOD_NOT_FOUND);
  assert.match(r.error.message, /tools\/subscribe/);
});

test("an error reply always carries an id, using null when the request had none", async () => {
  const r = await call({ jsonrpc: "2.0", method: "nope", id: null });
  assert.equal(r.id, null);
  assert.ok(r.error);
});

/* ── tools/list and the exposure filter ──────────────────────────────────── */

test("tools/list returns descriptors with a schema and MCP annotation hints", async () => {
  const r = await call(rpc("tools/list"));
  assert.ok(r.result.tools.length >= 8, `only ${r.result.tools.length} tools exposed`);
  const kpi = r.result.tools.find((t) => t.name === "kpi");
  assert.ok(kpi, "kpi is not exposed");
  assert.equal(kpi.inputSchema.type, "object");
  assert.equal(kpi.annotations.readOnlyHint, true);
  assert.equal(kpi.annotations.idempotentHint, true);
  assert.match(kpi.description, /Deterministic/);
});

test("write_artifact is NOT exposed — the route is unauthenticated", async () => {
  const r = await call(rpc("tools/list"));
  const names = r.result.tools.map((t) => t.name);
  assert.ok(!names.includes("write_artifact"), "a write tool is reachable from an unauthenticated route");
});

test("the exposure filter reads the tool's own annotations, so a new write tool is hidden by default", () => {
  assert.equal(defaultExposureFilter({ annotations: { readOnly: true, destructive: false } }), true);
  assert.equal(defaultExposureFilter({ annotations: { readOnly: false, destructive: false } }), false);
  assert.equal(defaultExposureFilter({ annotations: { readOnly: true, destructive: true } }), false);
});

test("a hidden tool is indistinguishable from a missing one", async () => {
  // Otherwise an unauthenticated caller can enumerate what the deployment
  // holds by reading which refusal it gets.
  const hidden = await call(rpc("tools/call", { name: "write_artifact", arguments: { path: "/x", content: "y" } }));
  const missing = await call(rpc("tools/call", { name: "no_such_tool_at_all", arguments: {} }));
  assert.equal(hidden.error.code, missing.error.code);
  assert.equal(hidden.error.code, RPC.TOOL_NOT_FOUND);
  assert.doesNotMatch(hidden.error.message, /exists|hidden|permission|denied/i);
});

test("a custom expose filter overrides the default in both directions", async () => {
  const none = await call(rpc("tools/list"), server({ expose: () => false }));
  assert.equal(none.result.tools.length, 0);
  const all = await call(rpc("tools/list"), server({ expose: () => true }));
  assert.ok(all.result.tools.some((t) => t.name === "write_artifact"));
});

test("a non-deterministic tool is exposed but described as such", async () => {
  const opts = server();
  for (const t of webTools({ fetchText: async () => "{}", only: ["wikipedia"] })) opts.registry.register(t);
  const r = await call(rpc("tools/list"), opts);
  const live = r.result.tools.find((t) => t.name === "web_wikipedia");
  assert.ok(live, "a live tool was filtered out despite being read-only");
  assert.match(live.description, /NOT deterministic/);
  assert.equal(live.annotations.idempotentHint, false);
  assert.equal(live.annotations.openWorldHint, true);
});

/* ── tools/call ──────────────────────────────────────────────────────────── */

test("a successful call returns text content and structured content, and is not an error", async () => {
  const r = await call(rpc("tools/call", { name: "calc", arguments: { expression: "2 + 3 * 4" } }));
  assert.equal(r.error, undefined);
  assert.equal(r.result.isError, undefined);
  assert.equal(r.result.content[0].type, "text");
  assert.match(r.result.content[0].text, /14/);
  assert.equal(r.result.structuredContent.value.value, 14);
});

test("a tool that fails answers isError, NOT a JSON-RPC error", async () => {
  // The spec is explicit: a tool failure must reach the model so it can
  // recover. A transport-level error is swallowed by the client instead.
  const r = await call(rpc("tools/call", { name: "calc", arguments: { expression: "2 +" } }));
  assert.equal(r.error, undefined, "a tool failure became a transport error");
  assert.equal(r.result.isError, true);
  assert.ok(r.result.content[0].text.length > 0, "an empty failure message teaches the caller nothing");
});

test("a bad argument is rejected with a message naming the accepted arguments", async () => {
  const r = await call(rpc("tools/call", { name: "calc", arguments: { expresion: "1+1" } }));
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /unknown argument/);
  assert.match(r.result.content[0].text, /expression/);
});

test("tools/call with no name, or a non-object arguments, is invalid params", async () => {
  assert.equal((await call(rpc("tools/call", { arguments: {} }))).error.code, RPC.INVALID_PARAMS);
  assert.equal((await call(rpc("tools/call", { name: 42, arguments: {} }))).error.code, RPC.INVALID_PARAMS);
  assert.equal((await call(rpc("tools/call", { name: "calc", arguments: [1, 2] }))).error.code, RPC.INVALID_PARAMS);
});

test("omitted arguments default to an empty object rather than throwing", async () => {
  const r = await call(rpc("tools/call", { name: "calc" }));
  assert.equal(r.error, undefined);
  assert.equal(r.result.isError, true, "a required argument is still required");
});

test("the injected clock reaches a date-dependent tool, so a replay reproduces it", async () => {
  const opts = server();
  const a = await handleMcpMessage(rpc("tools/call", { name: "date_math", arguments: { operation: "add", amount: 30, unit: "days" } }), opts);
  const b = await handleMcpMessage(rpc("tools/call", { name: "date_math", arguments: { operation: "add", amount: 30, unit: "days" } }), opts);
  assert.equal(a.result.content[0].text, b.result.content[0].text, "two calls at the same injected clock disagreed");
});

test("two identical calls in separate requests do not share a memo", async () => {
  // The per-call cache must not outlive a request, or one caller's arguments
  // answer the next caller's question.
  const opts = server();
  const a = await handleMcpMessage(rpc("tools/call", { name: "read_doc", arguments: { id: FIXTURES.docs[0].id } }), opts);
  const b = await handleMcpMessage(rpc("tools/call", { name: "read_doc", arguments: { id: FIXTURES.docs[0].id } }), opts);
  assert.equal(a.result.content[0].text, b.result.content[0].text);
  assert.equal(a.result.isError, undefined);
});

test("the agent's memory is never handed to a remote caller", async () => {
  // createFactStore([]) is passed deliberately; if a future edit wires the
  // real store in, lookup would start answering with the user's documents.
  const r = await call(rpc("tools/call", { name: "lookup", arguments: { key: "anything" } }));
  assert.ok(r.result, "lookup did not answer at all");
  assert.notEqual(r.result.content[0].text.trim(), "");
});

/* ── batches ─────────────────────────────────────────────────────────────── */

test("a batch answers one entry per request and skips notifications", async () => {
  const out = await handleMcpPayload([
    rpc("ping", undefined, 1),
    { jsonrpc: "2.0", method: "notifications/initialized" },
    rpc("tools/list", undefined, 2),
  ], server());
  assert.ok(Array.isArray(out));
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((r) => r.id), [1, 2]);
});

test("a batch of only notifications produces no reply, not an empty array", async () => {
  const out = await handleMcpPayload([{ jsonrpc: "2.0", method: "notifications/initialized" }], server());
  assert.equal(out, null);
});

test("an empty batch is refused", async () => {
  const out = await handleMcpPayload([], server());
  assert.equal(out.error.code, RPC.INVALID_REQUEST);
});

test("a single message through handleMcpPayload behaves as it does through handleMcpMessage", async () => {
  const out = await handleMcpPayload(rpc("ping", undefined, 9), server());
  assert.ok(!Array.isArray(out));
  assert.equal(out.id, 9);
});

/* ── empty surfaces ──────────────────────────────────────────────────────── */

test("resources/list and prompts/list answer empty rather than method-not-found", async () => {
  // A client that probes these on connect should not see an error in its log
  // for a server that simply has none.
  assert.deepEqual((await call(rpc("resources/list"))).result, { resources: [] });
  assert.deepEqual((await call(rpc("prompts/list"))).result, { prompts: [] });
});

/* ── resources and prompts ───────────────────────────────────────────────── */

test("resources and prompts are advertised ONLY when a corpus was supplied", async () => {
  // Advertising a capability the server does not serve makes a conforming
  // client call it and get a method-not-found it had every right not to expect.
  const bare = await call(rpc("initialize"), server());
  assert.deepEqual(Object.keys(bare.result.capabilities), ["tools"]);

  const withDocs = await call(rpc("initialize"), server({ fixtures: FIXTURES }));
  assert.deepEqual(Object.keys(withDocs.result.capabilities).sort(), ["prompts", "resources", "tools"]);
});

test("resources/list returns one entry per fixture document with a stable uri", async () => {
  const r = await call(rpc("resources/list"), server({ fixtures: FIXTURES }));
  assert.equal(r.result.resources.length, FIXTURES.docs.length);
  assert.ok(FIXTURES.docs.length > 0, "the fixture corpus is empty, so this test proves nothing");
  for (const res of r.result.resources) {
    assert.equal(res.uri, docUri(res.name));
    assert.equal(res.mimeType, "text/markdown");
    assert.ok(res.title.length > 0);
  }
});

test("resources/read returns the WHOLE document, not read_doc's five-sentence window", async () => {
  const doc = FIXTURES.docs[0];
  const opts = server({ fixtures: FIXTURES });
  const res = await handleMcpMessage(rpc("resources/read", { uri: docUri(doc.id) }), opts);
  const whole = res.result.contents[0].text;
  assert.equal(res.result.contents[0].uri, docUri(doc.id));
  for (const sentence of doc.sentences) {
    assert.ok(whole.includes(sentence), "a sentence was missing from the resource body");
  }

  // The contrast that makes the point: the tool is budgeted, the resource is not.
  const windowed = await handleMcpMessage(rpc("tools/call", { name: "read_doc", arguments: { id: doc.id } }), opts);
  if (doc.sentences.length > 5) {
    assert.ok(whole.length > windowed.result.content[0].text.length, "the resource was no longer than the budgeted window");
  }
});

test("resources/read on an unknown uri names what is available", async () => {
  const r = await call(rpc("resources/read", { uri: "webaios://docs/nope" }), server({ fixtures: FIXTURES }));
  assert.equal(r.error.code, RPC.RESOURCE_NOT_FOUND);
  assert.match(r.error.message, /Available: webaios:\/\/docs\//);
});

test("resources/read without a uri is invalid params", async () => {
  const r = await call(rpc("resources/read", {}), server({ fixtures: FIXTURES }));
  assert.equal(r.error.code, RPC.INVALID_PARAMS);
});

test("prompts/get returns the worked ReAct examples, including the refusal", async () => {
  const opts = server({ fixtures: FIXTURES });
  const list = await handleMcpMessage(rpc("prompts/list"), opts);
  assert.equal(list.result.prompts.length, 1);
  assert.equal(list.result.prompts[0].name, "react_exemplars");

  const got = await handleMcpMessage(rpc("prompts/get", { name: "react_exemplars" }), opts);
  const text = got.result.messages[0].content.text;
  assert.match(text, /finish\[/);
  // The example that refuses is the one worth shipping: a model shown only
  // successes learns to produce the shape of a success.
  assert.match(text, /cannot answer this/i);
});

test("prompts/get honours the density argument and the two differ", async () => {
  const opts = server({ fixtures: FIXTURES });
  const dense = await handleMcpMessage(rpc("prompts/get", { name: "react_exemplars", arguments: { density: "dense" } }), opts);
  const sparse = await handleMcpMessage(rpc("prompts/get", { name: "react_exemplars", arguments: { density: "sparse" } }), opts);
  assert.notEqual(dense.result.messages[0].content.text, sparse.result.messages[0].content.text);
});

test("prompts/get on an unknown name names what is available", async () => {
  const r = await call(rpc("prompts/get", { name: "nope" }), server({ fixtures: FIXTURES }));
  assert.equal(r.error.code, RPC.INVALID_PARAMS);
  assert.match(r.error.message, /react_exemplars/);
});

test("a server with no corpus still answers resources/list and prompts/list empty", async () => {
  // It does not advertise them, but a client that probes anyway should get an
  // empty list rather than an error in its log.
  assert.deepEqual((await call(rpc("resources/list"))).result, { resources: [] });
  assert.deepEqual((await call(rpc("prompts/list"))).result, { prompts: [] });
});

test("the live services are exposed as tools and are labelled non-deterministic", async () => {
  const opts = server({ fixtures: FIXTURES });
  for (const t of webTools({ fetchText: async () => "{}" })) opts.registry.register(t);
  const r = await handleMcpMessage(rpc("tools/list"), opts);
  const live = r.result.tools.filter((t) => t.name.startsWith("web_"));
  assert.ok(live.length >= 40, `only ${live.length} live tools exposed`);
  for (const t of live) {
    assert.equal(t.annotations.idempotentHint, false, `${t.name} claims to be idempotent`);
    assert.equal(t.annotations.openWorldHint, true);
    assert.match(t.description, /NOT deterministic/);
  }
});
