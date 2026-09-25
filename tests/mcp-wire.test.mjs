/* MCP wire format across protocol revisions.
 *
 * The thing that must not break: a client that speaks 2026-07-28 still has to
 * talk to the many servers that speak 2025-06-18. Almost every test here pins
 * one version's behaviour against the other's.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  SUPPORTED_PROTOCOLS, LATEST_PROTOCOL, isStateless, negotiate, buildRequest,
  listTtl, isFresh, listCacheKey, revalidateHeaders, DEFAULT_LIST_TTL_MS,
} from "../.test-build/mcp-wire.js";

const client = { name: "web-aios", version: "1.0.0" };
const ctx = (over = {}) => ({ protocol: LATEST_PROTOCOL, client, id: 1, ...over });
const parse = (r) => JSON.parse(r.body);

/* ── negotiation ─────────────────────────────────────────────────────────── */

test("we advertise the newest revision we know", () => {
  assert.equal(LATEST_PROTOCOL, "2026-07-28");
  assert.equal(SUPPORTED_PROTOCOLS[0], LATEST_PROTOCOL);
});

test("a version we know is taken at its word", () => {
  for (const v of SUPPORTED_PROTOCOLS) assert.equal(negotiate(v), v);
});

test("a server that says nothing is assumed to be pre-stateless", () => {
  // Silence means an older server; assuming the newest would send _meta to
  // something that has never heard of it.
  assert.equal(negotiate(undefined), "2025-06-18");
  assert.equal(isStateless(negotiate(undefined)), false);
});

test("a FUTURE revision falls back to the newest one we support", () => {
  // A server ahead of us is likelier to tolerate an older client than a newer
  // one, so we step down rather than guess at a spec we have not read.
  assert.equal(negotiate("2027-01-01"), "2026-07-28");
});

test("an unknown OLD revision falls back to something older still", () => {
  assert.equal(negotiate("2025-04-01"), "2025-03-26");
});

test("isStateless is a date comparison, not an equality check", () => {
  assert.equal(isStateless("2026-07-28"), true);
  assert.equal(isStateless("2027-03-01"), true, "later revisions are still stateless");
  assert.equal(isStateless("2025-06-18"), false);
});

/* ── the stateless core ──────────────────────────────────────────────────── */

test("2026 carries protocol version, client identity and capabilities in _meta, under the spec's key names", () => {
  const r = buildRequest("tools/call", { name: "search", arguments: { q: "x" } }, ctx());
  const meta = parse(r).params._meta;
  // The spec's names, verbatim. This test previously pinned "protocol-version"
  // and "client", which encoded the bug instead of catching it.
  assert.equal(meta["io.modelcontextprotocol/protocolVersion"], "2026-07-28");
  assert.deepEqual(meta["io.modelcontextprotocol/clientInfo"], { name: "web-aios", version: "1.0.0" });
  assert.ok("io.modelcontextprotocol/clientCapabilities" in meta, "clientCapabilities is REQUIRED on every request");
  assert.equal(meta["io.modelcontextprotocol/protocol-version"], undefined);
});

test("_meta rides INSIDE params, and params is created when there were none", () => {
  const r = buildRequest("tools/list", undefined, ctx());
  const body = parse(r);
  assert.ok(body.params, "a request with no params still needs one to carry _meta");
  assert.ok(body.params._meta);
});

test("the older revision sends no _meta at all", () => {
  const r = buildRequest("tools/call", { name: "search" }, ctx({ protocol: "2025-06-18" }));
  const body = parse(r);
  assert.equal(body.params._meta, undefined);
  assert.deepEqual(body.params, { name: "search" }, "params pass through untouched");
});

test("a request with no params stays param-less on the older revision", () => {
  assert.equal(parse(buildRequest("tools/list", undefined, ctx({ protocol: "2025-06-18" }))).params, undefined);
});

test("the JSON-RPC envelope is well formed on both revisions", () => {
  for (const protocol of ["2026-07-28", "2025-06-18"]) {
    const body = parse(buildRequest("tools/list", {}, ctx({ protocol, id: 42 })));
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.id, 42);
    assert.equal(body.method, "tools/list");
  }
});

/* ── header routing ──────────────────────────────────────────────────────── */

test("2026 puts the method and the tool name in headers so a gateway can route", () => {
  const r = buildRequest("tools/call", { name: "search", arguments: {} }, ctx());
  assert.equal(r.headers["mcp-method"], "tools/call");
  assert.equal(r.headers["mcp-name"], "search");
});

