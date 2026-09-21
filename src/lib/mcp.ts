"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

/* ────────────────────────────────────────────────────────────────────────────
   A Model Context Protocol client.

   This is how AI Studio reaches a running Godot, Unity or Unreal editor — and
   anything else with an MCP server. The protocol is JSON-RPC 2.0 over
   Streamable HTTP: initialize, then tools/list, then tools/call.

   Two things shape the implementation:

   - Where the request leaves from. An editor MCP server runs on your own
     localhost, which a serverless function cannot reach, so those calls go
     straight from the browser — exactly like Ollama. A public MCP server can
     go either way, and routing it through /api/mcp sidesteps CORS, which most
     public servers do not set for a browser origin.
   - What comes back. A Streamable HTTP server may answer one POST with plain
     JSON or with an SSE stream, and both are legal for the same request.
     Handling only one is the most common way a hand-written MCP client works
     against one server and fails against the next.
   ──────────────────────────────────────────────────────────────────────────── */

import {
  LATEST_PROTOCOL, negotiate, buildRequest, listTtl, isFresh, listCacheKey,
  type ListCacheEntry, type ProtocolVersion,
} from "./mcp-wire";

/** What we advertise. The version actually spoken is whatever the server
 *  answers `initialize` with — see negotiate() in mcp-wire.ts. */
export const MCP_PROTOCOL = LATEST_PROTOCOL;

const CLIENT = { name: "Web-AIOS", version: "2.0.0" } as const;

/** tools/list results, which the 2026 revision makes cacheable. Keyed by
 *  server AND negotiated version, because the same server can answer
 *  differently under a different revision. */
const listCache = new Map<string, ListCacheEntry<McpTool[]>>();

export const clearListCache = (): void => listCache.clear();

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
}

export interface McpServer {
  id: string;
  name: string;
  url: string;
  /** Sent as `Authorization: Bearer …`. Stays in this browser. */
  token?: string;
  /** Force the request through the server relay. Off for localhost, which the
   *  relay physically cannot reach. */
  viaRelay?: boolean;
  enabled: boolean;
}

export interface McpConnection {
  serverId: string;
  /** The revision actually negotiated with this server. */
  protocol?: ProtocolVersion;
  sessionId?: string;
  serverName?: string;
  tools: McpTool[];
  error?: string;
  connectedAt: number;
}

/* ── Wire ─────────────────────────────────────────────────────────────────── */

interface RpcResult { result?: unknown; error?: { code: number; message: string } }

const isLocal = (url: string) => {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]" || h.endsWith(".local");
  } catch { return false; }
};

/** One JSON-RPC round trip. Returns the result or throws with the server's message. */
async function rpc(
  server: McpServer,
  method: string,
  params: Record<string, unknown> | undefined,
  sessionId: string | undefined,
  signal?: AbortSignal,
  protocol: ProtocolVersion = MCP_PROTOCOL,
): Promise<{ result: unknown; sessionId?: string; cacheControl?: string | null; etag?: string | null }> {
  const { headers, body } = buildRequest(method, params, {
    protocol, client: CLIENT, sessionId, token: server.token,
    id: Math.floor(Math.random() * 1e9),
  });

  // A localhost server is unreachable from a serverless function, so those
  // always leave from the browser regardless of the relay preference.
  const relay = server.viaRelay && !isLocal(server.url);
  const res = relay
    ? await fetch("/api/mcp", {
        method: "POST", signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: server.url, headers, body }),
      })
    : await fetch(server.url, { method: "POST", headers, body, signal });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 300)}` : ""}`);
  }

  const nextSession = res.headers.get("mcp-session-id") ?? sessionId;
  const cacheControl = res.headers.get("cache-control");
  const etag = res.headers.get("etag");
  const ctype = res.headers.get("content-type") ?? "";
  const raw = await res.text();

  let payload: RpcResult | null = null;
  if (ctype.includes("text/event-stream")) {
    // Take the last data: frame that parses as a JSON-RPC response — a server
    // may interleave progress notifications before the actual result.
    for (const frame of raw.split(/\n\n/)) {
      const line = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      try {
        const evt = JSON.parse(line.slice(5).trim()) as RpcResult & { id?: unknown };
        if ("result" in evt || "error" in evt) payload = evt;
      } catch { /* progress frames are not always JSON */ }
    }
  } else if (raw.trim()) {
    payload = JSON.parse(raw) as RpcResult;
  }

  if (!payload) {
    // 202 with an empty body is the legal answer to a notification.
    if (method.startsWith("notifications/")) return { result: null, sessionId: nextSession ?? undefined };
    throw new Error("The server returned no JSON-RPC response.");
  }
  if (payload.error) throw new Error(`${payload.error.message} (code ${payload.error.code})`);
  return { result: payload.result, sessionId: nextSession ?? undefined, cacheControl, etag };
}

