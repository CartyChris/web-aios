"use client";

import { useSettings } from "@/kernel/settings";
import { useWM } from "@/kernel/wm";
import { useVFS } from "@/kernel/vfs";
import { useUserApps } from "@/kernel/userapps";
import { useCustomWidgets } from "@/kernel/widgets";
import { useTriggers } from "@/kernel/triggers";
import { APPS, getApp } from "@/kernel/registry";
import { bus } from "@/kernel/bus";
import { useMcp } from "./mcp";
import { useEggs } from "./easter";
import { ask } from "./useAI";
import { PROVIDERS } from "./providers";

/* ────────────────────────────────────────────────────────────────────────────
   window.__aios — the external control surface.

   Borrowed from GlassBox, which exports ~1,100 symbols on `window.__gb`, for
   the reason that project learned the hard way: a module's internals are
   invisible from outside. Browser automation, an extension, a preview tool or
   a person in the devtools console cannot reach a closure. Without a surface
   like this, "verify the app works" degenerates into poking at the DOM and
   reading localStorage and hoping the shape has not changed — which is exactly
   how this codebase was being tested until now.

   One thing GlassBox has to do by hand, this does not. Over there, a top-level
   `let` exported as a plain property captures the value at export time and
   goes stale the moment the variable is reassigned; their fix is a
   getter/setter pair per mutable binding, and forgetting one is a documented
   recurring bug. Here every store is a zustand handle — a stable reference
   whose `getState()` always reads current. The staleness class cannot occur,
   so the surface exposes stores rather than snapshots. The snapshot helpers
   below are explicitly point-in-time and say so.

   This is a convenience and a test seam, not a security boundary: anything on
   `window` is reachable by anything running on the page. It exposes no
   secrets — `settings.keys` is deliberately redacted by `snapshot()`.
   ──────────────────────────────────────────────────────────────────────────── */

export interface AiosApi {
  version: string;
  /** Live zustand handles. Call `.getState()` for current values. */
  stores: Record<string, { getState: () => unknown }>;
  /** Registry, bus and the model transport. */
  apps: typeof APPS;
  getApp: typeof getApp;
  bus: typeof bus;
  ask: typeof ask;
  providers: typeof PROVIDERS;
  /** Open an app by id. Returns the window id, or null if there is no such app. */
  open: (appId: string, args?: Record<string, unknown>) => string | null;
  close: (windowId: string) => void;
  /** Everything the OS currently holds, minus credentials. Point-in-time. */
  snapshot: () => Record<string, unknown>;
  /** Wait for a predicate to hold. Rejects on timeout — a test that hangs
   *  forever is worse than one that fails. */
  waitFor: (predicate: () => boolean, opts?: { timeout?: number; label?: string }) => Promise<void>;
  /** Registered by the harness kernel once it loads; absent until then. */
  harness?: unknown;
}

declare global {
  interface Window { __aios?: AiosApi }
}

const STORES = {
  settings: useSettings,
  wm: useWM,
  vfs: useVFS,
  userApps: useUserApps,
  widgets: useCustomWidgets,
  mcp: useMcp,
  eggs: useEggs,
  triggers: useTriggers,
} as const;

function snapshot(): Record<string, unknown> {
  const s = useSettings.getState();
  const wm = useWM.getState();
  const vfs = useVFS.getState();
  return {
    // Keys are redacted rather than omitted: a caller checking whether a
    // provider is configured should be able to, without the value leaking into
    // a log, a screenshot or a bug report.
    settings: {
      ...s,
      ai: { ...s.ai, keys: Object.fromEntries(Object.keys(s.ai.keys).map((k) => [k, "<redacted>"])) },
    },
    windows: wm.windows.map((w) => ({ id: w.id, appId: w.appId, title: w.title, state: w.state, workspace: w.workspace })),
    activeWorkspace: wm.activeWorkspace,
    notifications: wm.notifications.length,
    files: vfs.usage(),
    userApps: useUserApps.getState().apps.map((a) => ({ id: a.id, name: a.name, kind: a.kind, files: a.files?.length ?? 0 })),
    // Layer 1 at a glance. `armed` is the one field worth seeing without
    // opening the app: a disarmed OS starts no runs and spends nothing.
    triggers: (() => {
      const t = useTriggers.getState();
      return {
        armed: t.armed,
        count: t.triggers.length,
        neverFired: t.triggers.filter((x) => x.firedCount === 0).map((x) => x.id),
        attempts: t.attempts.length,
      };
    })(),
    apps: APPS.map((a) => a.id),
  };
}

function waitFor(predicate: () => boolean, opts: { timeout?: number; label?: string } = {}): Promise<void> {
  const timeout = opts.timeout ?? 8000;
  return new Promise((resolve, reject) => {
    if (predicate()) return resolve();
    const started = performance.now();
    const tick = () => {
      let ok = false;
      try { ok = predicate(); } catch { ok = false; }
      if (ok) return resolve();
      if (performance.now() - started > timeout) {
        return reject(new Error(`waitFor timed out after ${timeout}ms${opts.label ? `: ${opts.label}` : ""}`));
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** Install the surface. Idempotent — safe to call on every mount. */
export function installAiosApi(version = "3.0.0") {
  if (typeof window === "undefined") return;
  const existing = window.__aios;
  const api: AiosApi = {
    version,
    stores: STORES as unknown as AiosApi["stores"],
    apps: APPS,
    getApp,
    bus,
    ask,
    providers: PROVIDERS,
    open: (appId, args) => {
      const app = getApp(appId);
      if (!app) return null;
      return useWM.getState().open(app.id, {
        title: app.name, icon: app.icon, size: app.defaultSize, singleton: app.singleton, args,
      });
    },
    close: (windowId) => useWM.getState().close(windowId),
    snapshot,
    waitFor,
    // Anything already registered by a module that loaded first — notably the
    // harness — survives a re-install.
    ...(existing?.harness ? { harness: existing.harness } : {}),
  };
  window.__aios = api;
}

/** Attach a named sub-API. Used by the harness kernel, which loads later than
 *  the shell and must not clobber what is already there. */
export function registerAiosModule<K extends string>(name: K, value: unknown) {
  if (typeof window === "undefined") return;
  if (!window.__aios) installAiosApi();
  (window.__aios as unknown as Record<string, unknown>)[name] = value;
}
