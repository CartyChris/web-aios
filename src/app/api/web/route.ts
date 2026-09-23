import { NextRequest } from "next/server";
import { SANDBOX_CSP, encodeTarget, validSid } from "@/lib/webproxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /api/web?u=<url>&s=<sid> — convenience entry point. Redirects to the
 *  path-shaped proxy URL (/api/web/<sid>/<scheme>/<host>/<path>) that the
 *  Browser app uses, so relative URLs inside the page keep resolving. Without
 *  a valid `s`, a fixed anonymous session id is used (its cookie jar is shared
 *  by every such visitor to this browser, which is fine for a quick look). */
export function GET(req: NextRequest): Response {
  const u = req.nextUrl.searchParams.get("u") ?? "";
  const s = req.nextUrl.searchParams.get("s") ?? "";
  const enc = encodeTarget(u);
  const headers = new Headers({ "content-security-policy": SANDBOX_CSP, "cache-control": "no-store" });
  if (!enc) {
    headers.set("content-type", "application/json");
    return new Response(JSON.stringify({ error: "u must be an http(s) URL." }), { status: 400, headers });
  }
  const sid = validSid(s) ? s : "anonymous";
  headers.set("location", `${req.nextUrl.origin}/api/web/${sid}/${enc}`);
  return new Response(null, { status: 302, headers });
}
