/** A theme is nothing but a bag of CSS custom properties. No component knows
 *  a theme exists; they only read tokens. That is what makes "fully
 *  customizable" tractable instead of a maze of conditionals. */
import { pickTextColor, relativeLuminance } from "@/lib/contrast";

export interface Theme {
  id: string;
  name: string;
  dark: boolean;
  vars: Record<string, string>;
}

/** Luminance of a #rrggbb accent, for choosing the text that sits on it. */
function hexLuminance(hex: string): number {
  const m = hex.replace("#", "");
  const full = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  const n = parseInt(full, 16);
  return relativeLuminance((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

const t = (
  id: string,
  name: string,
  dark: boolean,
  bg: string,
  bg2: string,
  panel: string,
  panelSolid: string,
  text: string,
  muted: string,
  accent: string,
  accent2: string,
): Theme => ({
  id,
  name,
  dark,
  vars: {
    "--bg": bg,
    "--bg2": bg2,
    "--panel": panel,
    "--panel-solid": panelSolid,
    "--text": text,
    "--muted": muted,
    "--accent": accent,
    "--accent2": accent2,
    /* Text that sits ON an accent, computed rather than guessed.
     *
     * The primary button used to hardcode #04121c over an accent gradient.
     * Measured across the catalogue, that failed WCAG AA on 19 of 50 themes —
     * worst case 2.5:1 on `cloud` — because a token cannot be right for both
     * a near-white accent and a dark teal one. This is exact for every accent,
     * including one a user invents, which is the whole point of letting them
     * invent one. */
    "--on-accent": pickTextColor(hexLuminance(accent)),
    "--on-accent2": pickTextColor(hexLuminance(accent2)),
    "--border": dark ? "rgb(255 255 255 / 0.12)" : "rgb(10 20 40 / 0.14)",
  },
});

export const THEMES: Theme[] = [
  t("aurora", "Aurora Glass", true, "#07111f", "#132845", "rgb(10 20 38 / 0.82)", "#111d31", "#edf7ff", "#9eb1ca", "#67e8f9", "#8b5cf6"),
  t("midnight", "Midnight Blue", true, "#020617", "#101b3b", "rgb(4 10 28 / 0.86)", "#0c1630", "#f1f5f9", "#94a3b8", "#60a5fa", "#22d3ee"),
  t("sunset", "Sunset", true, "#210c18", "#5c1d2c", "rgb(39 12 28 / 0.83)", "#351326", "#fff1f2", "#fecdd3", "#fb7185", "#f59e0b"),
  t("forest", "Forest", true, "#041611", "#13392b", "rgb(5 29 22 / 0.84)", "#0b2a20", "#ecfdf5", "#a7f3d0", "#4ade80", "#14b8a6"),
  t("graphite", "Graphite", true, "#09090b", "#27272a", "rgb(18 18 21 / 0.88)", "#202024", "#fafafa", "#a1a1aa", "#e4e4e7", "#71717a"),
  t("ocean", "Ocean", true, "#031526", "#08456f", "rgb(4 31 53 / 0.83)", "#0b304c", "#f0f9ff", "#bae6fd", "#38bdf8", "#2563eb"),
  t("cyber", "Cyber Grid", true, "#020617", "#071b2b", "rgb(2 13 27 / 0.82)", "#071827", "#e6ffff", "#8bd8d8", "#00f5d4", "#ff2bd6"),
  t("candy", "Candy", true, "#23102f", "#51245e", "rgb(38 15 52 / 0.82)", "#351746", "#fdf4ff", "#f5d0fe", "#f9a8d4", "#c084fc"),
  t("ember", "Ember", true, "#180d07", "#48210f", "rgb(28 14 8 / 0.85)", "#2a1610", "#fff7ed", "#fdba74", "#fb923c", "#ef4444"),
  t("vaporwave", "Vaporwave", true, "#12042b", "#3b0f63", "rgb(21 6 47 / 0.83)", "#22084a", "#f5e9ff", "#d8b4fe", "#f472b6", "#22d3ee"),
  t("matrix", "Matrix", true, "#000a04", "#02220f", "rgb(0 12 6 / 0.88)", "#04180c", "#d7ffe6", "#5dd68f", "#22c55e", "#84cc16"),
  t("nord", "Nord", true, "#2e3440", "#3b4252", "rgb(46 52 64 / 0.86)", "#3b4252", "#eceff4", "#a8b3c4", "#88c0d0", "#b48ead"),
  t("sakura", "Sakura", false, "#fff1f6", "#f6d3e5", "rgb(255 248 252 / 0.84)", "#fff8fc", "#3b1930", "#805b73", "#db2777", "#9333ea"),
  t("paper", "Paper", false, "#f6f1e5", "#d8e6ee", "rgb(255 255 255 / 0.86)", "#f8fafc", "#172033", "#526279", "#0f766e", "#2563eb"),
  t("daylight", "Daylight", false, "#f4f7fb", "#dbe7f5", "rgb(255 255 255 / 0.88)", "#ffffff", "#0f172a", "#64748b", "#2563eb", "#7c3aed"),
  t("linen", "Linen", false, "#faf7f2", "#e8e0d4", "rgb(255 253 250 / 0.88)", "#fffdfa", "#2b2416", "#6b6250", "#b45309", "#0f766e"),

  /* ── Round two ─────────────────────────────────────────────────────────
     Two rules held throughout, because a palette that breaks either is a
     palette nobody keeps on for more than a minute:

     - `muted` must be legible on `panel`. It carries every secondary label in
       the OS, and a muted that disappears into its own background turns half
       the interface into decoration.
     - `accent` and `accent2` must be distinguishable from each other. They
       mark different things — selection versus emphasis — and a theme where
       they read as one colour silently removes a distinction every app relies
       on. A test checks both. */

  /* Dark */
  t("obsidian", "Obsidian", true, "#0a0a0c", "#1c1c22", "rgb(14 14 18 / 0.88)", "#141419", "#f4f4f6", "#a5a5b0", "#f0abfc", "#38bdf8"),
  t("abyss", "Abyss", true, "#00070f", "#052033", "rgb(0 8 18 / 0.88)", "#04121f", "#e6f6ff", "#93b8cf", "#22d3ee", "#818cf8"),
  t("moss", "Moss", true, "#0b1410", "#1e3226", "rgb(11 22 17 / 0.85)", "#152320", "#eef7f0", "#a6c4b0", "#84cc16", "#0d9488"),
  t("wine", "Wine", true, "#190711", "#45102a", "rgb(26 8 18 / 0.85)", "#2a0c1c", "#fdf2f8", "#e6b3cc", "#e11d48", "#a855f7"),
  t("dune", "Dune", true, "#171207", "#3f3016", "rgb(24 18 8 / 0.86)", "#241b0d", "#fdf8ec", "#d9c49a", "#eab308", "#f97316"),
  t("cobalt", "Cobalt", true, "#050c1f", "#0f2359", "rgb(6 13 33 / 0.85)", "#0a1636", "#eef3ff", "#a9bcea", "#3b82f6", "#06b6d4"),
  t("plum", "Plum", true, "#140a1e", "#37174f", "rgb(19 10 30 / 0.85)", "#1f0f2e", "#f8f0ff", "#cbb2e2", "#a78bfa", "#f472b6"),
  t("rust", "Rust", true, "#160c08", "#452113", "rgb(22 12 8 / 0.86)", "#23120b", "#fff3ec", "#e0b499", "#ea580c", "#2dd4bf"),
  t("slate", "Slate", true, "#0f1216", "#242b33", "rgb(15 18 22 / 0.88)", "#1a1f26", "#eef2f6", "#9aa7b4", "#94a3b8", "#38bdf8"),
  t("teal", "Deep Teal", true, "#021414", "#07403d", "rgb(3 22 22 / 0.85)", "#062b29", "#e6fffd", "#9fd6d0", "#2dd4bf", "#0ea5e9"),
  t("ink", "Ink", true, "#0c0f18", "#1c2438", "rgb(11 14 24 / 0.9)", "#151b2b", "#e8ecf7", "#8f9bb8", "#c4b5fd", "#67e8f9"),
  t("amber", "Amber Night", true, "#12100a", "#3a3113", "rgb(18 16 10 / 0.87)", "#1d190e", "#fffaeb", "#d6c489", "#fbbf24", "#f87171"),
  t("crimson", "Crimson", true, "#150507", "#48111a", "rgb(21 5 7 / 0.86)", "#260a10", "#fff1f2", "#e8adb4", "#f43f5e", "#fb923c"),
  t("aurora2", "Polar", true, "#04121a", "#0b3347", "rgb(4 18 26 / 0.84)", "#08283a", "#e9fbff", "#9cccdd", "#5eead4", "#c084fc"),
  t("void", "Void", true, "#000000", "#141414", "rgb(0 0 0 / 0.92)", "#0d0d0d", "#f5f5f5", "#8f8f8f", "#ffffff", "#a3a3a3"),
  t("synthwave", "Synthwave", true, "#150429", "#3d0a52", "rgb(21 4 41 / 0.84)", "#230740", "#ffe9fb", "#e3a8dd", "#ff4ecd", "#f7b733"),
  t("terminal", "Terminal", true, "#0a0e0a", "#13261a", "rgb(8 14 10 / 0.9)", "#0f1a12", "#d4ffd9", "#6fbf7b", "#7cff6b", "#facc15"),
  t("mono", "Monochrome", true, "#111111", "#2a2a2a", "rgb(17 17 17 / 0.9)", "#1d1d1d", "#fafafa", "#9e9e9e", "#e5e5e5", "#737373"),
  t("copper", "Copper", true, "#140f0c", "#3d241a", "rgb(20 15 12 / 0.87)", "#201612", "#fdf1e9", "#d7a98d", "#c2703c", "#3f9b8e"),
  t("indigo", "Indigo", true, "#0a0a20", "#1e1b56", "rgb(10 10 32 / 0.86)", "#14123a", "#eeeeff", "#a8a6e0", "#818cf8", "#34d399"),
  t("jade", "Jade", true, "#04140f", "#0c3b2c", "rgb(4 20 15 / 0.85)", "#082a20", "#e9fff6", "#94ceb5", "#34d399", "#fbbf24"),
  t("noir", "Noir", true, "#08080a", "#1f1f26", "rgb(8 8 10 / 0.9)", "#131317", "#e9e9ee", "#94949f", "#d4d4d8", "#ef4444"),

  /* Light */
  t("porcelain", "Porcelain", false, "#fbfcfe", "#e6ecf4", "rgb(255 255 255 / 0.9)", "#ffffff", "#131a26", "#5b6779", "#0284c7", "#7c3aed"),
  t("meadow", "Meadow", false, "#f3faf2", "#d6ecd6", "rgb(253 255 253 / 0.88)", "#fdfffd", "#16261a", "#4f6b55", "#16a34a", "#0891b2"),
  t("apricot", "Apricot", false, "#fff7f0", "#fbdfc8", "rgb(255 252 249 / 0.88)", "#fffcf9", "#2e1c0f", "#7a5a42", "#ea580c", "#0d9488"),
  t("lavender", "Lavender", false, "#f8f5ff", "#e2d9f7", "rgb(255 254 255 / 0.88)", "#fffeff", "#241a33", "#665a7d", "#7c3aed", "#db2777"),
  t("mint", "Mint", false, "#f1fbf8", "#cdeee5", "rgb(252 255 254 / 0.88)", "#fcfffe", "#12261f", "#4a6b62", "#0d9488", "#7c3aed"),
  t("sandstone", "Sandstone", false, "#fbf6ec", "#e9dcc4", "rgb(255 252 246 / 0.88)", "#fffcf6", "#2a2114", "#6d604a", "#a16207", "#1d4ed8"),
  t("cloud", "Cloud", false, "#f7f9fb", "#e3e9ef", "rgb(255 255 255 / 0.9)", "#ffffff", "#1a2028", "#5f6b78", "#475569", "#0ea5e9"),
  t("blossom", "Blossom", false, "#fff5f8", "#fad6e2", "rgb(255 251 253 / 0.88)", "#fffbfd", "#331824", "#7d556a", "#e11d48", "#7c3aed"),
  t("seafoam", "Seafoam", false, "#f0fafb", "#c9e9ee", "rgb(251 254 255 / 0.88)", "#fbfeff", "#0f2528", "#4b6b70", "#0891b2", "#c026d3"),
  t("parchment", "Parchment", false, "#f9f4e8", "#e4d9bd", "rgb(255 253 246 / 0.88)", "#fffdf6", "#2b2617", "#6a6148", "#92400e", "#166534"),
  t("slateday", "Slate Day", false, "#f4f6f8", "#dde3ea", "rgb(255 255 255 / 0.9)", "#ffffff", "#141a21", "#57626e", "#0f766e", "#b45309"),
  t("citrus", "Citrus", false, "#fffdf0", "#faedbb", "rgb(255 254 247 / 0.88)", "#fffef7", "#2c2707", "#6d6435", "#a16207", "#0d9488"),
];

/* Wallpapers are drawn procedurally on one canvas — see shell/Wallpaper.tsx.
   Nothing here is an image file, so a new one costs no bytes on the wire. */
export const WALLPAPERS = [
  { id: "mesh", name: "Aurora Mesh" },
  { id: "stars", name: "Star Field" },
  { id: "grid", name: "Cyber Grid" },
  { id: "waves", name: "Slow Waves" },
  { id: "rings", name: "Concentric" },
  { id: "noise", name: "Soft Noise" },
  { id: "topo", name: "Topographic" },
  { id: "particles", name: "Particles" },
  { id: "flat", name: "Flat Gradient" },
  { id: "solid", name: "Solid" },
  { id: "image", name: "Custom Image" },
] as const;

export type WallpaperId = (typeof WALLPAPERS)[number]["id"];

export const FONT_STACKS = [
  { id: "system", name: "System", value: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif' },
  { id: "geometric", name: "Geometric", value: '"Avenir Next", "Century Gothic", ui-sans-serif, system-ui, sans-serif' },
  { id: "humanist", name: "Humanist", value: '"Optima", "Gill Sans", "Trebuchet MS", ui-sans-serif, sans-serif' },
  { id: "serif", name: "Serif", value: 'ui-serif, Georgia, "Iowan Old Style", "Times New Roman", serif' },
  { id: "mono", name: "Monospace", value: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace' },
  { id: "rounded", name: "Rounded", value: '"SF Pro Rounded", "Varela Round", ui-rounded, system-ui, sans-serif' },
] as const;
