import { lookup } from "node:dns/promises";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import { isPrivateAddress } from "./ssrf";

/* Server-only. The chat and model-list relays accept a user-supplied base URL
   (a custom endpoint, a proxy), and fetch it from the deployment. Without a
   check, that is a request the deployment makes on anyone's behalf to any
   address it can reach, including its own metadata endpoint and localhost.
   The provider's built-in URL is trusted; anything else must be http(s) and
   resolve to a public address. Local providers are called from the browser,
   never through here, so this refuses nothing legitimate. */
export async function checkBaseUrl(candidate: string | undefined | null, builtin: string): Promise<string | null> {
  const raw = candidate?.trim();
  if (!raw || raw.replace(/\/+$/, "") === builtin.replace(/\/+$/, "")) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return "That base URL is not a valid URL."; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "Only http and https base URLs are relayed.";
  try {
    const { address } = await lookup(u.hostname);
    if (isPrivateAddress(address)) return "That base URL is private to the server. Local endpoints are called from your browser, not relayed.";
  } catch {
    return `Could not resolve ${u.hostname}.`;
  }
  return null;
}

/** The deployment's own key may only travel to the provider's built-in URL.
 *  A caller who picks the base URL must bring their own key: otherwise one
 *  anonymous request with baseUrl=https://attacker.example sends the env key
 *  there (confirmed by the review, reproduced against the real route). */
export function deploymentKeyAllowed(candidate: string | undefined | null, builtin: string): boolean {
  const raw = candidate?.trim();
  return !raw || raw.replace(/\/+$/, "") === builtin.replace(/\/+$/, "");
}

/** fetch() for caller-chosen URLs, pinned at connect time.
 *
 *  checkBaseUrl resolves the host and judges the address, but fetch then
 *  resolves it again, so a host with a zero TTL can answer "public" to the
 *  check and "127.0.0.1" to the connection (DNS rebinding). Here the check IS
 *  the connection's own lookup: every address the socket may use is judged,
 *  and a private one fails the request. Redirects are not followed (http
 *  never does); the caller sees the 3xx and refuses it. */
export function pinnedFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const u = new URL(String(input));
  if (u.protocol !== "https:" && u.protocol !== "http:") return Promise.reject(new Error("Only http and https are relayed."));
  const send = u.protocol === "https:" ? httpsRequest : httpRequest;
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
  return new Promise((resolve, reject) => {
    const req = send(u, {
      method: init.method ?? "GET",
      headers,
      lookup: (host: string, opts: { all?: boolean }, cb: (err: Error | null, address: string | LookupAddress[], family?: number) => void) => {
        dnsLookup(host, { all: true }, (err, list) => {
          if (err) return cb(err, [], 4);
          const bad = list.find((a) => isPrivateAddress(a.address));
          if (bad) return cb(new Error(`Refused: ${host} resolved to a private address (${bad.address}).`), [], 4);
          if (opts?.all) cb(null, list);
          else cb(null, list[0].address, list[0].family);
        });
      },
    }, (res) => {
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(", ") : String(v));
      const status = res.statusCode ?? 0;
      const body = status === 204 || status === 304 || (init.method ?? "GET") === "HEAD" ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>);
      resolve(new Response(body, { status, statusText: res.statusMessage, headers: h }));
    });
    req.on("error", reject);
    init.signal?.addEventListener("abort", () => req.destroy(Object.assign(new Error("Aborted"), { name: "AbortError" })), { once: true });
    if (typeof init.body === "string") req.write(init.body);
    req.end();
  });
}
