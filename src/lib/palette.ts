/* Theme from wallpaper: a palette is pulled out of the pixels, then bent until
   it clears the same legibility gates every shipped theme clears
   (scripts/check.mjs, "4c"). The image proposes colours; the gates decide.

   Approach borrowed from the ricing community, not invented here: pywal
   quantises the wallpaper to a handful of colours and builds a scheme from
   them, and Material Color Utilities scores quantised colours by chroma and
   by how much of the image they cover, then picks further colours by hue
   distance. Neither guarantees WCAG contrast on its own, which is the part
   this file adds. Pure and deterministic so the guarantee can be tested. */

import { relativeLuminance, contrastRatio, pickTextColor } from "./contrast";

export type RGB = [number, number, number];

export interface Swatch {
  rgb: RGB;
  /** Share of the sampled, opaque pixels this colour stands for. */
  weight: number;
}

export interface DerivedTheme {
  dark: boolean;
  vars: Record<string, string>;
  notes: string[];
}

/** Every var deriveTheme writes. The UI clears exactly these on Revert. */
export const DERIVED_VARS = [
  "--bg", "--bg2", "--panel", "--panel-solid", "--text", "--muted",
  "--accent", "--accent2", "--border", "--on-accent", "--on-accent2",
] as const;

/** Mirrors scripts/check.mjs 4c, so a derived theme is held to the same bar
 *  as the fifty hand-made ones. */
export const GATES = { TEXT_MIN: 4.5, ACCENT_MIN: 3.0, DISTINCT_MIN: 100, ON_ACCENT_MIN: 4.5 } as const;

/* ── colour arithmetic ───────────────────────────────────────────────────── */

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function toHex([r, g, b]: RGB): string {
  const h = (v: number) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

export function parseHex(value: string | undefined): RGB | null {
  if (!value) return null;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!m || !m[1]) return null;
  const s = m[1];
  const full = s.length === 3 ? s.split("").map((c) => c + c).join("") : s;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const lum = (c: RGB) => relativeLuminance(c[0], c[1], c[2]);
const ratio = (a: RGB, b: RGB) => contrastRatio(lum(a), lum(b));

/** Copied from scripts/check.mjs on purpose: the gate there is the judge, so
 *  this must measure distance exactly the way it does. */
export function redmean(a: RGB, b: RGB): number {
  const rm = (a[0] + b[0]) / 2;
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
}

interface HSL { h: number; s: number; l: number }

function rgbToHsl([r, g, b]: RGB): HSL {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === R) h = ((G - B) / d) % 6;
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  return { h: (h * 60 + 360) % 360, s: clamp(s, 0, 1), l };
}

function hslToRgb({ h, s, l }: HSL): RGB {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let rgb: [number, number, number];
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const m = l - c / 2;
  return [Math.round((rgb[0] + m) * 255), Math.round((rgb[1] + m) * 255), Math.round((rgb[2] + m) * 255)];
}

/** Chroma rather than HSL saturation: HSL calls a near-black navy "fully
 *  saturated", and nobody would pick that as an accent. */
const chroma = ([r, g, b]: RGB) => (Math.max(r, g, b) - Math.min(r, g, b)) / 255;

const hueDistance = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/**
 * Move lightness one way until `ok` holds, keeping hue and saturation. The
 * image's colour survives when it can; the far end (white or black) is the
 * answer only when nothing gentler works.
 */
function walkLightness(base: HSL, dir: 1 | -1, ok: (c: RGB) => boolean): RGB | null {
  for (let l = base.l; dir > 0 ? l <= 1.0001 : l >= -0.0001; l += dir * 0.01) {
    const c = hslToRgb({ ...base, l: clamp(l, 0, 1) });
    if (ok(c)) return c;
  }
  return null;
}

/* ── quantize ────────────────────────────────────────────────────────────── */

/** Enough samples to find every colour a person would name; past this the
 *  clustering gets slower and the answer does not change. */
const MAX_SAMPLES = 40000;

/**
 * Deterministic k-means over the opaque pixels.
 *
 * Seeded by farthest-point selection starting from the median-luminance
 * pixel, not at random, so the same wallpaper gives the same theme every time
 * and a small vivid region still gets a centroid of its own instead of being
 * averaged into the background.
 */
