/* ────────────────────────────────────────────────────────────────────────────
   MCP on the wire — version negotiation, request shape, and list caching.

   The 2026-07-28 revision changed three things that matter to a client:

   1. The protocol core is STATELESS. Session tracking is gone; the protocol
      version, client identity and capabilities travel in a `_meta` member on
      every request instead of being established once and remembered.
   2. Routing moved to HEADERS. `Mcp-Method` and `Mcp-Name` carry the method
      and tool name so a gateway can route and authorize without parsing the
      JSON body.
   3. List results are CACHEABLE, so `tools/list` no longer has to be refetched
      on every connect.

   Most servers in the wild still speak 2025-06-18, and a client that only
   speaks the new spec is a client that talks to nothing. So everything here is
   a function of the NEGOTIATED version: ask for the newest, accept what the
   server answers with, and shape every subsequent request to match. The old
   session header keeps being echoed when a server issued one, because a server
   that still tracks sessions is entitled to have its session respected.

   PURE. No fetch, no clock, no storage — the caller supplies `now` and does
   the I/O.
   ──────────────────────────────────────────────────────────────────────────── */

/** Newest first. The first entry is what we advertise. */
export const SUPPORTED_PROTOCOLS = ["2026-07-28", "2025-06-18", "2025-03-26"] as const;
export type ProtocolVersion = (typeof SUPPORTED_PROTOCOLS)[number];

export const LATEST_PROTOCOL: ProtocolVersion = SUPPORTED_PROTOCOLS[0];

/** The revision that introduced the stateless core, header routing and
 *  cacheable lists. Compared as a date string, which sorts correctly. */
export const STATELESS_FROM = "2026-07-28";

export const isStateless = (v: string): boolean => v >= STATELESS_FROM;

/**
 * What version to actually speak.
 *
 * A server answering `initialize` states the version it chose. If we know it,
 * use it. If we do not, fall back to the newest version we support that is not
 * newer than the server's answer — a server on a revision we have never heard
 * of is far more likely to tolerate an older client than a newer one.
 */
export function negotiate(serverAnswer: string | undefined): ProtocolVersion {
  if (!serverAnswer) return "2025-06-18";
  const known = SUPPORTED_PROTOCOLS.find((v) => v === serverAnswer);
  if (known) return known;
  const older = SUPPORTED_PROTOCOLS.find((v) => v <= serverAnswer);
  return older ?? SUPPORTED_PROTOCOLS[SUPPORTED_PROTOCOLS.length - 1];
}

/* ── requests ────────────────────────────────────────────────────────────── */

export interface ClientIdentity {
  name: string;
  version: string;
}

export interface RequestContext {
  protocol: ProtocolVersion;
  client: ClientIdentity;
  /** Only present when a server issued one. Echoed regardless of version. */
  sessionId?: string;
  token?: string;
  /** JSON-RPC id. A parameter so a request is reproducible in a test. */
  id: number;
  /** What this client supports, declared per request on stateless servers.
   *  Empty means "nothing optional": a server must not rely on anything else. */
  capabilities?: Record<string, unknown>;
}

export interface WireRequest {
  headers: Record<string, string>;
  body: string;
}

/** The tool name for `tools/call`, for the `Mcp-Name` routing header. */
const nameOf = (method: string, params: Record<string, unknown> | undefined): string | undefined => {
  if (!params) return undefined;
  if (method === "tools/call" || method === "prompts/get" || method === "resources/read") {
    const n = params.name ?? params.uri;
    return typeof n === "string" ? n : undefined;
  }
  return undefined;
};

/**
 * Build one JSON-RPC request.
 *
 * On a stateless server the `_meta` member carries what used to live in the
 * session, so every request is independently routable and a gateway can drop a
 * connection without losing the client's identity.
 */
export function buildRequest(
  method: string,
  params: Record<string, unknown> | undefined,
  ctx: RequestContext,
): WireRequest {
  const stateless = isStateless(ctx.protocol);

  const meta = stateless
    ? {
        // Key names are the spec's, verbatim (2026-07-28 basic/index, "Per-request
        // protocol fields"). protocolVersion and clientCapabilities are REQUIRED:
        // a request missing either is malformed and a server MUST answer -32602 /
        // HTTP 400. An earlier version sent "protocol-version" and "client", which
        // no key in the spec matches, so a strict server refused every call.
        _meta: {
          "io.modelcontextprotocol/protocolVersion": ctx.protocol,
          "io.modelcontextprotocol/clientInfo": { name: ctx.client.name, version: ctx.client.version },
          "io.modelcontextprotocol/clientCapabilities": ctx.capabilities ?? {},
        },
      }
    : {};

  // _meta belongs INSIDE params: a request with no params still needs one to
  // carry it, which is why this is not a top-level spread.
  const withMeta = stateless ? { ...(params ?? {}), ...meta } : params;

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: ctx.id,
    method,
    ...(withMeta ? { params: withMeta } : {}),
  });

  const headers: Record<string, string> = {
    "content-type": "application/json",
    // Both, because the server picks which one it answers with.
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": ctx.protocol,
  };
  if (stateless) {
    headers["mcp-method"] = method;
    const n = nameOf(method, params);
    if (n) headers["mcp-name"] = n;
  }
  // Echoed whenever the server gave us one, on any version: a server that
  // still tracks sessions is entitled to have its session respected.
  if (ctx.sessionId) headers["mcp-session-id"] = ctx.sessionId;
  if (ctx.token) headers.authorization = `Bearer ${ctx.token}`;

  return { headers, body };
}

/* ── cacheable list results ──────────────────────────────────────────────── */

export interface ListCacheEntry<T> {
  value: T;
  /** From the response's ETag, when the server sent one. */
  etag?: string;
  storedAt: number;
  /** Seconds the server said it stays fresh. */
  maxAgeMs: number;
}

/** What a server is assumed to mean when it says nothing about freshness.
 *  Short, because a tool list changing under a client is confusing and the
 *  request is cheap. */
export const DEFAULT_LIST_TTL_MS = 5 * 60_000;

/** Cache-Control's max-age in ms, or the default. Only `max-age` is honoured:
 *  `no-store` and `no-cache` both mean "do not serve this from cache". */
export function listTtl(cacheControl: string | null | undefined): number {
  if (!cacheControl) return DEFAULT_LIST_TTL_MS;
  const cc = cacheControl.toLowerCase();
  if (cc.includes("no-store") || cc.includes("no-cache")) return 0;
  const m = /max-age\s*=\s*(\d+)/.exec(cc);
  if (!m) return DEFAULT_LIST_TTL_MS;
  return Math.max(0, Math.min(24 * 3600, Number(m[1]))) * 1000;
}

export const isFresh = <T,>(e: ListCacheEntry<T> | undefined, now: number): boolean =>
  !!e && e.maxAgeMs > 0 && now - e.storedAt < e.maxAgeMs;

/** A cache key must include the negotiated version: the same server can return
 *  a different tool list under a different revision, and serving one for the
 *  other is a silent, extremely confusing bug. */
export const listCacheKey = (serverId: string, method: string, protocol: string): string =>
  `${serverId}|${method}|${protocol}`;

/** Revalidation headers for a cached entry. Returns {} when there is nothing
 *  to revalidate against, so the caller does a plain request. */
export function revalidateHeaders<T>(e: ListCacheEntry<T> | undefined): Record<string, string> {
  return e?.etag ? { "if-none-match": e.etag } : {};
}
