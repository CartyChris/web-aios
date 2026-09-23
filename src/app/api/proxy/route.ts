import { NextRequest } from "next/server";
import { assertPublic } from "@/lib/public-url";
import { frameVerdict } from "@/lib/webproxy";

// Node runtime, not edge: the SSRF guard below needs real DNS resolution, and
// the edge runtime has no resolver.
export const runtime = "nodejs";
export const maxDuration = 30;

/** Fetch a page on the client's behalf.
 *
 *  The Browser and Atlas apps need this because most sites refuse to be framed
 *  and browser CORS blocks reading them directly. A relay like this is also a
 *  textbook SSRF hole on a public deployment, so every request is checked
 *  against the resolved address — not just the hostname, which DNS can lie
 *  about — and redirects are followed manually so each hop is re-checked. */

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 4;

// assertPublic (the SSRF gate) lives in src/lib/public-url.ts, shared with the
// rewriting proxy at /api/web so the two routes cannot drift apart.

export async function GET(req: NextRequest) {
  const target = req.nextUrl.searchParams.get("url");
  const mode = req.nextUrl.searchParams.get("mode") ?? "text";
  if (!target) return Response.json({ error: "url parameter is required." }, { status: 400 });

  let current = target;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const url = await assertPublic(current);

      const res = await fetch(url, {
        redirect: "manual", // each hop is re-validated rather than trusted
        headers: {
          // A plain generic UA: this relay must not impersonate a real browser
          // profile or carry any of the caller's cookies.
          "user-agent": "Mozilla/5.0 (compatible; Web-AIOS/1.0; +https://github.com/)",
          accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        },
        signal: AbortSignal.timeout(20000),
      });

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) break;
        current = new URL(loc, url).toString();
        continue;
      }

      // mode=headers: can this page be framed? The Browser's "auto" mode asks
      // this before choosing between a plain iframe and the rewriting proxy.
      if (mode === "headers") {
        await res.body?.cancel().catch(() => {});
        const verdict = frameVerdict(res.headers.get("x-frame-options"), res.headers.get("content-security-policy"));
        return Response.json({ url: url.toString(), finalUrl: current, status: res.status, contentType: res.headers.get("content-type") ?? "", ...verdict });
      }

      const type = res.headers.get("content-type") ?? "text/plain";
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_BYTES) return Response.json({ error: "Response exceeds the 5 MB proxy limit." }, { status: 413 });

      if (mode === "raw") {
        return new Response(buf, {
          status: res.status,
          headers: { "content-type": type, "cache-control": "public, max-age=300" },
        });
      }

      const text = new TextDecoder().decode(buf);
      return Response.json({
        url: url.toString(),
        finalUrl: current,
        status: res.status,
        contentType: type,
        title: extractTitle(text),
        text: mode === "html" ? text : toPlainText(text),
        html: mode === "html" ? text : undefined,
      });
    }
    return Response.json({ error: "Too many redirects." }, { status: 508 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Proxy request failed." }, { status: 400 });
  }
}

function extractTitle(html: string): string {
  return html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim().slice(0, 300) ?? "";
}

/** Strip a page down to readable prose so an agent's context isn't 90% markup. */
function toPlainText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 200_000);
}