export function quantize(data: Uint8ClampedArray | number[], width: number, height: number, k = 6, step = 4): Swatch[] {
  if (width <= 0 || height <= 0) return [];
  const minStride = Math.ceil(Math.sqrt((width * height) / MAX_SAMPLES));
  const stride = Math.max(1, Math.floor(step), minStride);
  const pts: number[] = [];
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const i = (y * width + x) * 4;
      // Mostly transparent pixels show whatever is behind them, not their own
      // colour, so they say nothing about the image.
      if ((data[i + 3] ?? 255) < 128) continue;
      pts.push(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0);
    }
  }
  const n = pts.length / 3;
  if (n === 0) return [];

  const dist2 = (i: number, c: number[]) => {
    const dr = (pts[i * 3] ?? 0) - (c[0] ?? 0);
    const dg = (pts[i * 3 + 1] ?? 0) - (c[1] ?? 0);
    const db = (pts[i * 3 + 2] ?? 0) - (c[2] ?? 0);
    return dr * dr + dg * dg + db * db;
  };
  const at = (i: number) => [pts[i * 3] ?? 0, pts[i * 3 + 1] ?? 0, pts[i * 3 + 2] ?? 0];

  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => {
    const la = relativeLuminance(pts[a * 3] ?? 0, pts[a * 3 + 1] ?? 0, pts[a * 3 + 2] ?? 0);
    const lb = relativeLuminance(pts[b * 3] ?? 0, pts[b * 3 + 1] ?? 0, pts[b * 3 + 2] ?? 0);
    return la - lb || a - b;
  });
  const centroids: number[][] = [at(order[Math.floor(n / 2)] ?? 0)];
  const K = Math.max(1, Math.floor(k));
  const nearest = new Float64Array(n).fill(Infinity);
  while (centroids.length < K) {
    const last = centroids[centroids.length - 1] ?? [0, 0, 0];
    let best = -1, bestD = 0;
    for (let i = 0; i < n; i++) {
      const d = Math.min(nearest[i] ?? Infinity, dist2(i, last));
      nearest[i] = d;
      if (d > bestD) { bestD = d; best = i; }
    }
    // Every remaining pixel already sits on a centroid: the image has fewer
    // distinct colours than k, and inventing more would be noise.
    if (best < 0) break;
    centroids.push(at(best));
  }

  const assign = new Int32Array(n).fill(-1);
  const counts = new Array<number>(centroids.length).fill(0);
  for (let iter = 0; iter < 12; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let bi = 0, bd = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const d = dist2(i, centroids[c] ?? [0, 0, 0]);
        if (d < bd) { bd = d; bi = c; }
      }
      if (assign[i] !== bi) { assign[i] = bi; changed = true; }
    }
    const sums = centroids.map(() => [0, 0, 0]);
    counts.fill(0);
    for (let i = 0; i < n; i++) {
      const c = assign[i] ?? 0;
      const s = sums[c];
      if (!s) continue;
      s[0] = (s[0] ?? 0) + (pts[i * 3] ?? 0);
      s[1] = (s[1] ?? 0) + (pts[i * 3 + 1] ?? 0);
      s[2] = (s[2] ?? 0) + (pts[i * 3 + 2] ?? 0);
      counts[c] = (counts[c] ?? 0) + 1;
    }
    for (let c = 0; c < centroids.length; c++) {
      const cnt = counts[c] ?? 0;
      const s = sums[c] ?? [0, 0, 0];
      // An emptied cluster keeps its old centre; it is dropped at the end.
      if (cnt > 0) centroids[c] = [(s[0] ?? 0) / cnt, (s[1] ?? 0) / cnt, (s[2] ?? 0) / cnt];
    }
    if (!changed) break;
  }

  const out: Swatch[] = [];
  for (let c = 0; c < centroids.length; c++) {
    const cnt = counts[c] ?? 0;
    if (cnt === 0) continue;
    const ce = centroids[c] ?? [0, 0, 0];
    out.push({ rgb: [Math.round(ce[0] ?? 0), Math.round(ce[1] ?? 0), Math.round(ce[2] ?? 0)], weight: cnt / n });
  }
  return out.sort((a, b) => b.weight - a.weight || lum(b.rgb) - lum(a.rgb) || toHex(a.rgb).localeCompare(toHex(b.rgb)));
}

/* ── gates ───────────────────────────────────────────────────────────────── */

