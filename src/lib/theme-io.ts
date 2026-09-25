/* ────────────────────────────────────────────────────────────────────────────
   Themes as portable JSON files.

   PURE. Import is a trust boundary exactly like a model's system update: a
   file from anywhere reaches the OS palette through here, so it goes through
   the same validateTheme (hex colours only, every token present, contrast
   gates passed). An unreadable theme is refused with the reason, never
   applied and never "fixed" silently.
   ──────────────────────────────────────────────────────────────────────────── */

import { validateTheme, type ProposedTheme } from "./sysupdate";

export const THEME_FORMAT = "web-aios-theme";
export const MAX_THEME_BYTES = 64 * 1024;

export function exportTheme(theme: ProposedTheme): string {
  return JSON.stringify({ format: THEME_FORMAT, version: 1, theme: { id: theme.id, name: theme.name, dark: theme.dark, vars: theme.vars } }, null, 2) + "\n";
}

/** A fresh id when this one is taken — by a built-in, which can never be
 *  shadowed, or by a theme already installed. */
export function uniqueId(id: string, taken: readonly string[]): string {
  const set = new Set(taken);
  if (!set.has(id)) return id;
  for (let n = 2; n < 1000; n++) {
    const next = `${id}-${n}`;
    if (!set.has(next)) return next;
  }
  return `${id}-${taken.length + 1}`;
}

export type ImportResult = { ok: true; theme: ProposedTheme; renamed: boolean } | { ok: false; error: string };

export function importTheme(text: string, takenIds: readonly string[]): ImportResult {
  if (text.length > MAX_THEME_BYTES) return { ok: false, error: `File is ${Math.round(text.length / 1024)} KB; a theme is under 64 KB.` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Not JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false, error: "Not a theme file." };
  const rec = parsed as Record<string, unknown>;
  if (rec.format !== undefined && rec.format !== THEME_FORMAT) return { ok: false, error: `Unknown format "${String(rec.format)}".` };
  // Accept our wrapper, or a bare {name, vars} object.
  const candidate = rec.theme ?? rec;
  const v = validateTheme(candidate);
  if (!v.ok) return { ok: false, error: `Rejected: ${v.reason}` };
  const id = uniqueId(v.theme.id, takenIds);
  return { ok: true, theme: { ...v.theme, id }, renamed: id !== v.theme.id };
}
