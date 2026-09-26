/* ────────────────────────────────────────────────────────────────────────────
   Zones — tiling layouts for the window manager.

   Pure geometry. Given a layout, a window count and a work area, produce the
   rectangles. The window manager then assigns them to real windows in z-order,
   which is the only part that needs a store.

   The thing that makes tiling look cheap or expensive is the SEAMS. Compute
   each column as `round(i * w / n)` and the widths drift: three columns of a
   1000px area come out 333/333/333 and leave a pixel of wallpaper showing down
   the right-hand edge. Every layout here is built from cumulative EDGES
   instead — edge(i) = origin + round(i * span / n) — so slot i's right edge is
   by construction slot i+1's left edge, the last edge lands exactly on the far
   side, and the error can never accumulate. Gaps are then carved out of the
   inside of each slot, which keeps that property regardless of gap size.
   ──────────────────────────────────────────────────────────────────────────── */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The usable desktop: viewport minus the top bar and whatever the dock takes. */
export type WorkArea = Rect;

export interface TileOptions {
  /** Space between tiles, and between a tile and the screen edge. */
  gap?: number;
  /** Smallest tile this layout is allowed to produce. Below it, the layout
   *  falls back to fewer slots and the remaining windows share the last one. */
  minW?: number;
  minH?: number;
}

export interface LayoutDef {
  id: string;
  name: string;
  /** One line, shown in the palette and the layout menu. */
  hint: string;
  /** How many windows this layout is meaningfully different for. Used to keep
   *  the menu honest: "Halves" with one window is just "Maximize". */
  bestFor: number;
}

export const LAYOUTS: readonly LayoutDef[] = [
  { id: "cols", name: "Columns", hint: "Equal columns, left to right", bestFor: 2 },
  { id: "rows", name: "Rows", hint: "Equal rows, top to bottom", bestFor: 2 },
  { id: "grid", name: "Grid", hint: "As square as the count allows", bestFor: 4 },
  { id: "main-left", name: "Main + stack", hint: "One large pane, the rest stacked beside it", bestFor: 3 },
  { id: "main-right", name: "Stack + main", hint: "Stack on the left, large pane on the right", bestFor: 3 },
  { id: "focus", name: "Focus", hint: "Front window centred, others tucked behind", bestFor: 1 },
  { id: "cascade", name: "Cascade", hint: "Staggered, every titlebar reachable", bestFor: 3 },
] as const;

export const isLayout = (id: string): boolean => LAYOUTS.some((l) => l.id === id);

/* ── edges ───────────────────────────────────────────────────────────────── */

/** n+1 cumulative edges across `span`, starting at `origin`.
 *
 *  edges[0] === origin and edges[n] === origin + span EXACTLY, for every n and
 *  span, including spans that do not divide. That identity is what removes the
 *  seam: no slot is computed from a width, only from the difference of two
 *  edges, so widths absorb the remainder instead of dropping it. */
export function edges(origin: number, span: number, n: number): number[] {
  const out = new Array<number>(n + 1);
  for (let i = 0; i <= n; i++) out[i] = origin + Math.round((span * i) / n);
  return out;
}

/** Shrink a slot by the gap. Done once, at the end, so the edge identity above
 *  is never disturbed by gap arithmetic. */
const inset = (r: Rect, gap: number): Rect =>
  gap <= 0 ? r : { x: r.x + gap, y: r.y + gap, w: Math.max(1, r.w - gap * 2), h: Math.max(1, r.h - gap * 2) };

/* ── the layouts ─────────────────────────────────────────────────────────── */

/** How many columns a grid of `n` wants: as square as possible, wider than
 *  tall, because screens are. */
export function gridCols(n: number): number {
  return n <= 1 ? 1 : Math.ceil(Math.sqrt(n));
}

/**
 * Rectangles for `count` windows under `layout`, inside `area`.
 *
 * Returns exactly `count` rects, in the order the caller should assign them
 * (front window first). An unknown layout id falls back to "grid" rather than
 * throwing: a layout is a preference, and losing one should never cost the
 * user their arrangement.
 */
