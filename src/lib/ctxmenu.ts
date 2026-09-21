/* ────────────────────────────────────────────────────────────────────────────
   Context menus — the model, the placement, and the keyboard rules.

   Right-clicking anywhere in this OS must produce an OS menu, never the
   browser's. That is a shell concern, but the two things that actually go
   wrong are pure and belong here:

   1. PLACEMENT. A menu opened near the right edge must flip to the left of the
      cursor rather than being clamped against the edge, because clamping puts
      the menu UNDER the pointer and the first item gets activated by the mouse
      release that opened it. Submenus flip independently, and a menu taller
      than the viewport pins to the top and scrolls rather than hanging off.

   2. KEYBOARD. The WAI-ARIA menu pattern is specific: Up/Down move and WRAP,
      Home/End jump, separators and disabled items are skipped, typing jumps to
      the next item starting with what you typed, and Shift+F10 opens a menu
      without a mouse at all. Getting "skip disabled, and wrap" right is fiddly
      enough to deserve tests rather than confidence.

   PURE. No DOM, no React, no clock — sizes and viewport arrive as parameters.
   ──────────────────────────────────────────────────────────────────────────── */

export interface MenuItem {
  id: string;
  label: string;
  /** Right-aligned: a shortcut, or a short note. */
  hint?: string;
  icon?: string;
  /** Destructive, styled accordingly. */
  danger?: boolean;
  disabled?: boolean;
  /** Renders a tick. `false` renders an empty slot so a group stays aligned. */
  checked?: boolean;
  /** Nested items. An item with a submenu does not itself run. */
  submenu?: Entry[];
  run?: () => void;
}

export interface Separator {
  separator: true;
}

export type Entry = MenuItem | Separator;

export const isSeparator = (e: Entry): e is Separator => (e as Separator).separator === true;
export const isItem = (e: Entry): e is MenuItem => !isSeparator(e);

/** A contributed group of entries. Sections are concatenated with a separator
 *  between them, so a contributor never has to know what else is on the menu. */
export interface MenuSection {
  id: string;
  entries: Entry[];
}

/* ── assembling ──────────────────────────────────────────────────────────── */

/**
 * Concatenate sections, dropping empty ones and putting exactly one separator
 * between the survivors.
 *
 * Empty sections are the normal case, not an edge case: "paste" contributes
 * nothing when the clipboard is unreadable, and a section that contributed
 * nothing must not leave a doubled separator behind it.
 */
export function mergeSections(sections: MenuSection[]): Entry[] {
  const live = sections.filter((s) => s.entries.some(isItem));
  const out: Entry[] = [];
  for (let i = 0; i < live.length; i++) {
    if (i > 0) out.push({ separator: true });
    // Leading/trailing separators inside a section are dropped for the same
    // reason: a section is a unit, its edges are the merge's business.
    const trimmed = trimSeparators(live[i].entries);
    out.push(...trimmed);
  }
  return out;
}

function trimSeparators(entries: Entry[]): Entry[] {
  let a = 0;
  let b = entries.length;
  while (a < b && isSeparator(entries[a])) a++;
  while (b > a && isSeparator(entries[b - 1])) b--;
  // Collapse runs in the middle too.
  const out: Entry[] = [];
  for (let i = a; i < b; i++) {
    const e = entries[i];
    if (isSeparator(e) && out.length && isSeparator(out[out.length - 1])) continue;
    out.push(e);
  }
  return out;
}

/* ── placement ───────────────────────────────────────────────────────────── */

export interface Viewport {
  w: number;
  h: number;
}

export interface Placement {
  x: number;
  y: number;
  /** Which way it actually went, so the caller can animate from the right corner. */
  flipX: boolean;
  flipY: boolean;
  /** Height it is allowed to occupy. Less than the menu's natural height means
   *  the menu must scroll internally. */
  maxHeight: number;
}

const MARGIN = 6;

/**
 * Where to put a menu opened at (ax, ay).
 *
 * Flips rather than clamps when it would overflow. Clamping is the tempting
 * fix and it is wrong: a clamped menu sits under the pointer, and on a
 * right-click the button release then lands on whatever item is beneath it.
 */
export function placeMenu(ax: number, ay: number, menuW: number, menuH: number, vp: Viewport): Placement {
  const roomRight = vp.w - ax;
  const roomBelow = vp.h - ay;

  const flipX = roomRight < menuW + MARGIN && ax > roomRight;
  const flipY = roomBelow < menuH + MARGIN && ay > roomBelow;

  let x = flipX ? ax - menuW : ax;
  let y = flipY ? ay - menuH : ay;

  // After flipping it can still overflow the OTHER side on a very small
  // viewport; that is the only case where clamping is correct.
  x = Math.max(MARGIN, Math.min(x, Math.max(MARGIN, vp.w - menuW - MARGIN)));
  y = Math.max(MARGIN, Math.min(y, Math.max(MARGIN, vp.h - menuH - MARGIN)));

  return { x, y, flipX, flipY, maxHeight: Math.max(120, vp.h - 2 * MARGIN) };
}

