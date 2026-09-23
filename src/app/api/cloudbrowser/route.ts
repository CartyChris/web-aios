import { NextRequest } from "next/server";
import { CLOUD_PROVIDERS } from "@/lib/cloudbrowser";
import { assertPublic } from "@/lib/public-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

/** POST /api/cloudbrowser  { action: "create" | "navigate" | "release", provider?, sessionId?, url? }
 *  Key: the `x-api-key` header (the user's own, stored in their browser like
 *  every other key), or the provider's env var on the deployment.
 *  The key is never logged, echoed, or returned. `release` also accepts the
 *  key in the body because navigator.sendBeacon cannot set headers. */

const SESSION_TIMEOUT_MS = 15 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export async function POST(req: NextRequest) {
  let body: { action?: string; provider?: string; sessionId?: string; url?: string; key?: string };
  try { body = await req.json(); } catch { return Response.json({ error: "Expected a JSON body." }, { status: 400 }); }

  const provider = CLOUD_PROVIDERS[body.provider ?? "steel"];
  if (!provider) return Response.json({ error: "Unknown cloud browser provider." }, { status: 400 });
  const key = req.headers.get("x-api-key")?.trim() || body.key?.trim() || process.env[provider.envKey] || "";
  if (!key) {
    return Response.json({ error: `No ${provider.name} API key. Add one in the Browser's Cloud panel, or set ${provider.envKey}.`, needsKey: true, signupUrl: provider.signupUrl }, { status: 401 });
  }

  try {
    switch (body.action) {
      case "create": {
        const session = await provider.create(key, SESSION_TIMEOUT_MS);
        if (body.url) {
          try {
            await assertPublic(body.url);
            await provider.navigate(key, session.id, body.url);
          } catch (e) {
            return Response.json({ ...session, provider: provider.id, timeoutMs: SESSION_TIMEOUT_MS, warning: e instanceof Error ? e.message : "Initial navigation failed." });
          }
        }
        return Response.json({ ...session, provider: provider.id, timeoutMs: SESSION_TIMEOUT_MS });
      }
      case "navigate": {
        if (!body.sessionId || !ID_RE.test(body.sessionId)) return Response.json({ error: "sessionId is required." }, { status: 400 });
        if (!body.url) return Response.json({ error: "url is required." }, { status: 400 });
        // The remote browser is not on our network, but refusing private
        // addresses keeps this endpoint from being a way to probe anything.
        await assertPublic(body.url);
        await provider.navigate(key, body.sessionId, body.url);
        return Response.json({ ok: true });
      }
      case "release": {
        if (!body.sessionId || !ID_RE.test(body.sessionId)) return Response.json({ error: "sessionId is required." }, { status: 400 });
        await provider.release(key, body.sessionId);
        return Response.json({ ok: true });
      }
      default:
        return Response.json({ error: "action must be create, navigate or release." }, { status: 400 });
    }
  } catch (e) {
    const message = (e instanceof Error ? e.message : "Cloud browser request failed.").split(key).join("[key]");
    return Response.json({ error: message }, { status: 502 });
  }
}
