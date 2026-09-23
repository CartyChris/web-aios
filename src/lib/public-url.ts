import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPrivateAddress } from "./ssrf";

/* Server-only. The one SSRF gate shared by every route that fetches a URL a
   user typed: /api/proxy (reader text, raw bytes, framing check) and /api/web
   (the rewriting proxy behind the Browser's Web mode). Factored out of the
   proxy route so the two cannot drift apart.

   The address is judged after DNS resolution, not by hostname, because a
   hostname can resolve to anything; callers that follow redirects must call
   this again on every hop. */

export const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal", "metadata.goog", "instance-data"]);

export async function assertPublic(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https are allowed.");

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost")) {
    throw new Error("That host is not reachable through the proxy.");
  }

  // Resolve first, then judge the address. Checking only the hostname is what
  // makes most naive proxies trivially bypassable.
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error("That address range is not reachable through the proxy.");
  } else {
    let addrs: Array<{ address: string }>;
    try {
      addrs = await lookup(host, { all: true });
    } catch {
      throw new Error("Could not resolve that host.");
    }
    if (!addrs.length) throw new Error("Could not resolve that host.");
    if (addrs.some((a) => isPrivateAddress(a.address))) throw new Error("That host resolves to a private address.");
  }
  return url;
}