export interface SubPlacement {
  x: number;
  y: number;
  side: "right" | "left";
  maxHeight: number;
}

/**
 * Where a submenu goes relative to its parent item.
 *
 * Opens to the right of the PARENT MENU (not the item), overlapping by a few
 * pixels so the pointer can travel diagonally without crossing a gap and
 * closing the submenu.
 */
export function placeSubmenu(
  parentX: number,
  parentW: number,
  itemY: number,
  subW: number,
  subH: number,
  vp: Viewport,
): SubPlacement {
  const overlap = 4;
  const rightX = parentX + parentW - overlap;
  const leftX = parentX - subW + overlap;

  const side: "right" | "left" = rightX + subW + MARGIN <= vp.w || leftX < MARGIN ? "right" : "left";
  let x = side === "right" ? rightX : leftX;
  x = Math.max(MARGIN, Math.min(x, Math.max(MARGIN, vp.w - subW - MARGIN)));

  const y = Math.max(MARGIN, Math.min(itemY, Math.max(MARGIN, vp.h - subH - MARGIN)));
  return { x, y, side, maxHeight: Math.max(120, vp.h - 2 * MARGIN) };
}

/* ── keyboard ────────────────────────────────────────────────────────────── */

/** Indices that focus can land on: real items that are not disabled. */
export function focusableIndices(entries: Entry[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (isItem(e) && !e.disabled) out.push(i);
  }
  return out;
}

/**
 * The next focusable index in `dir`, wrapping.
 *
 * Returns -1 only when nothing at all is focusable, which is a menu that
 * should not have opened. `from` may be -1 to mean "nothing focused yet", in
 * which case Down gives the first item and Up gives the last — the ARIA
 * behaviour, and the reason this is not just `current + dir`.
 */
export function moveFocus(entries: Entry[], from: number, dir: 1 | -1): number {
  const f = focusableIndices(entries);
  if (!f.length) return -1;
  if (from < 0) return dir === 1 ? f[0] : f[f.length - 1];
  const at = f.indexOf(from);
  if (at === -1) {
    // Focus was on something that has since become disabled: land on the
    // nearest focusable item in the direction of travel.
    const next = dir === 1 ? f.find((i) => i > from) : [...f].reverse().find((i) => i < from);
    return next ?? (dir === 1 ? f[0] : f[f.length - 1]);
  }
  return f[(at + dir + f.length) % f.length];
}

export const firstFocusable = (entries: Entry[]): number => moveFocus(entries, -1, 1);
export const lastFocusable = (entries: Entry[]): number => moveFocus(entries, -1, -1);

/**
 * ARIA type-ahead: the next item whose label starts with `buffer`, searching
 * from just after `from` and wrapping.
 *
 * Case-insensitive, and searches from AFTER the current item so repeatedly
 * typing "s" cycles through every item starting with s instead of sticking on
 * the first one.
 */
export function typeAhead(entries: Entry[], buffer: string, from: number): number {
  const q = buffer.trim().toLowerCase();
  if (!q) return -1;
  const f = focusableIndices(entries);
  if (!f.length) return -1;
  const start = f.indexOf(from);
  for (let n = 1; n <= f.length; n++) {
    const i = f[(start + n + f.length) % f.length];
    const e = entries[i];
    if (isItem(e) && e.label.toLowerCase().startsWith(q)) return i;
  }
  // A repeated single character is a cycle request, already handled above. A
  // buffer that matches nothing leaves focus alone.
  return -1;
}

/** How long a type-ahead buffer stays alive, per the ARIA practices guide. */
export const TYPEAHEAD_MS = 1000;

/* ── what the right-click was on ─────────────────────────────────────────── */

export type TargetKind = "text" | "input" | "link" | "image" | "media" | "plain";

export interface TargetInfo {
  kind: TargetKind;
  /** Selected text, trimmed and capped for use in a menu label. */
  selection?: string;
  href?: string;
  src?: string;
  editable?: boolean;
}

/** Shorten a selection for "Search the web for …" without cutting mid-word
 *  when it can be helped. */
export function labelFor(selection: string, max = 24): string {
  const s = selection.replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return `${sp > max * 0.6 ? cut.slice(0, sp) : cut}…`;
}
