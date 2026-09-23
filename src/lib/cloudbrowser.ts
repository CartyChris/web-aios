/* Server-only. Cloud browser providers for the Browser's Cloud mode: a real
   remote Chromium the user watches and drives through an embeddable live view.

   Implemented end to end: Steel (steel.dev). Chosen because its sessions live
   until released or timed out, independent of any CDP connection, which is
   what a stateless serverless route needs (connect, navigate, disconnect),
   and because its live view (`debugUrl?interactive=true&showControls=true`)
   is an interactive iframe with its own address bar and back/forward.
     docs: https://docs.steel.dev/llms-full.txt (Quick Reference, REST API,
           Live Sessions embed parameters), https://steel.apidocumentation.com/api-reference

   Browserbase is described below but not wired: without the paid keepAlive
   flag a Browserbase session ENDS when the CDP client disconnects, so the
   connect-navigate-disconnect pattern here would kill the session on the
   first navigation. Add it as another CloudProvider when that is acceptable.
     docs: https://docs.browserbase.com/reference/api/create-a-session,
           https://docs.browserbase.com/reference/api/session-live-urls,
           https://docs.browserbase.com/features/keep-alive

   Keys arrive per request (x-api-key) or from an env var; they are never
   logged and never returned to the client. */

export interface CloudSession {
  id: string;
  /** Embeddable, interactive live view. */
  liveUrl: string;
}

export interface CloudProvider {
  id: string;
  name: string;
  signupUrl: string;
  envKey: string;
  create(key: string, timeoutMs: number): Promise<CloudSession>;
  navigate(key: string, sessionId: string, url: string): Promise<void>;
  release(key: string, sessionId: string): Promise<void>;
}

async function jsonOrThrow(res: Response, what: string): Promise<Record<string, unknown>> {
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const msg = (data.message ?? data.error ?? text.slice(0, 200)) || res.statusText;
    throw new Error(`${what} failed (${res.status}): ${String(msg)}`);
  }
  return data;
}

/** Minimal CDP client over Node's global WebSocket (Node 22+). Connects to a
 *  browser-level endpoint, finds the first page target (creating one if the
 *  browser has none), navigates it, and disconnects. No dependency. */
export async function cdpNavigate(wsUrl: string, url: string, timeoutMs = 20000): Promise<void> {
  const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!WS) throw new Error("This server runtime has no WebSocket; Cloud navigation needs Node 22 or later.");
  const ws = new WS(wsUrl);
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();

  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("Could not open the cloud browser's control socket.")));
  });
  ws.addEventListener("message", (ev: MessageEvent) => {
    let msg: { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
    try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)); } catch { return; }
    if (msg.id === undefined) return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message ?? "CDP error"));
    else p.resolve(msg.result ?? {});
  });
  ws.addEventListener("close", () => {
    for (const p of pending.values()) p.reject(new Error("Control socket closed."));
    pending.clear();
  });

  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Cloud navigation timed out.")), timeoutMs));
  try {
    await Promise.race([opened, timer]);
    const run = async () => {
      const { targetInfos } = (await send("Target.getTargets")) as { targetInfos?: Array<{ targetId: string; type: string }> };
      const page = targetInfos?.find((t) => t.type === "page");
      if (!page) { await send("Target.createTarget", { url }); return; }
      const { sessionId } = (await send("Target.attachToTarget", { targetId: page.targetId, flatten: true })) as { sessionId: string };
      await send("Page.navigate", { url }, sessionId);
      await send("Target.activateTarget", { targetId: page.targetId }).catch(() => ({}));
    };
    await Promise.race([run(), timer]);
  } finally {
    try { ws.close(); } catch { /* already closed */ }
  }
}

export const steel: CloudProvider = {
  id: "steel",
  name: "Steel",
  signupUrl: "https://app.steel.dev/settings/api-keys",
  envKey: "STEEL_API_KEY",
  async create(key, timeoutMs) {
    const res = await fetch("https://api.steel.dev/v1/sessions", {
      method: "POST",
      headers: { "steel-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ timeout: timeoutMs }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await jsonOrThrow(res, "Creating the Steel session");
    const id = String(data.id ?? "");
    const debugUrl = String(data.debugUrl ?? data.sessionViewerUrl ?? "");
    if (!id || !debugUrl) throw new Error("Steel returned a session without an id or live view URL.");
    const live = new URL(debugUrl);
    live.searchParams.set("interactive", "true");
    live.searchParams.set("showControls", "true");
    return { id, liveUrl: live.toString() };
  },
  async navigate(key, sessionId, url) {
    // The documented browser endpoint (Quick Reference): the key goes in the
    // query string, which is why this URL is built here and never sent to the client.
    const ws = `wss://connect.steel.dev?apiKey=${encodeURIComponent(key)}&sessionId=${encodeURIComponent(sessionId)}`;
    await cdpNavigate(ws, url);
  },
  async release(key, sessionId) {
    const res = await fetch(`https://api.steel.dev/v1/sessions/${encodeURIComponent(sessionId)}/release`, {
      method: "POST",
      headers: { "steel-api-key": key, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(15000),
    });
    await jsonOrThrow(res, "Releasing the Steel session");
  },
};

export const CLOUD_PROVIDERS: Record<string, CloudProvider> = { steel };