export function tile(layout: string, count: number, area: WorkArea, opts: TileOptions = {}): Rect[] {
  if (count <= 0) return [];
  const gap = Math.max(0, Math.round(opts.gap ?? 8));
  const minW = opts.minW ?? 240;
  const minH = opts.minH ?? 160;

  // Half a gap of slack: a slot is inset by `gap` on each side, so a column
  // narrower than minW + 2*gap cannot host a usable window.
  const fitsCols = Math.max(1, Math.min(count, Math.floor((area.w + gap) / (minW + gap))));
  const fitsRows = Math.max(1, Math.min(count, Math.floor((area.h + gap) / (minH + gap))));

  switch (layout) {
    case "cols": return bands(area, Math.min(count, fitsCols), count, gap, "x");
    case "rows": return bands(area, Math.min(count, fitsRows), count, gap, "y");
    case "main-left": return mainStack(area, count, gap, false, minH);
    case "main-right": return mainStack(area, count, gap, true, minH);
    case "focus": return focus(area, count, gap);
    case "cascade": return cascade(area, count, gap);
    case "grid":
    default: return grid(area, count, gap, fitsCols, fitsRows);
  }
}

/** Equal bands along one axis. When more windows than bands fit, the surplus
 *  all share the LAST band (stacked exactly on top of each other), which is
 *  honest: the alternative is silently producing unusable 90px slivers. */
function bands(area: WorkArea, n: number, count: number, gap: number, axis: "x" | "y"): Rect[] {
  const horizontal = axis === "x";
  const e = edges(horizontal ? area.x : area.y, horizontal ? area.w : area.h, n);
  const out: Rect[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const slot = Math.min(i, n - 1);
    out[i] = inset(
      horizontal
        ? { x: e[slot], y: area.y, w: e[slot + 1] - e[slot], h: area.h }
        : { x: area.x, y: e[slot], w: area.w, h: e[slot + 1] - e[slot] },
      gap,
    );
  }
  return out;
}

function grid(area: WorkArea, count: number, gap: number, fitsCols: number, fitsRows: number): Rect[] {
  const cols = Math.max(1, Math.min(gridCols(count), fitsCols));
  const rows = Math.max(1, Math.min(Math.ceil(count / cols), fitsRows));
  const cap = cols * rows;
  const ex = edges(area.x, area.w, cols);
  const ey = edges(area.y, area.h, rows);
  const out: Rect[] = new Array(count);
  for (let i = 0; i < count; i++) {
    // Surplus windows share the final cell rather than shrinking every cell.
    const slot = Math.min(i, cap - 1);
    const c = slot % cols;
    const r = (slot / cols) | 0;
    out[i] = inset({ x: ex[c], y: ey[r], w: ex[c + 1] - ex[c], h: ey[r + 1] - ey[r] }, gap);
  }
  return out;
}

/** One pane taking 60% of the width, the rest sharing the other side. */
function mainStack(area: WorkArea, count: number, gap: number, mainOnRight: boolean, minH: number): Rect[] {
  if (count === 1) return [inset(area, gap)];
  const split = area.x + Math.round(area.w * 0.6);
  const mainX = mainOnRight ? area.x + (area.w - (split - area.x)) : area.x;
  const mainW = split - area.x;
  const sideX = mainOnRight ? area.x : split;
  const sideW = area.w - mainW;

  const stackCount = count - 1;
  const fits = Math.max(1, Math.min(stackCount, Math.floor((area.h + gap) / (minH + gap))));
  const ey = edges(area.y, area.h, fits);

  const out: Rect[] = new Array(count);
  out[0] = inset({ x: mainX, y: area.y, w: mainW, h: area.h }, gap);
  for (let i = 1; i < count; i++) {
    const slot = Math.min(i - 1, fits - 1);
    out[i] = inset({ x: sideX, y: ey[slot], w: sideW, h: ey[slot + 1] - ey[slot] }, gap);
  }
  return out;
}

/** The front window large and centred; everything else the same size directly
 *  behind it, offset just enough that their edges show. */
