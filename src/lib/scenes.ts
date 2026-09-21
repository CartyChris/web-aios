/* ────────────────────────────────────────────────────────────────────────────
   Scenes — a named desktop arrangement you can come back to.

   "Open the four things I use for research, where I like them, on the desktop
   I like them on." A scene stores what was open and where, across every
   workspace, and restoring it puts that back.

   Two things make this harder than a JSON dump, and both live here because
   both are pure:

   1. A scene is restored on a DIFFERENT SCREEN from the one that captured it.
      A window at x:1600 on a 2560px display must not land off the edge of a
      1440px laptop. Geometry is stored in fractions of the work area, so a
      scene is resolution-independent by construction rather than by clamping
      after the fact — clamping preserves size and loses position, which is
      what makes restored layouts feel shuffled.

   2. An app in a scene may no longer exist. Restoring must place everything it
      still can and say plainly what it could not, rather than failing whole.
   ──────────────────────────────────────────────────────────────────────────── */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type WorkArea = Rect;

/** A window inside a scene. Geometry is FRACTIONAL: 0..1 of the work area. */
export interface SceneWindow {
  appId: string;
  title?: string;
  /** Fraction of work-area width/height. */
  fx: number;
  fy: number;
  fw: number;
  fh: number;
  state: "normal" | "maximized" | "minimized";
  workspace: number;
  pinned?: boolean;
  args?: Record<string, unknown>;
}

export interface Scene {
  id: string;
  name: string;
  at: number;
  activeWorkspace: number;
  windows: SceneWindow[];
}

/** The subset of a live window a scene needs. Keeps this module independent of
 *  the WindowInstance type, which carries z, ids and timestamps it must not
 *  store — a scene is a shape, not a snapshot of runtime bookkeeping. */
export interface LiveWindow {
  appId: string;
  title?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  state: string;
  workspace: number;
  pinned?: boolean;
  args?: Record<string, unknown>;
}

export const MAX_SCENE_WINDOWS = 40;

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
const finite = (n: unknown, d = 0) => (typeof n === "number" && Number.isFinite(n) ? n : d);

/* ── capture ─────────────────────────────────────────────────────────────── */

/**
 * Turn the live windows into a scene.
 *
 * `at` is a parameter rather than Date.now() so a captured scene is
 * reproducible in a test.
 */
export function captureScene(
  name: string,
  windows: LiveWindow[],
  activeWorkspace: number,
  area: WorkArea,
  at: number,
  id?: string,
): Scene {
  // Guard against a zero-sized area (a hidden pane, a headless render): every
  // fraction would become Infinity and the scene would be unusable forever.
  const aw = area.w > 0 ? area.w : 1;
  const ah = area.h > 0 ? area.h : 1;

  return {
    id: id ?? `sc_${at.toString(36)}`,
    name: name.trim().slice(0, 60) || "Untitled scene",
    at,
    activeWorkspace,
    windows: windows.slice(0, MAX_SCENE_WINDOWS).map((w) => ({
      appId: w.appId,
      title: w.title?.slice(0, 80),
      fx: clamp01((w.x - area.x) / aw),
      fy: clamp01((w.y - area.y) / ah),
      // Size is clamped to 1 but not to the remaining space: a window may
      // legitimately hang off the right edge, and restoring it there is more
      // faithful than quietly shrinking it.
      fw: clamp01(w.w / aw),
      fh: clamp01(w.h / ah),
      state: w.state === "maximized" ? "maximized" : w.state === "minimized" ? "minimized" : "normal",
      workspace: w.workspace,
      ...(w.pinned ? { pinned: true } : {}),
      ...(w.args && Object.keys(w.args).length ? { args: w.args } : {}),
    })),
  };
}

/* ── restore ─────────────────────────────────────────────────────────────── */

export interface PlacedWindow extends Rect {
  appId: string;
  title?: string;
  state: "normal" | "maximized" | "minimized";
  workspace: number;
  pinned?: boolean;
  args?: Record<string, unknown>;
}

export interface RestorePlan {
  open: PlacedWindow[];
  /** App ids in the scene that the registry no longer has. */
  missing: string[];
  activeWorkspace: number;
}

/** Smallest window a restore is allowed to produce. A scene captured with a
 *  tiny palette window should not become a 12px sliver on a phone. */
