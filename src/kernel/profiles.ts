import type { Settings } from "./settings";
import type { Theme } from "./themes";

/* ────────────────────────────────────────────────────────────────────────────
   Shell Profiles — selectable operating-system personalities.

   A theme changes colours. A profile changes what the machine *is*: where the
   dock lives, what a titlebar looks like, how sharp the corners are, whether
   there is glass at all, which apps are on the dock. Picking "Windows 95"
   should not leave you with a macOS traffic-light window in teal.

   This is the abstraction the source material was already reaching for —
   aurora-os.html shipped fourteen OS skins, WebOS_All_Out shipped ten themes
   plus its own layout, GenAI-OS-V2 its own again. One profile record unifies
   them, and every field is overridable afterwards, so a profile is a starting
   point rather than a cage.
   ──────────────────────────────────────────────────────────────────────────── */

export interface ShellProfile {
  id: string;
  name: string;
  /** Where this look came from, shown in the picker so the lineage is visible. */
  lineage: string;
  swatch: string;
  /** Full token set. Profiles carry their own palette rather than borrowing one. */
  theme: Theme;
  /** Layout and chrome the profile imposes when applied. */
  shell: Partial<
    Pick<
      Settings,
      | "wallpaper" | "wallpaperAnimate" | "wallpaperDim" | "radius" | "glass"
      | "dockPosition" | "dockMagnify" | "dockLabels" | "titlebarStyle"
      | "windowChrome" | "topBarVisible" | "fontId" | "monoFontId" | "density"
      | "showDesktopIcons" | "dockApps" | "pet" | "petVisible"
    >
  >;
}

const theme = (id: string, name: string, dark: boolean, v: Record<string, string>): Theme => ({
  id,
  name,
  dark,
  vars: { "--border": dark ? "rgb(255 255 255 / 0.12)" : "rgb(10 20 40 / 0.16)", ...v },
});

