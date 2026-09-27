/* ────────────────────────────────────────────────────────────────────────────
   Customizations beyond theme and wallpaper: screen effects, cursor effects,
   window animation, icon shape, interface sounds, automatic day/night themes,
   and the ThreeUI live-wallpaper catalogue.

   Everything here is data and rules, validated so a hand-edited or old
   settings file can never put a nonsense value on screen. The effects that
   draw live in shell/CustomizeLayer.tsx.

   PURE.
   ──────────────────────────────────────────────────────────────────────────── */

export type CursorFx = "off" | "glow" | "trail" | "spotlight";
export type WindowAnim = "lift" | "zoom" | "slide" | "fade" | "genie" | "none";
export type IconShape = "rounded" | "squircle" | "circle" | "square";
export type UiSounds = "off" | "soft" | "crisp" | "retro";

export interface ScreenFx { grain: number; vignette: number; scanlines: boolean; tint: string | null }
export interface AutoTheme { on: boolean; day: string; night: string; dayStart: number; nightStart: number }
export interface ThreeWallpaper { id: string; speed: number; hue: number }

export interface Customize {
  screenFx: ScreenFx;
  cursorFx: CursorFx;
  windowAnim: WindowAnim;
  iconShape: IconShape;
  uiSounds: UiSounds;
  uiVolume: number;
  autoTheme: AutoTheme;
  threeWallpaper: ThreeWallpaper;
}

export const CUSTOMIZE_DEFAULTS: Customize = {
  screenFx: { grain: 0, vignette: 0, scanlines: false, tint: null },
  cursorFx: "off",
  windowAnim: "lift",
  iconShape: "rounded",
  uiSounds: "off",
  uiVolume: 0.4,
  autoTheme: { on: false, day: "aurora", night: "aurora", dayStart: 7, nightStart: 19 },
  threeWallpaper: { id: "constellation", speed: 1, hue: 0 },
};

const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const oneOf = <T extends string>(v: unknown, all: readonly T[], d: T): T => (typeof v === "string" && (all as readonly string[]).includes(v) ? (v as T) : d);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const CURSOR_FX: readonly CursorFx[] = ["off", "glow", "trail", "spotlight"];
export const WINDOW_ANIMS: readonly WindowAnim[] = ["lift", "zoom", "slide", "fade", "genie", "none"];
export const ICON_SHAPES: readonly IconShape[] = ["rounded", "squircle", "circle", "square"];
export const UI_SOUNDS: readonly UiSounds[] = ["off", "soft", "crisp", "retro"];

export function normaliseCustomize(v: unknown, themeIds: string[] = []): Customize {
  const o = isObj(v) ? v : {};
  const fx = isObj(o.screenFx) ? o.screenFx : {};
  const at = isObj(o.autoTheme) ? o.autoTheme : {};
  const tw = isObj(o.threeWallpaper) ? o.threeWallpaper : {};
  const theme = (t: unknown, d: string) => (typeof t === "string" && (!themeIds.length || themeIds.includes(t)) ? t : d);
  return {
    screenFx: {
      grain: clamp(fx.grain, 0, 1, 0),
      vignette: clamp(fx.vignette, 0, 1, 0),
      scanlines: fx.scanlines === true,
      tint: typeof fx.tint === "string" && /^#[0-9a-f]{6}$/i.test(fx.tint) ? fx.tint : null,
    },
    cursorFx: oneOf(o.cursorFx, CURSOR_FX, "off"),
    windowAnim: oneOf(o.windowAnim, WINDOW_ANIMS, "lift"),
    iconShape: oneOf(o.iconShape, ICON_SHAPES, "rounded"),
    uiSounds: oneOf(o.uiSounds, UI_SOUNDS, "off"),
    uiVolume: clamp(o.uiVolume, 0, 1, 0.4),
    autoTheme: {
      on: at.on === true,
      day: theme(at.day, CUSTOMIZE_DEFAULTS.autoTheme.day),
      night: theme(at.night, CUSTOMIZE_DEFAULTS.autoTheme.night),
      dayStart: Math.round(clamp(at.dayStart, 0, 23, 7)),
      nightStart: Math.round(clamp(at.nightStart, 0, 23, 19)),
    },
    threeWallpaper: {
      id: THREE_WALLPAPERS.some((w) => w.id === tw.id) ? (tw.id as string) : CUSTOMIZE_DEFAULTS.threeWallpaper.id,
      speed: clamp(tw.speed, 0.1, 3, 1),
      hue: clamp(tw.hue, -180, 180, 0),
    },
  };
}

/** Day or night theme for an hour (0-23). Handles a night that wraps midnight and equal starts. */
export function themeForHour(hour: number, a: AutoTheme): string {
  if (a.dayStart === a.nightStart) return a.day;
  const isDay = a.dayStart < a.nightStart ? hour >= a.dayStart && hour < a.nightStart : hour >= a.dayStart || hour < a.nightStart;
  return isDay ? a.day : a.night;
}

/** CSS border-radius for app icon tiles. */
export function iconRadius(shape: IconShape): string {
  return { rounded: "calc(var(--radius) * 0.8)", squircle: "30%", circle: "50%", square: "4px" }[shape];
}

