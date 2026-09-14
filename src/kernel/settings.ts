"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { THEMES, FONT_STACKS, type Theme, type WallpaperId } from "./themes";
import { PROFILES, getProfile } from "./profiles";

export interface Settings {
  // ── Appearance ──────────────────────────────────────────────────────────
  /** The selected OS personality. A profile seeds theme + layout + chrome in
   *  one move; every field it sets stays individually overridable afterwards. */
  profileId: string;
  themeId: string;
  /** Per-token overrides layered on top of the chosen theme. */
  customVars: Record<string, string>;
  accent: string | null;
  accent2: string | null;
  wallpaper: WallpaperId;
  wallpaperImage: string | null;
  wallpaperBlur: number;
  wallpaperDim: number;
  wallpaperAnimate: boolean;
  radius: number;
  glass: number;
  uiScale: number;
  density: number;
  windowOpacity: number;
  fontId: string;
  monoFontId: string;
  motion: boolean;

  // ── Shell layout ────────────────────────────────────────────────────────
  dockPosition: "bottom" | "left" | "right" | "top" | "hidden";
  dockApps: string[];
  dockMagnify: boolean;
  dockAutohide: boolean;
  dockLabels: boolean;
  topBarVisible: boolean;
  topBarItems: string[];
  desktopIcons: string[];
  showDesktopIcons: boolean;
  widgets: WidgetInstance[];
  showWidgets: boolean;
  titlebarStyle: "mac" | "windows" | "minimal";
  windowChrome: "glass" | "solid" | "outline";

  // ── Behaviour ───────────────────────────────────────────────────────────
  pet: string;
  petVisible: boolean;
  petPos: { x: number; y: number };
  snapEnabled: boolean;
  focusFollowsMouse: boolean;
  confirmClose: boolean;
  startupApps: string[];
  keybinds: Record<string, string>;

  // ── AI ──────────────────────────────────────────────────────────────────
  ai: AISettings;
}

export interface WidgetInstance {
  id: string;
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
  config?: Record<string, unknown>;
}

export interface AISettings {
  provider: string;
  model: string;
  /** BYOK. Kept in this browser only; never sent anywhere but the chosen
   *  provider, and only through the user's own request. */
  keys: Record<string, string>;
  baseUrls: Record<string, string>;
  temperature: number;
  maxTokens: number;
  systemPrompt: string;
  streaming: boolean;
  /** Hard ceiling so a runaway swarm cannot silently burn a budget. */
  budgetUsd: number;
  spentUsd: number;
}

export const DEFAULT_KEYBINDS: Record<string, string> = {
  "palette.open": "mod+k",
  "launcher.open": "mod+space",
  "window.close": "mod+w",
  "window.maximize": "mod+up",
  "window.minimize": "mod+down",
  "window.cycle": "mod+`",
  "window.snapLeft": "mod+alt+left",
  "window.snapRight": "mod+alt+right",
  "window.tile": "mod+shift+t",
  "workspace.next": "mod+alt+down",
  "workspace.prev": "mod+alt+up",
  "shell.settings": "mod+,",
  "shell.showDesktop": "mod+shift+d",
};

const DEFAULTS: Settings = {
  profileId: "webaios",
  themeId: "aurora",
  customVars: {},
  accent: null,
  accent2: null,
  wallpaper: "mesh",
  wallpaperImage: null,
  wallpaperBlur: 0,
  wallpaperDim: 0.15,
  wallpaperAnimate: true,
  radius: 14,
  glass: 14,
  uiScale: 1,
  density: 1,
  windowOpacity: 1,
  fontId: "system",
  monoFontId: "mono",
  motion: true,

  dockPosition: "bottom",
  dockApps: ["launcher", "chat", "swarm", "atlas", "ide", "forge", "files", "personalize", "settings"],
  dockMagnify: true,
  dockAutohide: false,
  dockLabels: false,
  topBarVisible: true,
  topBarItems: ["workspaces", "spotlight", "ai", "net", "battery", "clock", "notifications"],
  desktopIcons: ["chat", "swarm", "atlas", "ide", "notes"],
  showDesktopIcons: true,
  // Placed clear of the desktop icon column on the left edge, which is 96px
  // wide — widgets defaulting to x:24 landed directly on top of it.
  widgets: [
    { id: "wg_clock", kind: "clock", x: 124, y: 62, w: 250, h: 130 },
    { id: "wg_sys", kind: "system", x: 124, y: 208, w: 250, h: 160 },
  ],
  showWidgets: true,
  titlebarStyle: "mac",
  windowChrome: "glass",

  pet: "none",
  petVisible: false,
  petPos: { x: 82, y: 70 },
  snapEnabled: true,
  focusFollowsMouse: false,
  confirmClose: false,
  startupApps: [],
  keybinds: { ...DEFAULT_KEYBINDS },

  ai: {
    provider: "openai",
    model: "gpt-5.2",
    keys: {},
    baseUrls: {},
    temperature: 0.7,
    maxTokens: 4096,
    systemPrompt: "You are the assistant inside Web-AIOS, a customizable AI desktop. Be direct and useful.",
    streaming: true,
    budgetUsd: 10,
    spentUsd: 0,
  },
};

