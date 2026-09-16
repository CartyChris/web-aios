import type { ToolDef, ToolRegistry, ToolResult } from "./types";
import { runTool, validateArgs } from "./tools";
import { createFactStore } from "./context";

/* ────────────────────────────────────────────────────────────────────────────
   The other direction: this OS as an MCP server.

   Everything else here is an MCP *client* — the OS reaching a Godot or Unity
   editor. This is the inverse, and it exists because of a property the tools
   already have rather than a new idea: every deterministic tool in the harness
   is pure, takes its clock as an argument and reaches nothing. A tool like
   that is portable by construction, and keeping it locked inside one browser
   tab wastes it. Point Claude Desktop, an IDE or another agent at the route
   that wraps this module and they compute the same numbers, from the same
   fixtures, with the same formulas.

   Why it matters more than "another integration": the reason to have
   deterministic tools at all is that two parties can check each other. Two
   agents that each estimate ARR will disagree and neither can say who is
   wrong. Two agents that both call `kpi` get the same figure and the same
   audit trail, and a disagreement is then about the question rather than the
   arithmetic.

   PURE, like everything beside it. JSON in, JSON out, clock injected. The
   route is thirty lines of plumbing on top.
   ──────────────────────────────────────────────────────────────────────────── */

export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** JSON-RPC 2.0 error codes. The last two are ours, in the -32000 block the
 *  spec reserves for the implementation. */
export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  TOOL_NOT_FOUND: -32001,
  TOOL_REFUSED: -32002,
} as const;

export interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpServerOptions {
  registry: ToolRegistry;
  serverName: string;
  serverVersion: string;
  /** Injected so a replay of a tool call reproduces a date-dependent answer. */
  now: () => number;
  /** Tools a remote caller may NOT reach, whatever the registry holds. A
   *  write tool reachable over an unauthenticated public route is a hole, not
   *  a feature — see `defaultExposureFilter`. */
  expose?: (tool: ToolDef) => boolean;
  signal?: AbortSignal;
}

/**
 * The default policy: expose read-only, non-destructive tools only.
 *
 * The route this serves has no authentication, exactly like `/api/ai/chat`,
 * because the app is built to run on your own deployment. That is a defensible
 * choice for something that computes a number out of a fixture table and an
 * indefensible one for something that writes. `write_artifact` therefore does
 * not leave the browser, and the filter is a property of the tool's own
 * annotations rather than a hand-maintained deny-list that a new tool can be
 * forgotten from.
 */
export function defaultExposureFilter(tool: ToolDef): boolean {
  return tool.annotations.readOnly && !tool.annotations.destructive;
}

function ok(id: RpcResponse["id"], result: unknown): RpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function err(id: RpcResponse["id"], code: number, message: string, data?: unknown): RpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

/** MCP renders a tool result as content blocks plus an error flag. A failed
 *  call is NOT a JSON-RPC error — the spec is explicit that a tool that fails
 *  returns `isError: true` so the model can read the failure and recover,
 *  rather than the transport swallowing it. */
function toContent(r: ToolResult): { content: Array<{ type: "text"; text: string }>; isError?: boolean; structuredContent?: unknown } {
  const out: { content: Array<{ type: "text"; text: string }>; isError?: boolean; structuredContent?: unknown } = {
    content: [{ type: "text", text: r.observation }],
  };
  if (r.status !== "ok") out.isError = true;
  if (r.value !== undefined) out.structuredContent = { value: r.value };
  return out;
}

function toolDescriptor(t: ToolDef) {
  return {
    name: t.name,
    title: t.title,
    // Determinism is part of the contract, not a footnote: a caller quoting a
    // live figure as an audited one is the failure this prevents.
    description: `${t.description}${t.deterministic
      ? " Deterministic: identical arguments always produce an identical result."
      : " NOT deterministic: the result may change between calls."}`,
    inputSchema: t.inputSchema,
    annotations: {
      title: t.title,
      readOnlyHint: t.annotations.readOnly,
      destructiveHint: t.annotations.destructive,
      openWorldHint: t.annotations.openWorld,
      idempotentHint: t.deterministic,
    },
  };
}

/** Handle one JSON-RPC message. Returns null for a notification, which by
 *  spec gets no reply at all — answering one puts an unmatched id on the wire
 *  and a strict client will drop the connection. */
