import { NextRequest } from "next/server";
import { assertPublic } from "@/lib/public-url";
import {
  MAX_REWRITE_BYTES, SANDBOX_CSP, applySetCookies, charsetOf, cookieHeaderFor, corsHeaders, decodeTarget,
  encodeTarget, filterResponseHeaders, headInjection, parseJar, rewriteCss, rewriteHtml, serializeJar, validSid,
} from "@/lib/webproxy";

// Node runtime: the SSRF guard needs real DNS. Bodies other than HTML/CSS are
// streamed straight through, so Vercel's ~4.5 MB cap on buffered function
// responses does not apply to them; maxDuration bounds long media streams.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** /api/web/<sid>/<scheme>/<host>/<path>?<query> — the Browser's Web mode.
 *
 *  A rewriting proxy: fetches the upstream URL (after the shared SSRF check),
 *  strips the headers that stop a page being framed, rewrites HTML and CSS so
 *  links and subresources stay in the proxy, and injects a runtime shim. All
 *  pure rewriting lives in src/lib/webproxy.ts (tested in
 *  tests/webproxy.test.mjs).
 *
 *  Every response, including errors and redirects, carries a `sandbox` CSP
 *  without allow-same-origin: the page runs with an opaque origin even if
 *  someone opens this URL top-level, so it can never read the OS's
 *  localStorage (where AI keys live).
 *
 *  Redirects are NOT followed here: the Location is rewritten into the proxy
 *  and handed to the browser, so every hop comes back through this handler
 *  and through assertPublic again, and the browser's URL stays truthful. */

const JAR_COOKIE = "wj";
const FORWARD_REQUEST = ["accept", "accept-language", "content-type", "range", "if-none-match", "if-modified-since", "user-agent", "x-requested-with"];
const MAX_UPLOAD = 10 * 1024 * 1024;

function parse(req: NextRequest): { sid: string; target: string } | null {
  const m = /^\/api\/web\/([^/]+)\/(.+)$/.exec(req.nextUrl.pathname);
  if (!m || !validSid(m[1])) return null;
  const target = decodeTarget(m[2], req.nextUrl.search);
  return target ? { sid: m[1], target } : null;
}

function baseHeaders(req: NextRequest): Headers {
  const h = new Headers();
  for (const [k, v] of corsHeaders(req.headers.get("origin"))) h.append(k, v);
  h.set("content-security-policy", SANDBOX_CSP);
  return h;
}

function fail(req: NextRequest, status: number, message: string): Response {
  const h = baseHeaders(req);
  h.set("content-type", "text/html; charset=utf-8");
  h.set("cache-control", "no-store");
  const safe = message.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Proxy error</title><body style="font:14px system-ui;padding:24px;color:#333"><h3>Web mode could not load this page</h3><p>${safe}</p><p>Try Cloud or Reader mode from the Browser toolbar.</p></body>`,
    { status, headers: h },
  );
}

async function readCapped(body: ReadableStream<Uint8Array>, cap: number): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

function decodeText(bytes: Uint8Array, contentType: string): string {
  try { return new TextDecoder(charsetOf(contentType)).decode(bytes); } catch { return new TextDecoder().decode(bytes); }
}

async function handle(req: NextRequest): Promise<Response> {
  const parsed = parse(req);
  if (!parsed) return fail(req, 400, "That is not a valid proxied address.");
  const { sid, target } = parsed;
  const prefix = `${req.nextUrl.origin}/api/web/${sid}`;
  const cookiePath = `/api/web/${sid}/`;

  let url: URL;
  try { url = await assertPublic(target); } catch (e) {
    return fail(req, 400, e instanceof Error ? e.message : "Blocked.");
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const jar = parseJar(req.cookies.get(JAR_COOKIE)?.value);

  const headers = new Headers();
  for (const k of FORWARD_REQUEST) {
    const v = req.headers.get(k);
    if (v) headers.set(k, v);
  }
  const cookie = cookieHeaderFor(jar, url.hostname, nowSec);
  if (cookie) headers.set("cookie", cookie);
  // The real Referer would be our own origin; the upstream site's own origin
  // is the closest honest stand-in and satisfies most hotlink checks.
  headers.set("referer", `${url.origin}/`);

  let body: ArrayBuffer | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    body = await req.arrayBuffer();
    if (body.byteLength > MAX_UPLOAD) return fail(req, 413, "Upload exceeds the 10 MB proxy limit.");
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: req.method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    return fail(req, 502, `Upstream request failed: ${e instanceof Error ? e.message : "unknown error"}`);
  }

  // Cookie jar: fold in whatever upstream set, on redirects too.
  const setCookies = res.headers.getSetCookie?.() ?? [];
  const out = baseHeaders(req);
  if (setCookies.length) {
    const next = applySetCookies(jar, url.hostname, setCookies, nowSec);
    const value = serializeJar(next);
    out.append(
      "set-cookie",
      `${JAR_COOKIE}=${value}; Path=${cookiePath}; HttpOnly; Secure; SameSite=None; Max-Age=${value ? 86400 : 0}`,
    );
  }

  if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
    let dest: string;
    try { dest = new URL(res.headers.get("location") ?? "", url).href; } catch { return fail(req, 502, "Upstream sent an invalid redirect."); }
    const enc = encodeTarget(dest);
    if (!enc) return fail(req, 400, "Upstream redirected to a non-web address.");
    out.set("location", `${prefix}/${enc}`);
    out.set("cache-control", "no-store");
    await res.body?.cancel().catch(() => {});
    return new Response(null, { status: res.status, headers: out });
  }

  const type = res.headers.get("content-type") ?? "";
  const isHtml = /text\/html|application\/xhtml\+xml/i.test(type);
  const isCss = /text\/css/i.test(type);
  const decoded = Boolean(res.headers.get("content-encoding")); // undici already inflated it
  const rewrite = (isHtml || isCss) && req.method !== "HEAD" && res.status !== 206 && res.body;

  for (const [k, v] of filterResponseHeaders([...res.headers.entries()], { rewritten: Boolean(rewrite), decoded })) {
    if (k.toLowerCase() === "content-security-policy") continue; // already set by baseHeaders
    out.append(k, v);
  }

  if (rewrite && res.body) {
    const bytes = await readCapped(res.body, MAX_REWRITE_BYTES);
    if (!bytes) return fail(req, 413, "This page is larger than the 8 MB rewrite limit.");
    const text = decodeText(bytes, type);
    out.set("cache-control", isHtml ? "no-store" : "public, max-age=300");
    if (isHtml) {
      const docCookies = cookieHeaderFor(jar, url.hostname, nowSec, true);
      out.set("content-type", "text/html; charset=utf-8");
      return new Response(rewriteHtml(text, url.href, prefix, headInjection(url.href, prefix, docCookies)), { status: res.status, headers: out });
    }
    out.set("content-type", "text/css; charset=utf-8");
    return new Response(rewriteCss(text, url.href, prefix), { status: res.status, headers: out });
  }

  // Everything else (JS, images, fonts, media incl. 206 ranges) streams through.
  return new Response(req.method === "HEAD" ? null : res.body, { status: res.status, headers: out });
}

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;

/** CORS preflight for the shim's credentialed fetch/XHR from the opaque origin. */
export function OPTIONS(req: NextRequest): Response {
  const h = baseHeaders(req);
  h.set("access-control-allow-methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
  h.set("access-control-allow-headers", req.headers.get("access-control-request-headers") ?? "*");
  h.set("access-control-max-age", "600");
  return new Response(null, { status: 204, headers: h });
}
