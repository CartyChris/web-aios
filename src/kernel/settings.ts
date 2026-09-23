"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { THEMES, FONT_STACKS, type Theme, type WallpaperId } from "./themes";
import { allThemes } from "./customthemes";
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
  desktopItems: DesktopItem[];
  showDesktopIcons: boolean;
  /** Icons land on a grid when true — the tidy-desktop preference. */
  snapIconsToGrid: boolean;
  iconSize: number;
  /** How many clicks open a desktop icon. Single is the default because it is
   *  what a touch screen does, and this OS runs on phones. */
  iconActivation: "single" | "double";
  widgets: WidgetInstance[];
  showWidgets: boolean;
  titlebarStyle: "mac" | "windows" | "minimal";
  windowChrome: "glass" | "solid" | "outline";

  // ── Personality ─────────────────────────────────────────────────────────
  pet: string;
  petVisible: boolean;
  petPos: { x: number; y: number };
  /** How much the pet is drawn: outline, shaded, or fully rendered. */
  petDetail: "basic" | "detailed" | "expressive";
  petScale: number;
  /** Idle behaviour: stay put, drift around the desktop, or follow the cursor. */
  petMotion: "still" | "wander" | "follow";
  /** The voice the pet answers in when you click it. */
  petPersonality: string;
  /** What the pet talks ABOUT — separate from how it sounds. See
   *  lib/petmind.ts for why those are two axes rather than one. */
  petMode: string;
  petName: string;
  /** Let the pet talk to a model. Off means it uses its canned lines only. */
  petTalks: boolean;

  /** Tone the OS assistant writes in. Feeds every app's system prompt. */
  voice: string;
  /** Whose tone the OS assistant answers in: its own voice, or the desktop
   *  pet's personality. See lib/petmind.ts — it replaces rather than stacks. */
  assistantSteering: "voice" | "pet";
  /** Free text appended to the assistant's system prompt — who you are, what
   *  you are working on, how you like answers. */
  aboutMe: string;
  greeting: boolean;
  /** Easter eggs, secret key sequences and the arcade's hidden entries. */
  funMode: boolean;

  // ── Behaviour ───────────────────────────────────────────────────────────
  snapEnabled: boolean;
  focusFollowsMouse: boolean;
  confirmClose: boolean;
  startupApps: string[];
  keybinds: Record<string, string>;
  /** Phone or full desktop on a small screen. "auto" gives a phone the phone
   *  view upright and the full desktop on its side; see lib/shell-mode.ts. */
  phoneMode: "auto" | "desktop" | "phone";
  /** The one-time "turn your phone on its side" notice has been dismissed. */
  phoneTipSeen: boolean;

  // ── AI ──────────────────────────────────────────────────────────────────
  ai: AISettings;
}

/** Something pinned to the desktop at a free position.
 *
 *  `kind` decides how `ref` is read: a registry app id, a Studio-built app id,
 *  or a path in the virtual filesystem. That is what lets you pin an app you
 *  invented ten seconds ago next to one that shipped with the OS. */
export interface DesktopItem {
  id: string;
  kind: "app" | "userapp" | "file";
  ref: string;
  x: number;
  y: number;
  /** Overrides the default label; used when you rename an icon. */
  label?: string;
}

export interface WidgetInstance {
  id: string;
  /** A built-in kind, or "custom" when it renders `customId`. */
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Points at a CustomWidget when kind === "custom". */
  customId?: string;
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
  /** Give the model live web access wherever the provider offers it.
   *
   *  On by default: a model answering from a training cutoff about something
   *  that changed last week is the single most common way an answer is
   *  confidently wrong, and OpenRouter can hand any model a search tool. */
  webAccess: boolean;
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
  desktopItems: [
    { id: "d_chat", kind: "app", ref: "chat", x: 24, y: 56 },
    { id: "d_swarm", kind: "app", ref: "swarm", x: 24, y: 156 },
    { id: "d_atlas", kind: "app", ref: "atlas", x: 24, y: 256 },
    { id: "d_ide", kind: "app", ref: "ide", x: 24, y: 356 },
    { id: "d_notes", kind: "app", ref: "notes", x: 24, y: 456 },
  ],
  showDesktopIcons: true,
  snapIconsToGrid: false,
  iconSize: 1,
  iconActivation: "single",
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
  petDetail: "detailed",
  petScale: 1,
  petMotion: "wander",
  petPersonality: "helpful",
  petMode: "tips",
  petName: "",
  petTalks: true,