const MIN_W = 240;
const MIN_H = 160;

/**
 * Resolve a scene against the CURRENT work area and the apps that still exist.
 *
 * `known` decides whether an appId is still installed. Anything it rejects is
 * reported in `missing` instead of being opened, so a scene made before an app
 * was removed still restores everything else.
 */
export function planRestore(scene: Scene, area: WorkArea, known: (appId: string) => boolean): RestorePlan {
  const open: PlacedWindow[] = [];
  const missing: string[] = [];

  for (const s of scene.windows) {
    if (!known(s.appId)) {
      if (!missing.includes(s.appId)) missing.push(s.appId);
      continue;
    }
    // Size first, then position, then push back inside. Doing it in this order
    // means a window that would overhang is MOVED rather than shrunk, which is
    // what keeps a restored arrangement recognisable.
    const w = Math.max(MIN_W, Math.min(Math.round(s.fw * area.w), area.w));
    const h = Math.max(MIN_H, Math.min(Math.round(s.fh * area.h), area.h));
    const x = Math.min(Math.max(area.x, area.x + Math.round(s.fx * area.w)), area.x + area.w - w);
    const y = Math.min(Math.max(area.y, area.y + Math.round(s.fy * area.h)), area.y + area.h - h);

    open.push({
      appId: s.appId, title: s.title, x, y, w, h,
      state: s.state, workspace: s.workspace,
      ...(s.pinned ? { pinned: true } : {}),
      ...(s.args ? { args: s.args } : {}),
    });
  }

  return { open, missing, activeWorkspace: scene.activeWorkspace };
}

/* ── import / export ─────────────────────────────────────────────────────── */

const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Validate a scene that came from outside — a file, a paste, another
 *  machine. Everything is re-derived; nothing is trusted. */
export function parseScene(json: string, at: number): { ok: true; scene: Scene } | { ok: false; reason: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return { ok: false, reason: `Not valid JSON: ${e instanceof Error ? e.message : "unknown"}` };
  }
  if (!isRec(raw)) return { ok: false, reason: "Not an object." };
  if (!Array.isArray(raw.windows)) return { ok: false, reason: "No windows array." };

  const windows: SceneWindow[] = [];
  for (const w of raw.windows.slice(0, MAX_SCENE_WINDOWS)) {
    if (!isRec(w) || typeof w.appId !== "string" || !w.appId.trim()) continue;
    const state = w.state === "maximized" || w.state === "minimized" ? w.state : "normal";
    windows.push({
      appId: w.appId.trim().slice(0, 40),
      title: typeof w.title === "string" ? w.title.slice(0, 80) : undefined,
      fx: clamp01(finite(w.fx)),
      fy: clamp01(finite(w.fy)),
      // A zero-width window would be invisible and unrecoverable, so an absent
      // or nonsense size falls back to a usable default rather than to zero.
      fw: clamp01(finite(w.fw, 0.5)) || 0.5,
      fh: clamp01(finite(w.fh, 0.5)) || 0.5,
      state,
      workspace: Math.max(1, Math.min(8, Math.round(finite(w.workspace, 1)))),
      ...(w.pinned === true ? { pinned: true } : {}),
      ...(isRec(w.args) ? { args: w.args } : {}),
    });
  }
  if (!windows.length) return { ok: false, reason: "No usable windows in that scene." };

  return {
    ok: true,
    scene: {
      id: typeof raw.id === "string" && raw.id ? raw.id.slice(0, 40) : `sc_${at.toString(36)}`,
      name: (typeof raw.name === "string" ? raw.name.trim().slice(0, 60) : "") || "Imported scene",
      at,
      activeWorkspace: Math.max(1, Math.min(8, Math.round(finite(raw.activeWorkspace, 1)))),
      windows,
    },
  };
}

export const sceneToJson = (s: Scene): string => JSON.stringify(s, null, 2);

/** One line for the scene list: "4 windows across 2 desktops". */
export function describeScene(s: Scene): string {
  const n = s.windows.length;
  const desks = new Set(s.windows.map((w) => w.workspace)).size;
  return `${n} window${n === 1 ? "" : "s"}${desks > 1 ? ` across ${desks} desktops` : ""}`;
}