/** Handshake, then list what the server can do. */
export async function connect(server: McpServer, signal?: AbortSignal): Promise<McpConnection> {
  const init = await rpc(
    server,
    "initialize",
    {
      protocolVersion: MCP_PROTOCOL,
      capabilities: {},
      clientInfo: { name: "Web-AIOS", version: "2.0.0" },
    },
    undefined,
    signal,
  );
  const sessionId = init.sessionId;
  const res = init.result as { serverInfo?: { name?: string }; protocolVersion?: string };
  // Speak whatever the server answered with, not what we asked for. Most
  // servers are still on 2025-06-18, and a client that only speaks the newest
  // revision is a client that talks to nothing.
  const protocol = negotiate(res?.protocolVersion);

  // Required by the spec before any other request. A server that has not seen
  // it may legitimately refuse tools/list.
  await rpc(server, "notifications/initialized", undefined, sessionId, signal, protocol).catch(() => undefined);

  // tools/list is cacheable from 2026-07-28. The key carries the negotiated
  // version because the same server can answer differently under each.
  const key = listCacheKey(server.id, "tools/list", protocol);
  const cached = listCache.get(key);
  let tools: McpTool[];
  if (isFresh(cached, Date.now())) {
    tools = cached!.value;
  } else {
    const listed = await rpc(server, "tools/list", {}, sessionId, signal, protocol);
    tools = ((listed.result as { tools?: McpTool[] })?.tools ?? []).filter((t) => typeof t?.name === "string");
    const maxAgeMs = listTtl(listed.cacheControl);
    if (maxAgeMs > 0) {
      listCache.set(key, { value: tools, etag: listed.etag ?? undefined, storedAt: Date.now(), maxAgeMs });
    }
  }

  return { serverId: server.id, protocol, sessionId, serverName: res?.serverInfo?.name, tools, connectedAt: Date.now() };
}

export interface ToolOutcome {
  ok: boolean;
  /** Flattened text of the content blocks, which is what a model can read. */
  text: string;
  raw: unknown;
}

export async function callTool(
  server: McpServer,
  sessionId: string | undefined,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  protocol: ProtocolVersion = MCP_PROTOCOL,
): Promise<ToolOutcome> {
  try {
    const out = await rpc(server, "tools/call", { name, arguments: args }, sessionId, signal, protocol);
    const r = out.result as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    const text = (r?.content ?? [])
      .map((c) => (c.type === "text" ? c.text ?? "" : `[${c.type}]`))
      .join("\n")
      .trim();
    return { ok: !r?.isError, text: text || "(no output)", raw: out.result };
  } catch (e) {
    return { ok: false, text: e instanceof Error ? e.message : "Tool call failed.", raw: null };
  }
}

/** A compact description of the available tools for a model's system prompt. */
export function toolCatalogue(tools: McpTool[]): string {
  return tools
    .map((t) => {
      const props = t.inputSchema?.properties ?? {};
      const req = new Set(t.inputSchema?.required ?? []);
      const args = Object.entries(props)
        .map(([k, v]) => {
          const d = v as { type?: string; description?: string };
          return `    ${k}${req.has(k) ? "" : "?"}: ${d.type ?? "any"}${d.description ? ` — ${d.description}` : ""}`;
        })
        .join("\n");
      return `- ${t.name}${t.description ? `: ${t.description}` : ""}${args ? `\n${args}` : ""}`;
    })
    .join("\n");
}

/* ── Stored servers ───────────────────────────────────────────────────────── */

const SUGGESTED: McpServer[] = [
  { id: "godot", name: "Godot", url: "http://localhost:8080/mcp", enabled: false },
  { id: "unity", name: "Unity", url: "http://localhost:8090/mcp", enabled: false },
  { id: "unreal", name: "Unreal", url: "http://localhost:8099/mcp", enabled: false },
  { id: "blender", name: "Blender", url: "http://localhost:8765/mcp", enabled: false },
];

interface McpState {
  servers: McpServer[];
  add: (s: Omit<McpServer, "id">) => string;
  update: (id: string, patch: Partial<McpServer>) => void;
  remove: (id: string) => void;
  /** Never persisted: a session id is only valid while the server is up. */
  connections: Record<string, McpConnection>;
  setConnection: (id: string, c: McpConnection | null) => void;
}

export const useMcp = create<McpState>()(
  persist(
    (set) => ({
      servers: SUGGESTED,
      connections: {},
      add: (s) => {
        const id = `mcp_${Math.random().toString(36).slice(2, 9)}`;
        set((st) => ({ servers: [...st.servers, { ...s, id }] }));
        return id;
      },
      update: (id, patch) => set((st) => ({ servers: st.servers.map((x) => (x.id === id ? { ...x, ...patch } : x)) })),
      remove: (id) =>
        set((st) => {
          const conns = { ...st.connections };
          delete conns[id];
          return { servers: st.servers.filter((x) => x.id !== id), connections: conns };
        }),
      setConnection: (id, c) =>
        set((st) => {
          const conns = { ...st.connections };
          if (c) conns[id] = c; else delete conns[id];
          return { connections: conns };
        }),
    }),
    {
      name: "webaios.mcp.v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ servers: s.servers }) as unknown as McpState,
    },
  ),
);