function focus(area: WorkArea, count: number, gap: number): Rect[] {
  const w = Math.round(area.w * 0.72);
  const h = Math.round(area.h * 0.82);
  const x = area.x + ((area.w - w) >> 1);
  const y = area.y + ((area.h - h) >> 1);
  const out: Rect[] = new Array(count);
  out[0] = { x, y, w, h };
  for (let i = 1; i < count; i++) {
    const k = Math.min(i, 6);
    out[i] = { x: x + k * gap, y: y + k * gap, w, h };
  }
  return out;
}

/** Staggered so every titlebar is clickable. The stagger wraps before it can
 *  push a window off the bottom, which is the failure mode of every naive
 *  cascade. */
function cascade(area: WorkArea, count: number, gap: number): Rect[] {
  const step = Math.max(24, gap * 3);
  const w = Math.round(area.w * 0.62);
  const h = Math.round(area.h * 0.68);
  const maxSteps = Math.max(1, Math.floor(Math.min((area.w - w) / step, (area.h - h) / step)));
  const out: Rect[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const k = i % (maxSteps + 1);
    out[i] = { x: area.x + k * step, y: area.y + k * step, w, h };
  }
  return out;
}

/* ── drag-to-zone ────────────────────────────────────────────────────────── */

export type ZoneId = "left" | "right" | "top" | "bottom" | "tl" | "tr" | "bl" | "br" | "center" | "max";

export interface ZoneHit {
  zone: ZoneId;
  rect: Rect;
}

/**
 * Which zone a pointer at (px, py) is asking for, or null.
 *
 * Corners are tested before edges, because a corner IS in both edge bands and
 * testing edges first would make the corners unreachable — the bug that makes
 * most home-grown snapping feel like it ignores you.
 */
export function zoneAt(px: number, py: number, area: WorkArea, threshold = 24): ZoneHit | null {
  const nearL = px <= area.x + threshold;
  const nearR = px >= area.x + area.w - threshold;
  const nearT = py <= area.y + threshold;
  const nearB = py >= area.y + area.h - threshold;
  if (!nearL && !nearR && !nearT && !nearB) return null;

  const zone: ZoneId =
    nearT && nearL ? "tl"
    : nearT && nearR ? "tr"
    : nearB && nearL ? "bl"
    : nearB && nearR ? "br"
    : nearT ? "max"
    : nearB ? "bottom"
    : nearL ? "left"
    : "right";
  return { zone, rect: zoneRect(zone, area) };
}

/** The rectangle a zone corresponds to. Halves use the same cumulative-edge
 *  rule as the layouts, so a left half and a right half meet exactly. */
export function zoneRect(zone: ZoneId, area: WorkArea): Rect {
  const mx = area.x + Math.round(area.w / 2);
  const my = area.y + Math.round(area.h / 2);
  const rightW = area.x + area.w - mx;
  const bottomH = area.y + area.h - my;
  switch (zone) {
    case "left": return { x: area.x, y: area.y, w: mx - area.x, h: area.h };
    case "right": return { x: mx, y: area.y, w: rightW, h: area.h };
    case "top": return { x: area.x, y: area.y, w: area.w, h: my - area.y };
    case "bottom": return { x: area.x, y: my, w: area.w, h: bottomH };
    case "tl": return { x: area.x, y: area.y, w: mx - area.x, h: my - area.y };
    case "tr": return { x: mx, y: area.y, w: rightW, h: my - area.y };
    case "bl": return { x: area.x, y: my, w: mx - area.x, h: bottomH };
    case "br": return { x: mx, y: my, w: rightW, h: bottomH };
    // A comfortable centred window, not a half: 70% by 84%, set a little high
    // so the titlebar is where the eye already is. zoneAt never returns it —
    // it is reached from the keyboard and menus, not by dragging to an edge.
    case "center": return {
      x: area.x + Math.floor(area.w * 0.15),
      y: area.y + Math.floor(area.h * 0.08),
      w: Math.floor(area.w * 0.7),
      h: Math.floor(area.h * 0.84),
    };
    case "max": default: return { ...area };
  }
}
