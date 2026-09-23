import { parseScene, type Scene } from "./scenes";

/* Hand this desktop to another device.

   State here lives in one browser's storage, so "continue on my phone" has no
   server to go through. A link can carry it instead: the scene (which apps are
   open, where, on which desktop) packed into the URL fragment. A fragment is
   never sent to a server, so the arrangement goes phone-to-phone through
   whatever carried the link and nowhere else.

   The receiving side treats it as untrusted input, because it is: anyone can
   craft a link. It goes through parseScene, which clamps every number,
   ignores unknown fields and caps the window count, and the shell asks before
   opening anything. Pure: no DOM, no clock. */

const PREFIX = "v1.";
/** Launch args ride along only when small. A note id is useful on the other
 *  device; a pasted document is not, and would make the link unshareable. */
const MAX_ARGS_JSON = 400;
/** Well under what messengers and browsers truncate links at. */
export const MAX_HANDOFF_CHARS = 6000;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += B64[n & 63];
  }
  return out;
}

function fromBase64Url(s: string): Uint8Array | null {
  const vals: number[] = [];
  for (const ch of s) {
    const v = B64.indexOf(ch);
    if (v < 0) return null;
    vals.push(v);
  }
  if (vals.length % 4 === 1) return null;
  const out: number[] = [];
  for (let i = 0; i < vals.length; i += 4) {
    const n = (vals[i] << 18) | ((vals[i + 1] ?? 0) << 12) | ((vals[i + 2] ?? 0) << 6) | (vals[i + 3] ?? 0);
    out.push((n >> 16) & 255);
    if (i + 2 < vals.length) out.push((n >> 8) & 255);
    if (i + 3 < vals.length) out.push(n & 255);
  }
  return Uint8Array.from(out);
}

/** The fragment payload for a scene: "v1.<base64url JSON>". Oversized args are
 *  dropped, and if it is still too long, windows are dropped from the end
 *  (minimized ones first) until it fits. `dropped` says how many. */
export function encodeHandoff(scene: Scene): { code: string; dropped: number } {
  const slim = (w: Scene["windows"][number]) => {
    const round = (n: number) => Math.round(n * 1000) / 1000;
    const args = w.args && JSON.stringify(w.args).length <= MAX_ARGS_JSON ? w.args : undefined;
    return { appId: w.appId, ...(w.title ? { title: w.title } : {}), fx: round(w.fx), fy: round(w.fy), fw: round(w.fw), fh: round(w.fh), state: w.state, workspace: w.workspace, ...(w.pinned ? { pinned: true } : {}), ...(args ? { args } : {}) };
  };
  const ordered = [...scene.windows.filter((w) => w.state !== "minimized"), ...scene.windows.filter((w) => w.state === "minimized")];
  let keep = ordered.length;
  for (;;) {
    const payload = { name: scene.name, activeWorkspace: scene.activeWorkspace, windows: ordered.slice(0, keep).map(slim) };
    const code = PREFIX + toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
    if (code.length <= MAX_HANDOFF_CHARS || keep <= 1) return { code, dropped: ordered.length - keep };
    keep -= 1;
  }
}

/** Read a handoff code from a URL fragment ("#handoff=v1...." or the bare
 *  code). Everything that fails says why instead of throwing. */
export function decodeHandoff(fragmentOrCode: string, at: number): { ok: true; scene: Scene } | { ok: false; reason: string } {
  const m = fragmentOrCode.match(/(?:^|[#&])handoff=([^&]+)/);
  const code = decodeURIComponent(m ? m[1] : fragmentOrCode.replace(/^#/, "")).trim();
  if (!code.startsWith(PREFIX)) return { ok: false, reason: "Not a desktop handoff link." };
  if (code.length > MAX_HANDOFF_CHARS * 2) return { ok: false, reason: "Handoff link is too long to be one of ours." };
  const bytes = fromBase64Url(code.slice(PREFIX.length));
  if (!bytes) return { ok: false, reason: "Handoff link is damaged (bad characters)." };
  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "Handoff link is damaged (bad text encoding)." };
  }
  const parsed = parseScene(json, at);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  return { ok: true, scene: { ...parsed.scene, name: parsed.scene.name === "Imported scene" ? "Handed-off desktop" : parsed.scene.name } };
}
