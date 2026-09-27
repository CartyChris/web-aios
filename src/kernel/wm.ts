"use client";

import { appHeight } from "./viewport";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { resolveOpen } from "@/lib/window-open";
import { tile, zoneRect } from "@/lib/zones";
import type { Notification, WindowInstance, WindowState } from "./types";

/** Where a window lands when dropped against an edge or driven by a keybinding. */
export type SnapZone = "left" | "right" | "top" | "bottom" | "tl" | "tr" | "bl" | "br" | "center" | "max";

export interface WMState {
  windows: WindowInstance[];
  workspaces: number;
  activeWorkspace: number;
  focused: string | null;
  topZ: number;
  notifications: Notification[];
  /** Serialized so a reload lands you back where you were. */
  bootedAt: number;

  open: (appId: string, opts?: OpenOptions) => string;
  close: (id: string) => void;
  closeApp: (appId: string) => void;
  focus: (id: string) => void;
  move: (id: string, x: number, y: number) => void;
  resize: (id: string, w: number, h: number, x?: number, y?: number) => void;
  setState: (id: string, state: WindowState) => void;
  toggleMaximize: (id: string) => void;
  minimize: (id: string) => void;
  restore: (id: string) => void;
  snap: (id: string, zone: SnapZone) => void;
  rename: (id: string, title: string) => void;
  setArgs: (id: string, args: Record<string, unknown>) => void;
  sendToWorkspace: (id: string, workspace: number) => void;
  togglePin: (id: string) => void;
  setWorkspace: (n: number) => void;
  setWorkspaceCount: (n: number) => void;
  cycle: (dir: 1 | -1) => void;
  /** Arrange every live window on this workspace under a named layout
   *  from src/lib/zones.ts. Front window first, so "main + stack" gives the
   *  large pane to whatever you were just using. */
  applyLayout: (layoutId: string) => void;
  /** The layout last applied, so it can be re-run after opening a window. */
  lastLayout: string;
  tileAll: () => void;
  cascadeAll: () => void;
  minimizeAll: () => void;
  closeAll: () => void;

  notify: (n: Omit<Notification, "id" | "ts">) => void;
  dismiss: (id: string) => void;
  markAllRead: () => void;
  clearNotifications: () => void;
}

export interface OpenOptions {
  title?: string;
  icon?: string;
  args?: Record<string, unknown>;
  size?: { w: number; h: number };
  at?: { x: number; y: number };
  /** Focus an existing instance on THIS workspace instead of spawning a
   *  second one beside it. Other workspaces get their own copy. */
  singleton?: boolean;
  /** Open another window even for a singleton app. */
  forceNew?: boolean;
  workspace?: number;
}

const uid = () => `w_${Math.random().toString(36).slice(2, 10)}`;

/** Usable desktop area, excluding the top bar and the dock. */
/** The usable desktop: viewport minus the top bar and the dock strip. One
 *  definition, exported, so layouts and scenes cannot drift from each other. */
export function workArea(): { x: number; y: number; w: number; h: number } {
  const v = viewport();
  return { x: 0, y: v.top, w: v.w, h: v.h - v.top - v.bottom };
}

function viewport() {
  if (typeof window === "undefined") return { w: 1440, h: 900, top: 40, bottom: 76 };
  return { w: window.innerWidth, h: appHeight(), top: 40, bottom: 76 };
}

function clampToViewport(win: WindowInstance): WindowInstance {
  const v = viewport();
  const w = Math.min(win.w, Math.max(320, v.w - 16));
  const h = Math.min(win.h, Math.max(240, v.h - v.top - v.bottom - 8));
  // Keep at least a strip of titlebar reachable so a window can never be
  // dragged somewhere the user cannot grab it again.
  const x = Math.min(Math.max(win.x, -(w - 120)), v.w - 120);
  const y = Math.min(Math.max(win.y, v.top), v.h - 60);
  return { ...win, w, h, x, y };
}

/** Cascade new windows so a burst of launches doesn't stack into one pile. */
function cascadeOffset(count: number) {
  const step = 28;
  const ring = count % 8;
  return { dx: ring * step, dy: ring * step };
}

/** Where a window goes when it is snapped to `zone`.
 *
 *  One geometry for the whole OS: this delegates to zoneRect in
 *  src/lib/zones.ts, the same function drag-to-snap and the layout engine use.
 *  It used to be a second hand-written table here that halved with
 *  Math.floor while zoneRect used Math.round, so on an odd-width screen a half
 *  snapped by dragging and a half snapped from the keyboard or a menu landed a
 *  pixel apart. Now there is one tested implementation. */
