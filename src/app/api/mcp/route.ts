import { NextRequest } from "next/server";
import { lookup } from "node:dns/promises";
import { isPrivateAddress } from "@/lib/ssrf";

export const runtime = "nodejs";
export const maxDuration = 120;

/* ────────────────────────────────────────────────────────────────────────────
   MCP relay for public servers.

   A browser cannot POST to most MCP servers directly: they are written for
   agents, not pages, so they set no CORS headers and the request never leaves.
   This forwards one JSON-RPC message on the client's behalf.

   It applies the same SSRF rule as /api/proxy, and for the same reason: a
   relay that will fetch any URL a caller names is a hole straight into the
   deployment's private network and cloud metadata. A *localhost* MCP server —
   Godot, Unity, Blender — is therefore refused here by design, and the client
   calls those directly from the browser instead, where localhost means the
   user's own machine rather than ours.
   ──────────────────────────────────────────────────────────────────────────── */

const ALLOWED_HEADERS = new Set([
  "content-type", "accept", "authorization", "mcp-session-id", "mcp-protocol-version", "last-event-id",
]);

export async function POST(req: NextRequest) {
  let body: { url?: string; headers?: Record<string, string>; body?: string };
  try { body = await req.json(); } catch { return json({ error: "Malformed JSON body." }, 400); }

  const raw = body.url?.trim();
  if (!raw) return json({ error: "url is required." }, 400);

  let target: URL;
  try { target = new URL(raw); } catch { return json({ error: "That is not a valid URL." }, 400); }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    return json({ error: "Only http and https are relayed." }, 400);
  }

  // Judge the resolved address, not the hostname — a name can resolve wherever
  // its owner likes, including 127.0.0.1.
  try {
    const { address } = await lookup(target.hostname);
    if (isPrivateAddress(address)) {
      return json(
        { error: "That address is private to the server. A localhost MCP server is reached directly from your browser instead — turn the relay off for it." },
        403,
      );
    }
  } catch {
    return json({ error: `Could not resolve ${target.hostname}.` }, 400);
  }

  const headers = new Headers();
  for (const [k, v] of Object.entries(body.headers ?? {})) {
    if (ALLOWED_HEADERS.has(k.toLowerCase())) headers.set(k, v);
  }
  headers.set("content-type", "application/json");

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: "POST",
      headers,
      body: body.body ?? "{}",
      redirect: "error", // a redirect would escape the check above
      signal: AbortSignal.timeout(90_000),
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "The MCP server could not be reached." }, 502);
  }

  const text = await upstream.text();
  const out = new Headers({ "content-type": upstream.headers.get("content-type") ?? "application/json" });
  // The session id is how every later call is routed, so it must survive the hop.
  const session = upstream.headers.get("mcp-session-id");
  if (session) out.set("mcp-session-id", session);
  return new Response(text, { status: upstream.status, headers: out });
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
