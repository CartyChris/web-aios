import { isIP } from "node:net";

/** True when an address must not be reachable through the proxy.
 *
 *  Split out of the route handler so it can be tested directly: this is the
 *  single check standing between a public deployment and a request to the
 *  cloud metadata endpoint, and it should fail loudly if anyone loosens it.
 *
 *  Anything unparseable returns true — the guard fails closed. */
export function isPrivateAddress(ip: string): boolean {
  if (!ip) return true;

  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::") return true;
    if (v.startsWith("fc") || v.startsWith("fd")) return true; // unique-local
    if (v.startsWith("fe80")) return true;                      // link-local
    // IPv4-mapped IPv6 (::ffff:169.254.169.254) must be unwrapped and rechecked,
    // otherwise it is a one-line bypass of every rule below.
    const mapped = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }

  if (isIP(ip) !== 4) return true; // not an address we can reason about

  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;            // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;  // carrier-grade NAT
  if (a >= 224) return true;                           // multicast / reserved
  return false;
}