  voice: "direct",
  assistantSteering: "voice",
  aboutMe: "",
  greeting: true,
  funMode: true,
  snapEnabled: true,
  focusFollowsMouse: false,
  confirmClose: false,
  startupApps: [],
  keybinds: { ...DEFAULT_KEYBINDS },
  phoneMode: "auto",
  phoneTipSeen: false,

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
    webAccess: true,
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
  /** Returns the new widget's id, so a caller never has to guess which one it placed. */
  addWidget: (kind: string, opts?: { config?: Record<string, unknown>; customId?: string; w?: number; h?: number }) => string;
  removeWidget: (id: string) => void;
  moveWidget: (id: string, x: number, y: number) => void;
  /** Replace a widget's config — how News and Live Data widgets save their settings. */
  configureWidget: (id: string, config: Record<string, unknown>) => void;
  resizeWidget: (id: string, w: number, h: number) => void;
  addDesktopItem: (item: Omit<DesktopItem, "id">) => string;
  moveDesktopItems: (moves: Array<{ id: string; x: number; y: number }>) => void;
  removeDesktopItems: (ids: string[]) => void;
  renameDesktopItem: (id: string, label: string) => void;
  tidyDesktop: () => void;
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

      addWidget: (kind, opts = {}) => {
        const id = `wg_${Math.random().toString(36).slice(2, 8)}`;
        set((s) => ({
          widgets: [
            ...s.widgets,
            {
              id, kind,
              x: 40 + s.widgets.length * 20, y: 80 + s.widgets.length * 20,
              w: opts.w ?? 250, h: opts.h ?? 160,
              ...(opts.customId ? { customId: opts.customId } : {}),
              ...(opts.config ? { config: opts.config } : {}),
            },
          ],
        }));
        return id;
      },
      removeWidget: (id) => set((s) => ({ widgets: s.widgets.filter((w) => w.id !== id) })),
      moveWidget: (id, x, y) => set((s) => ({ widgets: s.widgets.map((w) => (w.id === id ? { ...w, x, y } : w)) })),
      configureWidget: (id, config) => set((s) => ({ widgets: s.widgets.map((w) => (w.id === id ? { ...w, config } : w)) })),
      resizeWidget: (id, w, h) => set((s) => ({ widgets: s.widgets.map((x) => (x.id === id ? { ...x, w, h } : x)) })),

      addDesktopItem: (item) => {
        const id = `d_${Math.random().toString(36).slice(2, 9)}`;
        set((s) => ({ desktopItems: [...s.desktopItems, { ...item, id }] }));
        return id;
      },

      // One call for the whole selection, so dragging six icons is a single
      // state write rather than six that each re-render the desktop.
      moveDesktopItems: (moves) =>
        set((s) => {
          const by = new Map(moves.map((m) => [m.id, m]));
          return { desktopItems: s.desktopItems.map((d) => { const m = by.get(d.id); return m ? { ...d, x: m.x, y: m.y } : d; }) };
        }),

      removeDesktopItems: (ids) =>
        set((s) => ({ desktopItems: s.desktopItems.filter((d) => !ids.includes(d.id)) })),

      renameDesktopItem: (id, label) =>
        set((s) => ({ desktopItems: s.desktopItems.map((d) => (d.id === id ? { ...d, label: label || undefined } : d)) })),

      tidyDesktop: () =>
        set((s) => {
          const cellH = 96, cellW = 92, top = 56, left = 24;
          const perCol = Math.max(1, Math.floor((window.innerHeight - top - 90) / cellH));
          return {
            desktopItems: s.desktopItems.map((d, i) => ({
              ...d,
              x: left + Math.floor(i / perCol) * cellW,
              y: top + (i % perCol) * cellH,
            })),
          };
        }),

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
        // v1 stored `desktopIcons: string[]` in a fixed column. Convert rather
        // than drop: losing someone's desktop on upgrade is not acceptable.
        const legacy = (persisted as { desktopIcons?: unknown })?.desktopIcons;
        if (Array.isArray(legacy) && legacy.every((x) => typeof x === "string")) {
          (persisted as Partial<Settings>).desktopItems = (legacy as string[]).map((ref, i) => ({
            id: `d_${ref}`, kind: "app" as const, ref, x: 24, y: 56 + i * 100,
          }));
          delete (persisted as { desktopIcons?: unknown }).desktopIcons;
        }
        // The pet catalogue was rebuilt around species descriptions; two old
        // ids have no direct successor, so point them at the nearest creature
        // rather than leaving someone with an invisible pet.
        const RENAMED_PETS: Record<string, string> = { bird: "crow", slime: "slime" };
        const oldPet = (persisted as { pet?: unknown })?.pet;
        if (typeof oldPet === "string" && RENAMED_PETS[oldPet]) {
          (persisted as Partial<Settings>).pet = RENAMED_PETS[oldPet];
        }
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
    // allThemes(), not THEMES: a theme a system update generated has to resolve
    // here or selecting it would silently fall through to the first built-in.
    allThemes().find((t) => t.id === s.themeId) ??
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
