/** A theme is nothing but a bag of CSS custom properties. No component knows
 *  a theme exists; they only read tokens. That is what makes "fully
 *  customizable" tractable instead of a maze of conditionals. */
export interface Theme {
  id: string;
  name: string;
  dark: boolean;
  vars: Record<string, string>;
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