export const PROFILES: ShellProfile[] = [
  {
    id: "webaios",
    name: "Web-AIOS",
    lineage: "This project's native look",
    swatch: "linear-gradient(135deg,#07111f,#67e8f9 55%,#8b5cf6)",
    theme: theme("webaios", "Web-AIOS", true, {
      "--bg": "#07111f", "--bg2": "#132845", "--panel": "rgb(10 20 38 / 0.82)", "--panel-solid": "#111d31",
      "--text": "#edf7ff", "--muted": "#9eb1ca", "--accent": "#67e8f9", "--accent2": "#8b5cf6",
    }),
    shell: { wallpaper: "mesh", radius: 14, glass: 14, dockPosition: "bottom", dockMagnify: true, titlebarStyle: "mac", windowChrome: "glass", topBarVisible: true, fontId: "system", density: 1 },
  },
  {
    id: "webos",
    name: "WebOS All-Out",
    lineage: "WebOS_All_Out_Edition.html",
    swatch: "linear-gradient(135deg,#07111f,#67e8f9,#8b5cf6)",
    theme: theme("webos", "Aurora Glass", true, {
      "--bg": "#07111f", "--bg2": "#132845", "--panel": "rgb(10 20 38 / 0.86)", "--panel-solid": "#111d31",
      "--text": "#edf7ff", "--muted": "#9eb1ca", "--accent": "#67e8f9", "--accent2": "#8b5cf6",
    }),
    shell: {
      wallpaper: "mesh", wallpaperAnimate: true, radius: 16, glass: 18, dockPosition: "bottom",
      dockMagnify: true, dockLabels: false, titlebarStyle: "mac", windowChrome: "glass",
      showDesktopIcons: true, pet: "cat", petVisible: true,
      dockApps: ["launcher", "studio", "chat", "browser", "tasks", "files", "personalize", "settings"],
    },
  },
  {
    id: "genai",
    name: "GenAI-OS",
    lineage: "GenAI-OS-V2.html",
    swatch: "linear-gradient(140deg,#173842,#28666a,#53508a)",
    theme: theme("genai", "CoreAI", true, {
      "--bg": "#0d1518", "--bg2": "#1d3339", "--panel": "rgb(14 24 28 / 0.88)", "--panel-solid": "#15242a",
      "--text": "#e8f4f2", "--muted": "#8fa8a6", "--accent": "#3fb6a8", "--accent2": "#7c76c4",
    }),
    shell: {
      wallpaper: "waves", radius: 10, glass: 10, dockPosition: "left", dockMagnify: false, dockLabels: true,
      titlebarStyle: "minimal", windowChrome: "solid", density: 0.95, showDesktopIcons: false,
      dockApps: ["launcher", "chat", "studio", "notes", "monitor", "assets", "settings"],
    },
  },
  {
    id: "nova",
    name: "NovaOS",
    lineage: "NovaOS Website Creator",
    swatch: "linear-gradient(135deg,#120a22,#ffd24a,#2ee6a4)",
    theme: theme("nova", "NovaOS", true, {
      "--bg": "#0c0716", "--bg2": "#231645", "--panel": "rgb(18 10 34 / 0.86)", "--panel-solid": "#1a1030",
      "--text": "#f6f1ff", "--muted": "#b3a3cf", "--accent": "#ffd24a", "--accent2": "#2ee6a4",
    }),
    shell: {
      wallpaper: "rings", radius: 18, glass: 16, dockPosition: "bottom", dockMagnify: true, dockLabels: true,
      titlebarStyle: "mac", windowChrome: "glass", fontId: "rounded",
      dockApps: ["launcher", "studio", "forge3d", "assets", "media", "chat", "personalize"],
    },
  },
  {
    id: "aurora",
    name: "Aurora Mycelium",
    lineage: "aurora-os.html",
    swatch: "linear-gradient(135deg,#07060f,#3ee8c8 40%,#8b78ff)",
    theme: theme("aurora", "Aurora Mycelium", true, {
      "--bg": "#07060f", "--bg2": "#161036", "--panel": "rgb(11 9 24 / 0.84)", "--panel-solid": "#120e26",
      "--text": "#eef0ff", "--muted": "#9d9ac4", "--accent": "#3ee8c8", "--accent2": "#8b78ff",
    }),
    shell: {
      wallpaper: "particles", wallpaperAnimate: true, radius: 14, glass: 20, dockPosition: "bottom",
      dockMagnify: true, titlebarStyle: "minimal", windowChrome: "glass", pet: "octo", petVisible: true,
      dockApps: ["launcher", "swarm", "chat", "vault", "observatory", "bridge", "personalize"],
    },
  },
  {
    id: "platinum",
    name: "Mac OS Platinum",
    lineage: "aurora-os skin",
    swatch: "linear-gradient(180deg,#dddddd,#73739c)",
    theme: theme("platinum", "Platinum", false, {
      "--bg": "#9a9a9a", "--bg2": "#cccccc", "--panel": "rgb(221 221 221 / 0.97)", "--panel-solid": "#dddddd",
      "--text": "#000000", "--muted": "#555555", "--accent": "#3a3a8c", "--accent2": "#73739c",
      "--border": "rgb(0 0 0 / 0.42)",
    }),
    shell: {
      wallpaper: "solid", wallpaperAnimate: false, radius: 2, glass: 0, dockPosition: "hidden",
      titlebarStyle: "windows", windowChrome: "solid", topBarVisible: true, fontId: "geometric",
      showDesktopIcons: true, density: 0.9,
    },
  },
  {
    id: "aqua",
    name: "Mac OS X Aqua",
    lineage: "aurora-os skin",
    swatch: "linear-gradient(180deg,#7eb6ff,#2d6bdc)",
    theme: theme("aqua", "Aqua", false, {
      "--bg": "#1b3f7a", "--bg2": "#7eb6ff", "--panel": "rgb(244 248 255 / 0.9)", "--panel-solid": "#f4f8ff",
      "--text": "#0b1a33", "--muted": "#4a6489", "--accent": "#2d6bdc", "--accent2": "#7eb6ff",
      "--border": "rgb(20 40 80 / 0.24)",
    }),
    shell: {
      wallpaper: "mesh", radius: 12, glass: 10, dockPosition: "bottom", dockMagnify: true,
      titlebarStyle: "mac", windowChrome: "glass", fontId: "humanist", showDesktopIcons: true,
    },
  },
  {
    id: "sequoia",
    name: "macOS Sequoia",
    lineage: "aurora-os skin",
    swatch: "linear-gradient(180deg,#2c2c2e,#0a84ff)",
    theme: theme("sequoia", "Sequoia", true, {
      "--bg": "#1c1c1e", "--bg2": "#2c2c2e", "--panel": "rgb(28 28 30 / 0.78)", "--panel-solid": "#242426",
      "--text": "#f5f5f7", "--muted": "#98989d", "--accent": "#0a84ff", "--accent2": "#5e5ce6",
    }),
    shell: {
      wallpaper: "mesh", radius: 12, glass: 24, dockPosition: "bottom", dockMagnify: true,
      titlebarStyle: "mac", windowChrome: "glass", fontId: "system",
    },
  },
  {
    id: "win95",
    name: "Windows 95",
    lineage: "aurora-os skin",
    swatch: "linear-gradient(180deg,#008080,#000080)",
    theme: theme("win95", "Windows 95", false, {
      "--bg": "#008080", "--bg2": "#008080", "--panel": "rgb(192 192 192 / 1)", "--panel-solid": "#c0c0c0",
      "--text": "#000000", "--muted": "#404040", "--accent": "#000080", "--accent2": "#0000ff",
      "--border": "rgb(0 0 0 / 0.65)",
    }),
    shell: {
      wallpaper: "solid", wallpaperAnimate: false, wallpaperDim: 0, radius: 0, glass: 0,
      dockPosition: "bottom", dockMagnify: false, dockLabels: true, titlebarStyle: "windows",
      windowChrome: "solid", fontId: "system", showDesktopIcons: true, density: 0.85,
    },
  },
  {
    id: "vista",
    name: "Windows Vista Aero",
    lineage: "aurora-os skin",
    swatch: "linear-gradient(180deg,#99ffdd,#1a4a8a)",
    theme: theme("vista", "Aero", true, {
      "--bg": "#0a2a4a", "--bg2": "#1a4a8a", "--panel": "rgb(160 210 245 / 0.32)", "--panel-solid": "#1d3f66",
      "--text": "#f2fbff", "--muted": "#b8d8f0", "--accent": "#7fd8ff", "--accent2": "#3d9be9",
    }),
    shell: {
      wallpaper: "waves", radius: 8, glass: 28, dockPosition: "bottom", dockMagnify: false, dockLabels: true,
      titlebarStyle: "windows", windowChrome: "glass", showDesktopIcons: true,
    },
  },
  {
    id: "fluent",
    name: "Windows 11 Fluent",
    lineage: "aurora-os skin",
    swatch: "linear-gradient(180deg,#202020,#60cdff)",
    theme: theme("fluent", "Fluent", true, {
      "--bg": "#1f1f1f", "--bg2": "#2b2b2b", "--panel": "rgb(32 32 32 / 0.82)", "--panel-solid": "#272727",
      "--text": "#ffffff", "--muted": "#a0a0a0", "--accent": "#60cdff", "--accent2": "#4cc2ff",
    }),
    shell: {
      wallpaper: "mesh", radius: 8, glass: 22, dockPosition: "bottom", dockMagnify: false,
      titlebarStyle: "windows", windowChrome: "glass", showDesktopIcons: false,
    },
  },
  {
    id: "yaru",
    name: "Ubuntu Yaru",
    lineage: "aurora-os skin",
    swatch: "linear-gradient(180deg,#2c001e,#e95420)",
    theme: theme("yaru", "Yaru", true, {
      "--bg": "#2c001e", "--bg2": "#511b36", "--panel": "rgb(48 10 32 / 0.9)", "--panel-solid": "#380a26",
      "--text": "#fdf6f3", "--muted": "#c9a8bd", "--accent": "#e95420", "--accent2": "#77216f",
    }),
    shell: {
      wallpaper: "flat", radius: 8, glass: 10, dockPosition: "left", dockMagnify: false,
      titlebarStyle: "minimal", windowChrome: "solid", showDesktopIcons: false,
    },
  },
  {
    id: "tokyo",
    name: "Tokyo Night",
    lineage: "aurora-os skin",
    swatch: "linear-gradient(135deg,#1a1b26,#7dcfff)",
    theme: theme("tokyo", "Tokyo Night", true, {
      "--bg": "#1a1b26", "--bg2": "#24283b", "--panel": "rgb(26 27 38 / 0.9)", "--panel-solid": "#1f2335",
      "--text": "#c0caf5", "--muted": "#565f89", "--accent": "#7dcfff", "--accent2": "#bb9af7",
    }),
    shell: {
      wallpaper: "grid", radius: 8, glass: 8, dockPosition: "left", dockMagnify: false,
      titlebarStyle: "minimal", windowChrome: "outline", fontId: "mono", monoFontId: "mono", density: 0.9,
    },
  },
  {
    id: "phosphor",
    name: "CRT Phosphor",
    lineage: "aurora-os skin",
    swatch: "linear-gradient(180deg,#050802,#b6ff3b)",
    theme: theme("phosphor", "Phosphor", true, {
      "--bg": "#050802", "--bg2": "#0a1405", "--panel": "rgb(6 12 3 / 0.92)", "--panel-solid": "#081004",
      "--text": "#b6ff3b", "--muted": "#5f8a22", "--accent": "#b6ff3b", "--accent2": "#6fdc1f",
      "--border": "rgb(182 255 59 / 0.3)",
    }),
    shell: {
      wallpaper: "grid", radius: 0, glass: 0, dockPosition: "bottom", dockMagnify: false, dockLabels: true,
      titlebarStyle: "minimal", windowChrome: "outline", fontId: "mono", monoFontId: "mono",
      showDesktopIcons: false, density: 0.9,
    },
  },
  {
    id: "swiss",
    name: "Swiss Paper",
    lineage: "aurora-os skin",
    swatch: "linear-gradient(180deg,#f3efe7,#b42318)",
    theme: theme("swiss", "Swiss Paper", false, {
      "--bg": "#f3efe7", "--bg2": "#e4ded1", "--panel": "rgb(255 255 255 / 0.95)", "--panel-solid": "#ffffff",
      "--text": "#16130f", "--muted": "#6b635a", "--accent": "#b42318", "--accent2": "#16130f",
      "--border": "rgb(22 19 15 / 0.18)",
    }),
    shell: {
      wallpaper: "solid", wallpaperAnimate: false, wallpaperDim: 0, radius: 2, glass: 0,
      dockPosition: "top", dockMagnify: false, dockLabels: true, titlebarStyle: "minimal",
      windowChrome: "outline", fontId: "geometric", showDesktopIcons: false,
    },
  },
  {
    id: "amiga",
    name: "Amiga Workbench",
    lineage: "aurora-os skin",
    swatch: "linear-gradient(180deg,#0055aa,#ff8800)",
    theme: theme("amiga", "Workbench", true, {
      "--bg": "#0055aa", "--bg2": "#0077cc", "--panel": "rgb(170 170 170 / 1)", "--panel-solid": "#aaaaaa",
      "--text": "#000000", "--muted": "#333333", "--accent": "#ff8800", "--accent2": "#0055aa",
      "--border": "rgb(0 0 0 / 0.7)",
    }),
    shell: {
      wallpaper: "solid", wallpaperAnimate: false, wallpaperDim: 0, radius: 0, glass: 0,
      dockPosition: "top", dockMagnify: false, dockLabels: true, titlebarStyle: "windows",
      windowChrome: "solid", showDesktopIcons: true, density: 0.85,
    },
  },
  {
    id: "nightcity",
    name: "Night City",
    lineage: "aurora-os skin",
    swatch: "linear-gradient(135deg,#05010d,#00f0ff 50%,#ff2bd6)",
    theme: theme("nightcity", "Night City", true, {
      "--bg": "#05010d", "--bg2": "#12042b", "--panel": "rgb(8 2 20 / 0.84)", "--panel-solid": "#0c0420",
      "--text": "#e9fbff", "--muted": "#8aa8b8", "--accent": "#00f0ff", "--accent2": "#ff2bd6",
    }),
    shell: {
      wallpaper: "grid", wallpaperAnimate: true, radius: 4, glass: 12, dockPosition: "bottom",
      dockMagnify: true, titlebarStyle: "minimal", windowChrome: "outline", fontId: "mono",
    },
  },
];

export const getProfile = (id: string): ShellProfile | undefined => PROFILES.find((p) => p.id === id);