export function passesGates(vars: Record<string, string>): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  for (const name of DERIVED_VARS) {
    if (!vars[name]) failures.push(`${name} is missing`);
  }
  const hex = (name: string) => {
    const c = parseHex(vars[name]);
    if (!c && vars[name]) failures.push(`${name} is not a #hex colour`);
    return c;
  };
  const panel = hex("--panel-solid");
  const text = hex("--text");
  const muted = hex("--muted");
  const accent = hex("--accent");
  const accent2 = hex("--accent2");
  const on1 = hex("--on-accent");
  const on2 = hex("--on-accent2");

  if (panel && text && ratio(text, panel) < GATES.TEXT_MIN) failures.push(`text is ${ratio(text, panel).toFixed(2)}:1 on the panel, under ${GATES.TEXT_MIN}:1`);
  if (panel && muted && ratio(muted, panel) < GATES.TEXT_MIN) failures.push(`muted text is ${ratio(muted, panel).toFixed(2)}:1 on the panel, under ${GATES.TEXT_MIN}:1`);
  if (panel && accent && ratio(accent, panel) < GATES.ACCENT_MIN) failures.push(`accent is ${ratio(accent, panel).toFixed(2)}:1 on the panel, under ${GATES.ACCENT_MIN}:1`);
  if (accent && accent2 && redmean(accent, accent2) < GATES.DISTINCT_MIN) failures.push(`accent and accent2 are only ${redmean(accent, accent2).toFixed(0)} apart, under ${GATES.DISTINCT_MIN}`);
  if (accent && on1 && ratio(on1, accent) < GATES.ON_ACCENT_MIN) failures.push(`text on the accent is ${ratio(on1, accent).toFixed(2)}:1, under ${GATES.ON_ACCENT_MIN}:1`);
  if (accent2 && on2 && ratio(on2, accent2) < GATES.ON_ACCENT_MIN) failures.push(`text on accent2 is ${ratio(on2, accent2).toFixed(2)}:1, under ${GATES.ON_ACCENT_MIN}:1`);
  return { ok: failures.length === 0, failures };
}

/* ── derive ──────────────────────────────────────────────────────────────── */

/** Aim above the gates so a theme is comfortable, not merely legal; the walk
 *  still falls back to the bare gate if the target cannot be reached. */
const TEXT_TARGET = 7;
const MUTED_TARGET = 4.8;
const DISTINCT_TARGET = 115;
/** Below this chroma a swatch reads as grey, and a grey accent is invisible
 *  as a selection mark. */
const VIVID_CHROMA = 0.16;
const VIVID_WEIGHT = 0.005;

const onText = (c: RGB) => pickTextColor(lum(c));
const onOk = (c: RGB) => {
  const on = parseHex(onText(c));
  return !!on && ratio(on, c) >= GATES.ON_ACCENT_MIN;
};