test("resources/read routes on its uri", () => {
  const r = buildRequest("resources/read", { uri: "file:///a" }, ctx());
  assert.equal(r.headers["mcp-name"], "file:///a");
});

test("a method with no name sends no name header, rather than an empty one", () => {
  const r = buildRequest("tools/list", {}, ctx());
  assert.equal(r.headers["mcp-method"], "tools/list");
  assert.ok(!("mcp-name" in r.headers));
});

test("the older revision sends no routing headers", () => {
  const r = buildRequest("tools/call", { name: "search" }, ctx({ protocol: "2025-06-18" }));
  assert.ok(!("mcp-method" in r.headers));
  assert.ok(!("mcp-name" in r.headers));
});

/* ── things that must hold on every revision ─────────────────────────────── */

test("the protocol version header is always sent, and matches what we negotiated", () => {
  for (const protocol of SUPPORTED_PROTOCOLS) {
    assert.equal(buildRequest("ping", undefined, ctx({ protocol })).headers["mcp-protocol-version"], protocol);
  }
});

test("a session the server issued is echoed even on the stateless revision", () => {
  // Sessions are gone from the protocol, not from servers. One that issued a
  // session id is entitled to have it respected.
  for (const protocol of ["2026-07-28", "2025-06-18"]) {
    const r = buildRequest("ping", undefined, ctx({ protocol, sessionId: "abc" }));
    assert.equal(r.headers["mcp-session-id"], "abc");
  }
});

test("no session means no session header", () => {
  assert.ok(!("mcp-session-id" in buildRequest("ping", undefined, ctx()).headers));
});

test("a token becomes a bearer header; no token means no authorization", () => {
  assert.equal(buildRequest("ping", undefined, ctx({ token: "t0k" })).headers.authorization, "Bearer t0k");
  assert.ok(!("authorization" in buildRequest("ping", undefined, ctx()).headers));
});

test("both response encodings are accepted, because the server chooses", () => {
  const a = buildRequest("ping", undefined, ctx()).headers.accept;
  assert.match(a, /application\/json/);
  assert.match(a, /text\/event-stream/);
});

/* ── cacheable list results ──────────────────────────────────────────────── */

test("max-age is honoured and clamped to a day", () => {
  assert.equal(listTtl("max-age=60"), 60_000);
  assert.equal(listTtl("public, max-age=120"), 120_000);
  assert.equal(listTtl("max-age=999999"), 24 * 3600 * 1000);
});

test("no-store and no-cache mean do not serve from cache", () => {
  assert.equal(listTtl("no-store"), 0);
  assert.equal(listTtl("no-cache, max-age=60"), 0);
  assert.equal(isFresh({ value: 1, storedAt: 0, maxAgeMs: 0 }, 1), false);
});

test("a missing or unparseable header falls back to the default", () => {
  assert.equal(listTtl(null), DEFAULT_LIST_TTL_MS);
  assert.equal(listTtl(undefined), DEFAULT_LIST_TTL_MS);
  assert.equal(listTtl("public"), DEFAULT_LIST_TTL_MS);
});

test("freshness is a function of the supplied clock, never Date.now", () => {
  const e = { value: ["a"], storedAt: 1000, maxAgeMs: 5000 };
  assert.equal(isFresh(e, 1000), true);
  assert.equal(isFresh(e, 5999), true);
  assert.equal(isFresh(e, 6000), false, "exactly at the boundary is stale");
  assert.equal(isFresh(undefined, 0), false);
});

test("the cache key includes the protocol, because the tool list can differ by it", () => {
  const a = listCacheKey("s1", "tools/list", "2026-07-28");
  const b = listCacheKey("s1", "tools/list", "2025-06-18");
  assert.notEqual(a, b);
  assert.equal(a, listCacheKey("s1", "tools/list", "2026-07-28"), "and is stable");
});

test("an entry with an etag revalidates; one without does a plain request", () => {
  assert.deepEqual(revalidateHeaders({ value: 1, etag: 'W/"x"', storedAt: 0, maxAgeMs: 1 }), { "if-none-match": 'W/"x"' });
  assert.deepEqual(revalidateHeaders({ value: 1, storedAt: 0, maxAgeMs: 1 }), {});
  assert.deepEqual(revalidateHeaders(undefined), {});
});
