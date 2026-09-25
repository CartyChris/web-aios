import { lookup } from "node:dns/promises";
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