export function deriveTheme(swatches: Swatch[], opts: { prefer?: "dark" | "light" | "auto" } = {}): DerivedTheme {
  const notes: string[] = [];
  const sw = swatches.filter((s) => Number.isFinite(s.weight) && s.weight > 0);
  const dominant: RGB = sw[0]?.rgb ?? [40, 44, 52];
  if (sw.length === 0) notes.push("No readable pixels, so a neutral base was used.");

  const prefer = opts.prefer ?? "auto";
  // Same crossover the desktop uses for its labels: if white text reads better
  // on the dominant colour, the wallpaper is dark and so is the theme.
  const dark = prefer === "dark" ? true : prefer === "light" ? false : pickTextColor(lum(dominant)) === "#ffffff";

  const base = rgbToHsl(dominant);
  const tint = (s: number, l: number): RGB => hslToRgb({ h: base.h, s: Math.min(base.s, s), l });
  const bg = dark ? tint(0.45, 0.07) : tint(0.35, 0.95);
  const bg2 = dark ? tint(0.5, 0.17) : tint(0.4, 0.86);
  const panelSolid = dark ? tint(0.35, 0.12) : tint(0.3, 0.975);
  const panelT = dark ? tint(0.35, 0.1) : tint(0.3, 0.96);
  const toward: 1 | -1 = dark ? 1 : -1;

  const pickText = (s: number, l: number, target: number): RGB => {
    const start = { h: base.h, s: Math.min(base.s, s), l };
    return walkLightness(start, toward, (c) => ratio(c, panelSolid) >= target)
      ?? walkLightness(start, toward, (c) => ratio(c, panelSolid) >= GATES.TEXT_MIN)
      ?? (dark ? [255, 255, 255] : [5, 5, 6]);
  };
  const text = pickText(0.25, dark ? 0.94 : 0.1, TEXT_TARGET);
  const muted = pickText(0.2, dark ? 0.72 : 0.4, MUTED_TARGET);

  const vivid = sw
    .map((s) => ({ ...s, hsl: rgbToHsl(s.rgb), chroma: chroma(s.rgb) }))
    .filter((s) => s.chroma >= VIVID_CHROMA && s.weight >= VIVID_WEIGHT);

  let a1: HSL;
  let a2: HSL;
  if (vivid.length === 0) {
    a1 = dark ? { h: 200, s: 0.85, l: 0.62 } : { h: 205, s: 0.85, l: 0.38 };
    a2 = dark ? { h: 32, s: 0.9, l: 0.6 } : { h: 330, s: 0.7, l: 0.45 };
    notes.push("The wallpaper has no vivid colour, so a neutral-friendly accent pair was used.");
  } else {
    // Presence under a square root: a colour covering 4% of the image should
    // not lose to a dull one covering 60%, but a single stray pixel should
    // not win either.
    const score = (s: { chroma: number; weight: number }) => s.chroma * (0.3 + 0.7 * Math.sqrt(s.weight));
    const first = vivid.reduce((best, s) => (score(s) > score(best) ? s : best));
    a1 = first.hsl;
    notes.push(`Accent taken from a colour covering ${Math.max(1, Math.round(first.weight * 100))}% of the wallpaper.`);
    const others = vivid.filter((s) => s !== first && hueDistance(s.hsl.h, first.hsl.h) >= 30);
    if (others.length > 0) {
      const second = others.reduce((best, s) => {
        const d = hueDistance(s.hsl.h, first.hsl.h) - hueDistance(best.hsl.h, first.hsl.h);
        return d > 0 || (d === 0 && score(s) > score(best)) ? s : best;
      });
      a2 = second.hsl;
    } else {
      // Split-complement rather than a straight opposite: the direct opposite
      // of most wallpaper hues is a harsh one.
      a2 = { h: (a1.h + 150) % 360, s: Math.max(a1.s, 0.55), l: a1.l };
      notes.push("Only one hue in the wallpaper, so the second accent is its split complement.");
    }
  }

  const accentOk = (c: RGB) => ratio(c, panelSolid) >= GATES.ACCENT_MIN && onOk(c);
  const accentStart = { ...a1, s: Math.max(a1.s, 0.35) };
  const accent = walkLightness(accentStart, toward, accentOk)
    ?? walkLightness({ ...accentStart, l: dark ? 0.5 : 0.5 }, toward, accentOk)
    ?? (dark ? [255, 255, 255] : [5, 5, 6]);
  if (toHex(accent) !== toHex(hslToRgb(a1))) notes.push("Accent lightness adjusted so it stands out on panels.");

  const a2Ok = (panelToo: boolean, target: number) => (c: RGB) =>
    redmean(c, accent) >= target && onOk(c) && (!panelToo || ratio(c, panelSolid) >= GATES.ACCENT_MIN);
  const accentHsl = rgbToHsl(accent);
  const candidates: HSL[] = [
    { ...a2, s: Math.max(a2.s, 0.35) },
    { h: (accentHsl.h + 150) % 360, s: Math.max(accentHsl.s, 0.6), l: 0.5 },
    { h: (accentHsl.h + 180) % 360, s: Math.max(accentHsl.s, 0.6), l: 0.5 },
    { h: (accentHsl.h + 240) % 360, s: 0.7, l: 0.5 },
  ];
  let accent2: RGB | null = null;
  outer: for (const [panelToo, target] of [[true, DISTINCT_TARGET], [true, GATES.DISTINCT_MIN], [false, GATES.DISTINCT_MIN]] as const) {
    for (const cand of candidates) {
      for (const dir of [toward, (-toward) as 1 | -1]) {
        accent2 = walkLightness(cand, dir, a2Ok(panelToo, target));
        if (accent2) break outer;
      }
    }
  }
  if (!accent2) {
    // Unreachable for any accent a walk can produce, kept so the function is
    // total: black or white is always far from a coloured accent.
    accent2 = lum(accent) > 0.18 ? [5, 5, 6] : [255, 255, 255];
  }
  if (toHex(accent2) !== toHex(hslToRgb(a2))) notes.push("Second accent adjusted to stay distinct from the first.");

  const vars: Record<string, string> = {
    "--bg": toHex(bg),
    "--bg2": toHex(bg2),
    "--panel": `rgb(${panelT[0]} ${panelT[1]} ${panelT[2]} / 0.84)`,
    "--panel-solid": toHex(panelSolid),
    "--text": toHex(text),
    "--muted": toHex(muted),
    "--accent": toHex(accent),
    "--accent2": toHex(accent2),
    // Same values themes.ts uses, so borders look native in either mode.
    "--border": dark ? "rgb(255 255 255 / 0.12)" : "rgb(10 20 40 / 0.14)",
    "--on-accent": onText(accent),
    "--on-accent2": onText(accent2),
  };
  return { dark, vars, notes };
}