export async function handleMcpMessage(raw: unknown, opts: McpServerOptions): Promise<RpcResponse | null> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return err(null, RPC.INVALID_REQUEST, "A JSON-RPC message must be an object.");
  }
  const msg = raw as Partial<RpcRequest>;
  if (msg.jsonrpc !== "2.0") {
    return err(msg.id ?? null, RPC.INVALID_REQUEST, `Unsupported jsonrpc version: ${String(msg.jsonrpc)}. This server speaks 2.0.`);
  }
  if (typeof msg.method !== "string" || msg.method.length === 0) {
    return err(msg.id ?? null, RPC.INVALID_REQUEST, "A JSON-RPC message must carry a method.");
  }

  const isNotification = msg.id === undefined;
  const id = msg.id ?? null;
  const expose = opts.expose ?? defaultExposureFilter;

  switch (msg.method) {
    case "initialize": {
      if (isNotification) return null;
      return ok(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        // Only what is actually implemented. Advertising a capability this
        // server does not serve makes a conforming client call it and get a
        // method-not-found it had every right not to expect.
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: opts.serverName, version: opts.serverVersion },
        instructions:
          "Deterministic analysis tools from Web-AIOS. Every figure comes from a fixed, versioned " +
          "fixture set and each observation states the formula used, so two callers reach the same " +
          "number and can audit the difference when they do not.",
      });
    }

    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return isNotification ? null : ok(id, {});

    case "tools/list": {
      if (isNotification) return null;
      const tools = opts.registry.list().filter(expose).map(toolDescriptor);
      return ok(id, { tools });
    }

    case "tools/call": {
      if (isNotification) return null;
      const name = typeof msg.params?.name === "string" ? msg.params.name : "";
      if (!name) return err(id, RPC.INVALID_PARAMS, "tools/call requires params.name (a string).");

      const tool = opts.registry.get(name);
      // A hidden tool and a missing one must answer the same way. Saying "that
      // tool exists but you may not have it" tells an unauthenticated caller
      // what the deployment holds.
      if (!tool || !expose(tool)) {
        const available = opts.registry.list().filter(expose).map((t) => t.name);
        return err(id, RPC.TOOL_NOT_FOUND, `No tool named ${name}. Available: ${available.join(", ") || "(none)"}.`);
      }

      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        return err(id, RPC.INVALID_PARAMS, "params.arguments must be an object.");
      }

      // Validate here as well as inside runTool: a bad-argument reply that
      // names the constraint is worth more to a remote client than a generic
      // tool error, and it costs one call.
      const check = validateArgs(tool.inputSchema, args);
      if (!check.ok) {
        return ok(id, { content: [{ type: "text", text: `${name}: ${check.error}` }], isError: true });
      }

      let result: ToolResult;
      try {
        result = await runTool(tool, args, {
          runId: `mcp_${opts.now()}`,
          stepIndex: 0,
          signal: opts.signal ?? new AbortController().signal,
          // A remote caller gets no access to this OS's memory. Facts are the
          // user's documents; the tools do not need them and must not see them.
          facts: createFactStore([]),
          span: () => {},
          parentSpanId: "mcp",
          now: opts.now,
          // Per-call, never shared: a cache that outlives one request would
          // serve one caller's arguments to the next.
          cache: new Map(),
        });
      } catch (e) {
        return err(id, RPC.INTERNAL_ERROR, e instanceof Error ? e.message : "The tool threw.");
      }
      return ok(id, toContent(result));
    }

    case "resources/list":
      return isNotification ? null : ok(id, { resources: [] });

    case "prompts/list":
      return isNotification ? null : ok(id, { prompts: [] });

    default:
      if (isNotification) return null;
      return err(id, RPC.METHOD_NOT_FOUND, `This server does not implement ${msg.method}.`);
  }
}

/** A batch is legal JSON-RPC and some clients send one. Notifications inside a
 *  batch produce no entry, and a batch of only notifications produces no reply
 *  at all — which the route must render as 202, not as an empty array. */
export async function handleMcpPayload(
  raw: unknown,
  opts: McpServerOptions,
): Promise<RpcResponse | RpcResponse[] | null> {
  if (Array.isArray(raw)) {
    if (raw.length === 0) return err(null, RPC.INVALID_REQUEST, "An empty batch is not a valid request.");
    const out: RpcResponse[] = [];
    for (const one of raw) {
      const r = await handleMcpMessage(one, opts);
      if (r) out.push(r);
    }
    return out.length > 0 ? out : null;
  }
  return handleMcpMessage(raw, opts);
}
