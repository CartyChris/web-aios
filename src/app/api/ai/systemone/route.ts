import { NextRequest } from "next/server";

export const runtime = "nodejs";

/** Relay to TypeSafe's System One endpoint (Jev).
 *
 *  The browser cannot call it directly (CORS, and a deployment may hold the key
 *  in TYPESAFE_API_KEY). The caller's key travels in `x-api-key` and wins over
 *  the env key. Upstream errors come back verbatim with their status, so the
 *  app shows TypeSafe's own message instead of a generic one. */
const UPSTREAM = "https://api.typesafe.ai/v1/systemone";
const TIMEOUT_MS = 15_000;

export async function POST(req: NextRequest) {
  const key = req.headers.get("x-api-key")?.trim() || process.env.TYPESAFE_API_KEY?.trim() || "";
  if (!key) {
    return json({ error: "No TypeSafe API key. Add one in the System One app (it is saved under Settings as the typesafe key), or set TYPESAFE_API_KEY on the deployment." }, 400);
  }
  let body: { state?: unknown; questions?: unknown; model?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Malformed JSON body." }, 400);
  }
  if (body.state === undefined || !body.questions || typeof body.questions !== "object") {
    return json({ error: "state and questions are required." }, 400);
  }
  try {
    const res = await fetch(UPSTREAM, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: body.model || "jev-latest", state: body.state, questions: body.questions }),
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(TIMEOUT_MS)]),
    });
    const text = await res.text();
    return new Response(text, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } });
  } catch (e) {
    const timedOut = e instanceof DOMException && e.name === "TimeoutError";
    return json({ error: timedOut ? `TypeSafe did not answer within ${TIMEOUT_MS / 1000}s.` : `Could not reach TypeSafe: ${e instanceof Error ? e.message : String(e)}` }, timedOut ? 504 : 502);
  }
}

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