export function snapGeometry(zone: SnapZone) {
  return zoneRect(zone, workArea());
}

export const useWM = create<WMState>()(
  persist(
    (set, get) => ({
      windows: [],
      lastLayout: "grid",
      workspaces: 4,
      activeWorkspace: 1,
      focused: null,
      topZ: 10,
      notifications: [],
      bootedAt: Date.now(),

      open: (appId, opts = {}) => {
        const s = get();
        // Singleton is per WORKSPACE, not per OS. See lib/window-open.ts: the
        // old rule matched on appId alone, so opening an app from workspace 3
        // while it sat on workspace 1 teleported you there instead of opening
        // it where you were. Four desktops, three of which could never hold it.
        const decision = resolveOpen({
          appId,
          windows: s.windows,
          activeWorkspace: s.activeWorkspace,
          singleton: opts.singleton,
          forceNew: opts.forceNew,
        });
        if (decision.action === "focus") {
          set({
            focused: decision.windowId,
            topZ: s.topZ + 1,
            windows: s.windows.map((w) =>
              w.id === decision.windowId
                ? { ...w, z: s.topZ + 1, state: w.state === "minimized" ? "normal" : w.state, args: opts.args ?? w.args }
                : w,
            ),
          });
          return decision.windowId;
        }
        const v = viewport();
        const size = opts.size ?? { w: 880, h: 600 };
        const { dx, dy } = cascadeOffset(s.windows.length);
        const base = {
          x: opts.at?.x ?? Math.max(12, Math.floor((v.w - size.w) / 2) - 90 + dx),
          y: opts.at?.y ?? Math.max(v.top + 8, Math.floor((v.h - size.h) / 2) - 40 + dy),
        };
        const id = uid();
        const win = clampToViewport({
          id,
          appId,
          title: opts.title ?? appId,
          icon: opts.icon ?? "▣",
          x: base.x,
          y: base.y,
          w: size.w,
          h: size.h,
          z: s.topZ + 1,
          state: "normal",
          workspace: opts.workspace ?? s.activeWorkspace,
          args: opts.args,
          createdAt: Date.now(),
        });
        set({ windows: [...s.windows, win], focused: id, topZ: s.topZ + 1 });
        return id;
      },

      close: (id) =>
        set((s) => {
          const rest = s.windows.filter((w) => w.id !== id);
          const nextFocus =
            s.focused === id
              ? [...rest]
                  .filter((w) => w.workspace === s.activeWorkspace || w.pinned)
                  .sort((a, b) => b.z - a.z)[0]?.id ?? null
              : s.focused;
          return { windows: rest, focused: nextFocus };
        }),

      closeApp: (appId) => set((s) => ({ windows: s.windows.filter((w) => w.appId !== appId) })),

      focus: (id) =>
        set((s) => {
          if (s.focused === id && s.windows.find((w) => w.id === id)?.z === s.topZ) return s;
          const z = s.topZ + 1;
          return {
            focused: id,
            topZ: z,
            windows: s.windows.map((w) => (w.id === id ? { ...w, z, state: w.state === "minimized" ? "normal" : w.state } : w)),
          };
        }),

      move: (id, x, y) => set((s) => ({ windows: s.windows.map((w) => (w.id === id ? { ...w, x, y } : w)) })),

      resize: (id, w, h, x, y) =>
        set((s) => ({
          windows: s.windows.map((win) =>
            win.id === id ? { ...win, w, h, ...(x !== undefined ? { x } : {}), ...(y !== undefined ? { y } : {}) } : win,
          ),
        })),

      setState: (id, state) => set((s) => ({ windows: s.windows.map((w) => (w.id === id ? { ...w, state } : w)) })),

      toggleMaximize: (id) =>
        set((s) => ({
          windows: s.windows.map((w) => {
            if (w.id !== id) return w;
            if (w.state === "maximized") {
              const r = w.restore ?? { x: 80, y: 60, w: 900, h: 620 };
              return { ...w, state: "normal", ...r, restore: undefined };
            }
            const g = snapGeometry("max");
            return { ...w, state: "maximized", restore: { x: w.x, y: w.y, w: w.w, h: w.h }, ...g };
          }),
        })),

      minimize: (id) => set((s) => ({ windows: s.windows.map((w) => (w.id === id ? { ...w, state: "minimized" } : w)) })),

      restore: (id) => {
        get().focus(id);
        set((s) => ({ windows: s.windows.map((w) => (w.id === id ? { ...w, state: w.state === "minimized" ? "normal" : w.state } : w)) }));
      },

      snap: (id, zone) =>
        set((s) => {
          const g = snapGeometry(zone);
          return {
            windows: s.windows.map((w) =>
              w.id === id
                ? { ...w, ...g, state: zone === "max" ? "maximized" : "normal", restore: w.restore ?? { x: w.x, y: w.y, w: w.w, h: w.h } }
                : w,
            ),
          };
        }),

      rename: (id, title) => set((s) => ({ windows: s.windows.map((w) => (w.id === id ? { ...w, title } : w)) })),

      setArgs: (id, args) => set((s) => ({ windows: s.windows.map((w) => (w.id === id ? { ...w, args: { ...w.args, ...args } } : w)) })),

      sendToWorkspace: (id, workspace) => set((s) => ({ windows: s.windows.map((w) => (w.id === id ? { ...w, workspace } : w)) })),

      togglePin: (id) => set((s) => ({ windows: s.windows.map((w) => (w.id === id ? { ...w, pinned: !w.pinned } : w)) })),

      setWorkspace: (n) => set({ activeWorkspace: n }),

      setWorkspaceCount: (n) =>
        set((s) => ({
          workspaces: Math.max(1, Math.min(9, n)),
          activeWorkspace: Math.min(s.activeWorkspace, Math.max(1, Math.min(9, n))),
          // Windows stranded past the new count come back to the last workspace
          // rather than becoming unreachable.
          windows: s.windows.map((w) => (w.workspace > n ? { ...w, workspace: n } : w)),
        })),

      cycle: (dir) => {
        const s = get();
        const live = s.windows
          .filter((w) => (w.workspace === s.activeWorkspace || w.pinned) && w.state !== "minimized")
          .sort((a, b) => a.createdAt - b.createdAt);
        if (!live.length) return;
        const i = live.findIndex((w) => w.id === s.focused);
        const next = live[(i + dir + live.length) % live.length];
        get().focus(next.id);
      },

      applyLayout: (layoutId) => {
        const s = get();
        // Front first: z descending. "Main + stack" is only useful if the pane
        // you get is the window you were actually looking at.
        const live = s.windows
          .filter((w) => (w.workspace === s.activeWorkspace || w.pinned) && w.state !== "minimized")
          .sort((a, b) => b.z - a.z);
        if (!live.length) return;
        const rects = tile(layoutId, live.length, workArea(), { gap: 8 });
        // A Map, not findIndex inside the map: the old code was quadratic in
        // the window count, and this runs on every layout keystroke.
        const placed = new Map<string, { x: number; y: number; w: number; h: number }>();
        for (let i = 0; i < live.length; i++) placed.set(live[i].id, rects[i]);

        set({
          lastLayout: layoutId,
          windows: s.windows.map((w) => {
            const r = placed.get(w.id);
            return r
              ? { ...w, ...r, state: "normal" as WindowState, restore: w.restore ?? { x: w.x, y: w.y, w: w.w, h: w.h } }
              : w;
          }),
        });
      },

      // Kept as named commands; both now go through the tested geometry, which
      // also fixes the seam the old floor(v.w / cols) left down the right edge.
      tileAll: () => get().applyLayout("grid"),
      cascadeAll: () => get().applyLayout("cascade"),

      minimizeAll: () =>
        set((s) => ({
          windows: s.windows.map((w) => (w.workspace === s.activeWorkspace || w.pinned ? { ...w, state: "minimized" as WindowState } : w)),
        })),

      closeAll: () => set((s) => ({ windows: s.windows.filter((w) => w.workspace !== s.activeWorkspace && !w.pinned), focused: null })),

      notify: (n) =>
        set((s) => ({
          notifications: [{ ...n, id: uid(), ts: Date.now() }, ...s.notifications].slice(0, 80),
        })),

      dismiss: (id) => set((s) => ({ notifications: s.notifications.filter((n) => n.id !== id) })),
      markAllRead: () => set((s) => ({ notifications: s.notifications.map((n) => ({ ...n, read: true })) })),
      clearNotifications: () => set({ notifications: [] }),
    }),
    {
      name: "webaios.wm.v1",
      storage: createJSONStorage(() => localStorage),
      // Notifications are ephemeral; window layout is the thing worth restoring.
      partialize: (s) => ({
        windows: s.windows,
        workspaces: s.workspaces,
        activeWorkspace: s.activeWorkspace,
        topZ: s.topZ,
        focused: s.focused,
      }),
      onRehydrateStorage: () => (state) => {
        // A restored layout from a larger monitor must be pulled back on screen.
        if (state) state.windows = state.windows.map(clampToViewport);
      },
    },
  ),
);
