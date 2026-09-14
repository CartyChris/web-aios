"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
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
  /** Focus an existing instance instead of spawning a second one. */
  singleton?: boolean;
  workspace?: number;
}

const uid = () => `w_${Math.random().toString(36).slice(2, 10)}`;

/** Usable desktop area, excluding the top bar and the dock. */
function viewport() {
  if (typeof window === "undefined") return { w: 1440, h: 900, top: 40, bottom: 76 };
  return { w: window.innerWidth, h: window.innerHeight, top: 40, bottom: 76 };
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

export function snapGeometry(zone: SnapZone) {
  const v = viewport();
  const availH = v.h - v.top - v.bottom;
  const halfW = Math.floor(v.w / 2);
  const halfH = Math.floor(availH / 2);
  const T = v.top;
  const map: Record<SnapZone, { x: number; y: number; w: number; h: number }> = {
    left: { x: 0, y: T, w: halfW, h: availH },
    right: { x: halfW, y: T, w: v.w - halfW, h: availH },
    top: { x: 0, y: T, w: v.w, h: halfH },
    bottom: { x: 0, y: T + halfH, w: v.w, h: availH - halfH },
    tl: { x: 0, y: T, w: halfW, h: halfH },
    tr: { x: halfW, y: T, w: v.w - halfW, h: halfH },
    bl: { x: 0, y: T + halfH, w: halfW, h: availH - halfH },
    br: { x: halfW, y: T + halfH, w: v.w - halfW, h: availH - halfH },
    center: {
      x: Math.floor(v.w * 0.15),
      y: T + Math.floor(availH * 0.08),
      w: Math.floor(v.w * 0.7),
      h: Math.floor(availH * 0.84),
    },
    max: { x: 0, y: T, w: v.w, h: availH },
  };
  return map[zone];
}

export const useWM = create<WMState>()(
  persist(
    (set, get) => ({
      windows: [],
      workspaces: 4,
      activeWorkspace: 1,
      focused: null,
      topZ: 10,
      notifications: [],
      bootedAt: Date.now(),

      open: (appId, opts = {}) => {
        const s = get();
        if (opts.singleton) {
          const existing = s.windows.find((w) => w.appId === appId);
          if (existing) {
            set({
              activeWorkspace: existing.pinned ? s.activeWorkspace : existing.workspace,
              focused: existing.id,
              topZ: s.topZ + 1,
              windows: s.windows.map((w) =>
                w.id === existing.id
                  ? { ...w, z: s.topZ + 1, state: w.state === "minimized" ? "normal" : w.state, args: opts.args ?? w.args }
                  : w,
              ),
            });
            return existing.id;
          }
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

      tileAll: () => {
        const s = get();
        const live = s.windows.filter((w) => (w.workspace === s.activeWorkspace || w.pinned) && w.state !== "minimized");
        if (!live.length) return;
        const v = viewport();
        const availH = v.h - v.top - v.bottom;
        const cols = Math.ceil(Math.sqrt(live.length));
        const rows = Math.ceil(live.length / cols);
        const cw = Math.floor(v.w / cols);
        const ch = Math.floor(availH / rows);
        set({
          windows: s.windows.map((w) => {
            const i = live.findIndex((l) => l.id === w.id);
            if (i === -1) return w;
            return {
              ...w,
              x: (i % cols) * cw,
              y: v.top + Math.floor(i / cols) * ch,
              w: cw,
              h: ch,
              state: "normal" as WindowState,
            };
          }),
        });
      },

      cascadeAll: () => {
        const s = get();
        const live = s.windows.filter((w) => (w.workspace === s.activeWorkspace || w.pinned) && w.state !== "minimized");
        const v = viewport();
        set({
          windows: s.windows.map((w) => {
            const i = live.findIndex((l) => l.id === w.id);
            if (i === -1) return w;
            return {
              ...w,
              x: 40 + i * 30,
              y: v.top + 20 + i * 30,
              w: Math.min(900, v.w - 120),
              h: Math.min(620, v.h - v.top - v.bottom - 60),
              state: "normal" as WindowState,
            };
          }),
        });
      },

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
