import { NextRequest } from "next/server";
import { createRegistry, builtinTools } from "@/lib/harness/tools";
import { FIXTURES } from "@/lib/harness/fixtures";
import { handleMcpPayload, MCP_PROTOCOL_VERSION } from "@/lib/harness/mcp-server";

export const runtime = "nodejs";
export const maxDuration = 30;

/* ────────────────────────────────────────────────────────────────────────────
   Web-AIOS as an MCP server.

   Thirty lines, because the work is in `lib/harness/mcp-server.ts` and that
   module is pure and tested. This is the only part that could not be: reading
   a request, choosing a status code, and building the registry.

   `write_artifact` is deliberately NOT passed a writer. The default exposure
   filter would hide it anyway — it is not read-only — but a route with no
   authentication should not be one policy edit away from a public write, so
   the capability simply is not constructed here.
   ──────────────────────────────────────────────────────────────────────────── */

const registry = createRegistry();
for (const tool of builtinTools({ fixtures: FIXTURES })) registry.register(tool);

function cors(h: Headers): Headers {
  // An MCP client is frequently another origin — a desktop app, an IDE, a
  // different deployment. Everything reachable here is read-only and carries
  // no credentials, so a wildcard is the honest setting rather than a lax one.
  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-headers", "content-type, accept, mcp-session-id, mcp-protocol-version");
  h.set("access-control-allow-methods", "POST, GET, OPTIONS");
  h.set("access-control-expose-headers", "mcp-session-id, mcp-protocol-version");
  return h;
}

function json(data: unknown, status = 200) {
  const h = cors(new Headers({ "content-type": "application/json" }));
  h.set("mcp-protocol-version", MCP_PROTOCOL_VERSION);
  return new Response(JSON.stringify(data), { status, headers: h });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: cors(new Headers()) });
}

/** A GET is how a person checks the endpoint is alive, and how a client that
 *  expects an SSE channel discovers this server does not offer one. */
export async function GET() {
  return json({
    name: "web-aios",
    protocolVersion: MCP_PROTOCOL_VERSION,
    transport: "streamable-http (POST only; this server opens no SSE stream)",
    tools: registry.list().filter((t) => t.annotations.readOnly && !t.annotations.destructive).map((t) => t.name),
  });
}

export async function POST(req: NextRequest) {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Malformed JSON." } }, 400);
  }

  const reply = await handleMcpPayload(payload, {
    registry,
    serverName: "web-aios",
    serverVersion: "1.0.0",
    now: () => Date.now(),
    signal: req.signal,
  });

  // A payload of nothing but notifications gets 202 and an empty body. An
  // empty JSON array is a different thing on the wire and a strict client is
  // entitled to reject it.
  if (reply === null) return new Response(null, { status: 202, headers: cors(new Headers()) });
  return json(reply);
}