/** Synthesized interface sounds: no audio files, so nothing to download or license. */
export interface Tone { type: "sine" | "triangle" | "square" | "sawtooth"; freq: number; to?: number; ms: number; gain: number }
export type SoundEvent = "open" | "close" | "notify" | "error" | "click";

export const SOUND_SETS: Record<Exclude<UiSounds, "off">, Record<SoundEvent, Tone[]>> = {
  soft: {
    open: [{ type: "sine", freq: 520, to: 780, ms: 120, gain: 0.25 }],
    close: [{ type: "sine", freq: 640, to: 420, ms: 110, gain: 0.2 }],
    notify: [{ type: "sine", freq: 880, ms: 90, gain: 0.22 }, { type: "sine", freq: 1320, ms: 140, gain: 0.18 }],
    error: [{ type: "triangle", freq: 220, to: 160, ms: 220, gain: 0.25 }],
    click: [{ type: "sine", freq: 1200, ms: 25, gain: 0.12 }],
  },
  crisp: {
    open: [{ type: "triangle", freq: 900, to: 1400, ms: 70, gain: 0.2 }],
    close: [{ type: "triangle", freq: 1100, to: 700, ms: 70, gain: 0.18 }],
    notify: [{ type: "triangle", freq: 1568, ms: 60, gain: 0.2 }, { type: "triangle", freq: 2093, ms: 90, gain: 0.16 }],
    error: [{ type: "square", freq: 180, ms: 140, gain: 0.12 }],
    click: [{ type: "triangle", freq: 2400, ms: 15, gain: 0.1 }],
  },
  retro: {
    open: [{ type: "square", freq: 330, ms: 60, gain: 0.08 }, { type: "square", freq: 660, ms: 80, gain: 0.08 }],
    close: [{ type: "square", freq: 660, ms: 60, gain: 0.08 }, { type: "square", freq: 330, ms: 80, gain: 0.08 }],
    notify: [{ type: "square", freq: 988, ms: 70, gain: 0.07 }, { type: "square", freq: 1319, ms: 120, gain: 0.07 }],
    error: [{ type: "sawtooth", freq: 110, ms: 200, gain: 0.08 }],
    click: [{ type: "square", freq: 1760, ms: 12, gain: 0.05 }],
  },
};

/* ── ThreeUI live wallpapers (MIT, github.com/MengTo/threeui) ────────────
   Only components that render from shader code alone: the package's iframe
   and asset-backed pieces (46 MB of assets) are left out. `speed`/`hue` name
   the component's own props for those controls, when it has them. */

export interface ThreeWallpaperDef { id: string; name: string; component: string; variant?: string; speed?: string; hue?: string }

export const THREE_WALLPAPERS: ThreeWallpaperDef[] = [
  { id: "constellation", name: "Constellation", component: "ConstellationField", variant: "constellation-field" },
  { id: "particle-drift", name: "Particle Drift", component: "ConstellationField", variant: "particle-drift" },
  { id: "particle-network", name: "Particle Network", component: "ConstellationField", variant: "particle-network" },
  { id: "gateway-flow", name: "Gateway Flow", component: "ConstellationField", variant: "gateway-flow" },
  { id: "connectivity", name: "Connectivity Graph", component: "ConstellationField", variant: "connectivity-graph" },
  { id: "interface-lines", name: "Interface Lines", component: "ConstellationField", variant: "interface-lines" },
  { id: "defense-lines", name: "Defense Lines", component: "ConstellationField", variant: "defense-lines" },
  { id: "topo", name: "Topographic", component: "ConstellationField", variant: "topo-field" },
  { id: "dot-matrix", name: "Dot Matrix", component: "DotMatrixBackground", speed: "speed", hue: "hue" },
  { id: "crt", name: "CRT", component: "CrtBackground", speed: "speed", hue: "hue" },
  { id: "condensation", name: "Condensation", component: "CondensationBackground" },
  { id: "bell-field", name: "Bell Field", component: "BellFieldBackground", speed: "speed", hue: "hue" },
  { id: "ribbons", name: "Ribbon Field", component: "RibbonFieldBackground", speed: "speed", hue: "hue" },
  { id: "warp", name: "Warp Field", component: "WarpFieldBackground" },
  { id: "emerald-horizon", name: "Emerald Horizon", component: "EmeraldHorizonBackground", speed: "speed", hue: "hue" },
  { id: "liquid-form", name: "Liquid Form", component: "LiquidFormBackground", speed: "speed", hue: "tintHue" },
  { id: "orbital-sphere", name: "Orbital Sphere", component: "OrbitalSphereBackground" },
  { id: "stream", name: "Stream Convergence", component: "StreamConvergenceBackground", speed: "speed", hue: "hue" },
];

/** The props to pass a component for the person's speed and hue settings. */
export function threeProps(def: ThreeWallpaperDef, w: ThreeWallpaper): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  if (def.variant) p.variant = def.variant;
  if (def.speed) p[def.speed] = w.speed;
  if (def.hue) p[def.hue] = w.hue;
  return p;
}