export interface SettingsState extends Settings {
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  patch: (p: Partial<Settings>) => void;
  setAI: <K extends keyof AISettings>(key: K, value: AISettings[K]) => void;
  setVar: (name: string, value: string) => void;
  clearVar: (name: string) => void;
  applyTheme: (id: string) => void;
  applyProfile: (id: string) => void;
  reset: () => void;
  exportProfile: () => string;
  importProfile: (json: string) => { ok: boolean; error?: string };
  addWidget: (kind: string) => void;
  removeWidget: (id: string) => void;
  moveWidget: (id: string, x: number, y: number) => void;
  resizeWidget: (id: string, w: number, h: number) => void;
  toggleDockApp: (appId: string) => void;
  reorderDock: (from: number, to: number) => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set, get) => ({
      ...DEFAULTS,

      set: (key, value) => set({ [key]: value } as Partial<Settings>),
      patch: (p) => set(p),
      setAI: (key, value) => set((s) => ({ ai: { ...s.ai, [key]: value } })),
      setVar: (name, value) => set((s) => ({ customVars: { ...s.customVars, [name]: value } })),
      clearVar: (name) =>
        set((s) => {
          const next = { ...s.customVars };
          delete next[name];
          return { customVars: next };
        }),

      // Switching preset themes discards token overrides on purpose: a half-applied
      // palette is the single most common way a themeable UI becomes unreadable.
      applyTheme: (id) => set({ themeId: id, customVars: {}, accent: null, accent2: null }),

      // A profile writes a whole personality at once. It deliberately clears
      // token overrides too — carrying a neon accent into Windows 95 produces
      // something that is neither.
      applyProfile: (id) => {
        const profile = getProfile(id);
        if (!profile) return;
        set({
          profileId: id,
          themeId: profile.theme.id,
          customVars: {},
          accent: null,
          accent2: null,
          ...profile.shell,
        });
      },

      reset: () => set({ ...DEFAULTS, keybinds: { ...DEFAULT_KEYBINDS } }),

      exportProfile: () => {
        const s = get();
        const { ai, ...rest } = s as unknown as Settings;
        // Keys are deliberately stripped from the export so a shared profile
        // can never leak credentials.
        const safeAI = { ...ai, keys: {} };
        return JSON.stringify({ __webaios: 1, version: 1, settings: { ...rest, ai: safeAI } }, null, 2);
      },

      importProfile: (json) => {
        try {
          const parsed = JSON.parse(json);
          const incoming = parsed?.settings ?? parsed;
          if (!incoming || typeof incoming !== "object") return { ok: false, error: "Not a settings object." };
          const merged: Partial<Settings> = {};
          for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) {
            if (k in incoming) (merged as Record<string, unknown>)[k] = incoming[k];
          }
          // Never let an imported profile overwrite the local key ring.
          if (merged.ai) merged.ai = { ...get().ai, ...merged.ai, keys: get().ai.keys };
          set(merged);
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : "Invalid JSON." };
        }
      },

      addWidget: (kind) =>
        set((s) => ({
          widgets: [
            ...s.widgets,
            { id: `wg_${Math.random().toString(36).slice(2, 8)}`, kind, x: 40 + s.widgets.length * 20, y: 80 + s.widgets.length * 20, w: 250, h: 160 },
          ],
        })),
      removeWidget: (id) => set((s) => ({ widgets: s.widgets.filter((w) => w.id !== id) })),
      moveWidget: (id, x, y) => set((s) => ({ widgets: s.widgets.map((w) => (w.id === id ? { ...w, x, y } : w)) })),
      resizeWidget: (id, w, h) => set((s) => ({ widgets: s.widgets.map((x) => (x.id === id ? { ...x, w, h } : x)) })),

      toggleDockApp: (appId) =>
        set((s) => ({
          dockApps: s.dockApps.includes(appId) ? s.dockApps.filter((a) => a !== appId) : [...s.dockApps, appId],
        })),

      reorderDock: (from, to) =>
        set((s) => {
          const next = [...s.dockApps];
          const [item] = next.splice(from, 1);
          next.splice(to, 0, item);
          return { dockApps: next };
        }),
    }),
    {
      name: "webaios.settings.v1",
      storage: createJSONStorage(() => localStorage),
      version: 1,
      merge: (persisted, current) => {
        // Deep-merge so a new release that adds a setting doesn't wipe the
        // user's saved profile, and vice versa.
        const p = (persisted ?? {}) as Partial<Settings>;
        return {
          ...current,
          ...p,
          ai: { ...current.ai, ...(p.ai ?? {}) },
          keybinds: { ...DEFAULT_KEYBINDS, ...(p.keybinds ?? {}) },
          customVars: { ...(p.customVars ?? {}) },
        };
      },
    },
  ),
);

/** Resolve the active theme plus every user override into one flat token map. */
export function resolveTokens(s: Settings): Record<string, string> {
  // A profile ships its own palette; look there first so "Windows 95" is not
  // silently repainted by whichever preset theme happens to share an id.
  const profileTheme = PROFILES.find((p) => p.id === s.profileId)?.theme;
  const theme: Theme =
    (profileTheme && profileTheme.id === s.themeId ? profileTheme : undefined) ??
    THEMES.find((t) => t.id === s.themeId) ??
    profileTheme ??
    THEMES[0];
  const font = FONT_STACKS.find((f) => f.id === s.fontId) ?? FONT_STACKS[0];
  const mono = FONT_STACKS.find((f) => f.id === s.monoFontId) ?? FONT_STACKS[4];
  return {
    ...theme.vars,
    ...(s.accent ? { "--accent": s.accent } : {}),
    ...(s.accent2 ? { "--accent2": s.accent2 } : {}),
    "--radius": `${s.radius}px`,
    "--glass": `${s.glass}px`,
    "--ui-scale": String(s.uiScale),
    "--density": String(s.density),
    "--window-opacity": String(s.windowOpacity),
    "--font-ui": font.value,
    "--font-mono": mono.value,
    "--motion": s.motion ? "1" : "0",
    ...s.customVars,
  };
}
