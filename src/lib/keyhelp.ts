/* ────────────────────────────────────────────────────────────────────────────
   Keyboard help — chord display, conflict detection, and settings search.

   Two actions bound to the same chord means one of them silently never runs,
   so the cheat sheet flags conflicts rather than listing both as if they work.

   PURE. No DOM; the platform is a parameter.
   ──────────────────────────────────────────────────────────────────────────── */

const NAMED: Record<string, string> = {
  up: "Up", down: "Down", left: "Left", right: "Right", space: "Space", enter: "Enter",
  escape: "Esc", esc: "Esc", tab: "Tab", backspace: "Backspace", ",": ",", "`": "`",
};

/** "mod+shift+t" -> ["Cmd", "Shift", "T"] on a Mac, ["Ctrl", "Shift", "T"] elsewhere. */
export function chordKeys(chord: string, isMac: boolean): string[] {
  if (!chord) return [];
  // A literal "+" key is written as a trailing "+" ("mod++").
  const parts = chord.endsWith("++") ? [...chord.slice(0, -2).split("+"), "+"] : chord.split("+");
  return parts.filter(Boolean).map((p) => {
    const k = p.toLowerCase();
    if (k === "mod") return isMac ? "Cmd" : "Ctrl";
    if (k === "ctrl" || k === "control") return "Ctrl";
    if (k === "alt" || k === "option") return isMac ? "Option" : "Alt";
    if (k === "shift") return "Shift";
    if (k === "meta" || k === "cmd") return isMac ? "Cmd" : "Win";
    return NAMED[k] ?? (k.length === 1 ? k.toUpperCase() : k.charAt(0).toUpperCase() + k.slice(1));
  });
}

/** Normalise modifier order so "shift+mod+t" and "mod+shift+t" compare equal. */
export function normalizeChord(chord: string): string {
  const parts = chord.toLowerCase().split("+").filter(Boolean);
  const order = ["mod", "ctrl", "alt", "shift"];
  const mods = parts.filter((p) => order.includes(p)).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const keys = parts.filter((p) => !order.includes(p));
  return [...mods, ...keys].join("+");
}

/** Groups of two or more actions bound to the same chord. */
export function findConflicts(binds: Record<string, string>): Array<{ chord: string; actions: string[] }> {
  const by = new Map<string, string[]>();
  for (const [action, chord] of Object.entries(binds)) {
    if (!chord) continue;
    const k = normalizeChord(chord);
    by.set(k, [...(by.get(k) ?? []), action]);
  }
  return [...by.entries()].filter(([, a]) => a.length > 1).map(([chord, actions]) => ({ chord, actions: actions.sort() }));
}

/** "window.snapLeft" -> "Window: snap left". */
export function actionLabel(action: string): string {
  const [group, ...rest] = action.split(".");
  const words = rest.join(" ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return `${group.charAt(0).toUpperCase()}${group.slice(1)}${words ? `: ${words}` : ""}`;
}

export interface SettingEntry { tab: string; tabLabel: string; label: string; keywords: string }

/**
 * Rank settings for a query: every query word must appear somewhere in the
 * label, keywords or tab name. Label hits outrank keyword hits.
 */
export function searchSettings(index: SettingEntry[], query: string): SettingEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const scored: Array<{ e: SettingEntry; score: number }> = [];
  for (const e of index) {
    const label = e.label.toLowerCase();
    const hay = `${label} ${e.keywords.toLowerCase()} ${e.tabLabel.toLowerCase()}`;
    if (!words.every((w) => hay.includes(w))) continue;
    const score = words.reduce((a, w) => a + (label.startsWith(w) ? 3 : label.includes(w) ? 2 : 1), 0);
    scored.push({ e, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.e.label.localeCompare(b.e.label)).map((x) => x.e);
}

/* ── the cheat sheet ─────────────────────────────────────────────────────── */

export interface FixedShortcut { where: string; keys: string; what: string }

/** Shortcuts that are fixed rather than user-editable, so the cheat sheet is complete. */
export const FIXED_SHORTCUTS: FixedShortcut[] = [
  { where: "Anywhere", keys: "?", what: "Show this cheat sheet (when you are not typing)" },
  { where: "Anywhere", keys: "mod+1", what: "Go to workspace 1 (1 to 9)" },
  { where: "Anywhere", keys: "mod+alt+1", what: "Apply tiling layout 1 (1 to 7)" },
  { where: "Anywhere", keys: "shift+f10", what: "Open the context menu for the focused item (or the Menu key)" },
  { where: "Menus", keys: "up / down / home / end", what: "Move through a context menu; type a letter to jump" },
  { where: "Menus", keys: "escape", what: "Close a menu or dialog" },
  { where: "Terminal", keys: "up / down", what: "Walk command history (kept across reloads)" },
  { where: "Terminal", keys: "tab", what: "Complete a command or a file path" },
  { where: "Terminal", keys: "ctrl+l", what: "Clear the screen" },
  { where: "Calculator", keys: "enter / =", what: "Evaluate and add to history" },
  { where: "Calculator", keys: "escape", what: "Clear the expression" },
  { where: "Tasks", keys: "enter", what: "Quick add: \"tomorrow 3pm call Sam !high\"" },
  { where: "Settings", keys: "?", what: "Open this cheat sheet" },
];

export interface SheetRow { id: string; label: string; chord: string; conflict: boolean; editable: boolean }

/**
 * Every shortcut in two sections, filtered by a search. Editable bindings come
 * from settings (so the sheet can never disagree with what the keyboard does)
 * and a binding shared with another action is flagged, because one of the two
 * silently never runs. A query matches the label, the place, or the keys as
 * displayed ("cmd shift t" finds mod+shift+t on a Mac).
 */
export function sheetRows(binds: Record<string, string>, fixed: FixedShortcut[], query: string, isMac: boolean): { shell: SheetRow[]; apps: SheetRow[] } {
  const conflicted = new Set(findConflicts(binds).flatMap((c) => c.actions));
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (hay: string) => words.every((w) => hay.includes(w));
  const keysText = (chord: string) => chord.split(" / ").map((c) => chordKeys(c, isMac).join(" ")).join(" ").toLowerCase();
  const shell = Object.entries(binds)
    .filter(([, chord]) => !!chord)
    .map(([action, chord]) => ({ id: action, label: actionLabel(action), chord, conflict: conflicted.has(action), editable: true }))
    .filter((r) => hit(`${r.label.toLowerCase()} ${r.id.toLowerCase()} ${keysText(r.chord)}`));
  const apps = fixed
    .map((f) => ({ id: `${f.where}:${f.keys}`, label: `${f.where}: ${f.what}`, chord: f.keys, conflict: false, editable: false }))
    .filter((r) => hit(`${r.label.toLowerCase()} ${keysText(r.chord)}`));
  return { shell, apps };
}
