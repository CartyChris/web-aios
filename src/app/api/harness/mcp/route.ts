import { NextRequest } from "next/server";
import { createRegistry, builtinTools } from "@/lib/harness/tools";
import { FIXTURES } from "@/lib/harness/fixtures";
import { handleMcpPayload, MCP_PROTOCOL_VERSION } from "@/lib/harness/mcp-server";
import { webTools } from "@/lib/harness/webtools";
import { SERVICES } from "@/lib/services";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPrivateAddress } from "@/lib/ssrf";

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

/* ── the live services ──────────────────────────────────────────────────────
   Every free service in `lib/services.ts` is also an MCP tool here, so a
   client that connects gets 42 keyless data sources alongside the
   deterministic ones.

   On by default, and the reasoning is worth writing down rather than
   assuming. This deployment already ships `/api/proxy`, which relays ANY
   public URL on an unauthenticated caller's behalf; a fixed catalogue of
   read-only GETs against named hosts is strictly less exposure than that. The
   one genuine cost is attribution: requests leave from the deployment's IP, so
   a stranger hammering this route spends YOUR rate limit at GitHub or NVD, not
   theirs. Set WEBAIOS_MCP_LIVE=off to serve only the deterministic tools.
   ────────────────────────────────────────────────────────────────────────── */
const LIVE_ENABLED = process.env.WEBAIOS_MCP_LIVE !== "off";

const registry = createRegistry();
for (const tool of builtinTools({ fixtures: FIXTURES })) registry.register(tool);

if (LIVE_ENABLED) {
  // Server-side, so `reach` is irrelevant: CORS is a browser rule and there is
  // no browser here. Every URL comes from the fixed catalogue, so the hosts
  // are a closed set and there is nothing for a caller to redirect.
  for (const tool of webTools({
    only: SERVICES.map((s) => s.id),
    fetchText: async (url, o) => followAndFetch(url, o.signal),
  })) registry.register(tool);
}

const MAX_REDIRECTS = 4;

/**
 * Fetch a catalogued service URL, following redirects and re-checking each hop.
 *
 * `redirect: "error"` was the first version and it was wrong: restcountries.com
 * answers 301 and sends you to a different host entirely, so that tool failed
 * permanently with a bare "fetch failed" while the browser path — which goes
 * through `/api/proxy`, and has followed redirects all along — worked fine. The
 * bug was invisible in unit tests, because the transport is injected there.
 *
 * Following blindly is the other wrong answer. These URLs are ours, but the
 * hosts are not, and a hostile or compromised upstream that redirects to
 * 169.254.169.254 would have this function fetch the deployment's own cloud
 * metadata. So each hop is resolved and judged by the same rule `/api/proxy`
 * uses, on the ADDRESS rather than the hostname, because a name resolves
 * wherever its owner likes.
 */
async function followAndFetch(startUrl: string, signal: AbortSignal): Promise<string> {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = new URL(current);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("only http and https are fetched");
    }
    await assertPublic(url.hostname);

    const res = await fetch(url, {
      signal,
      redirect: "manual", // each hop is re-validated rather than trusted
      headers: {
        accept: "application/json, text/plain, */*",
        // Several of these hosts (Nominatim, crates.io) refuse or throttle a
        // request with no declared agent.
        "user-agent": "Mozilla/5.0 (compatible; Web-AIOS/1.0; +https://web-aios.vercel.app)",
      },
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`the service answered HTTP ${res.status} with no location header`);
      current = new URL(location, url).toString();
      continue;
    }
    if (!res.ok) throw new Error(`the service answered HTTP ${res.status}`);
    return res.text();
  }
  throw new Error(`more than ${MAX_REDIRECTS} redirects`);
}

async function assertPublic(hostname: string): Promise<void> {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error("that address range is not reachable");
    return;
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new Error(`could not resolve ${host}`);
  }
  if (addrs.length === 0) throw new Error(`could not resolve ${host}`);
  if (addrs.some((a) => isPrivateAddress(a.address))) {
    throw new Error(`${host} resolves to a private address`);
  }
}

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
  const exposed = registry.list().filter((t) => t.annotations.readOnly && !t.annotations.destructive);
  return json({
    name: "web-aios",
    protocolVersion: MCP_PROTOCOL_VERSION,
    transport: "streamable-http (POST only; this server opens no SSE stream)",
    // Stated separately, because "20 tools" hides the fact that half of them
    // can return a different answer on the next call.
    deterministicTools: exposed.filter((t) => t.deterministic).map((t) => t.name),
    liveTools: exposed.filter((t) => !t.deterministic).map((t) => t.name),
    liveServicesEnabled: LIVE_ENABLED,
    resources: FIXTURES.docs.length,
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
    fixtures: FIXTURES,
  });

  // A payload of nothing but notifications gets 202 and an empty body. An
  // empty JSON array is a different thing on the wire and a strict client is
  // entitled to reject it.
  if (reply === null) return new Response(null, { status: 202, headers: cors(new Headers()) });
  return json(reply);
}
