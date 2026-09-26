/* ────────────────────────────────────────────────────────────────────────────
   Chart geometry for the AIOS Chat "chart" panel.

   The model supplies numbers and labels, never markup. Everything drawn — every
   bar, point, tick and label position — is computed here, so it can be tested,
   and the SVG in the view is a straight transcription of this layout.

   Axis ticks use the usual 1 / 2 / 2.5 / 5 x 10^k "nice" steps, and the value
   axis always includes zero, so a bar's height is honest: a bar twice as tall
   is twice the value. Negative values hang below the zero line.

   PURE. No DOM, no clock.
   ──────────────────────────────────────────────────────────────────────────── */

export interface ChartSeries {
  name: string;
  /** One value per label; null is a gap (no bar, and a break in the line). */
  values: Array<number | null>;
}

export interface ChartSpec {
  kind: "bar" | "line";
  labels: string[];
  series: ChartSeries[];
}

export interface ChartBox {
  w: number;
  h: number;
  /** Room for the value labels on the left. */
  left?: number;
  /** Room for the category labels at the bottom. */
  bottom?: number;
  top?: number;
  right?: number;
}

export interface Tick { v: number; y: number; label: string }
export interface Bar { x: number; y: number; w: number; h: number; v: number; series: number; label: string }
export interface LinePoint { x: number; y: number; v: number }
export interface ChartLayout {
  ticks: Tick[];
  /** y of the zero line. */
  zeroY: number;
  bars: Bar[];
  /** Each series' line, already split at gaps into runs of 1+ points. */
  lines: Array<{ series: number; runs: LinePoint[][] }>;
  xLabels: Array<{ x: number; text: string }>;
  plot: { x: number; y: number; w: number; h: number };
}

/** The smallest "nice" step (1, 2, 2.5 or 5 x 10^k) at least `raw`. */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const k = Math.floor(Math.log10(raw));
  const base = 10 ** k;
  for (const m of [1, 2, 2.5, 5, 10]) {
    // A small tolerance so 0.3 / 3 = 0.1 does not become 0.2 through rounding.
    if (m * base >= raw * (1 - 1e-9)) return m * base;
  }
  return 10 * base;
}

/** Ticks covering [min, max] and including 0, about `target` intervals. */
export function niceTicks(min: number, max: number, target = 4): number[] {
  let lo = Math.min(0, min);
  let hi = Math.max(0, max);
  if (lo === hi) hi = lo + 1;
  const step = niceStep((hi - lo) / target);
  lo = Math.floor(lo / step + 1e-9) * step;
  hi = Math.ceil(hi / step - 1e-9) * step;
  const out: number[] = [];
  for (let v = lo, i = 0; v <= hi + step / 2 && i < 50; v += step, i++) out.push(round(v));
  return out;
}

const round = (v: number) => Math.round(v * 1e9) / 1e9;

/** 1234 -> "1.2k", 2500000 -> "2.5M", 0.25 -> "0.25". */
export function compactNumber(v: number): string {
  const a = Math.abs(v);
  const fmt = (x: number) => String(Math.round(x * 10) / 10);
  if (a >= 1e9) return `${fmt(v / 1e9)}B`;
  if (a >= 1e6) return `${fmt(v / 1e6)}M`;
  if (a >= 1e4) return `${fmt(v / 1e3)}k`;
  if (a >= 1000) return String(Math.round(v));
  return String(round(Math.round(v * 100) / 100));
}

export function chartLayout(spec: ChartSpec, box: ChartBox): ChartLayout {
  const left = box.left ?? 34, bottom = box.bottom ?? 18, top = box.top ?? 6, right = box.right ?? 6;
  const plot = { x: left, y: top, w: Math.max(1, box.w - left - right), h: Math.max(1, box.h - top - bottom) };
  const n = Math.max(1, spec.labels.length);

  const all = spec.series.flatMap((s) => s.values.filter((v): v is number => typeof v === "number" && Number.isFinite(v)));
  const ticksV = niceTicks(all.length ? Math.min(...all) : 0, all.length ? Math.max(...all) : 1);
  const lo = ticksV[0], hi = ticksV[ticksV.length - 1];
  const yOf = (v: number) => plot.y + plot.h - ((v - lo) / (hi - lo)) * plot.h;
  const zeroY = yOf(0);

  const slot = plot.w / n;
  const centre = (i: number) => plot.x + slot * (i + 0.5);

  const bars: Bar[] = [];
  const lines: ChartLayout["lines"] = [];
  if (spec.kind === "bar") {
    const k = Math.max(1, spec.series.length);
    const group = slot * 0.72;
    const bw = group / k;
    spec.series.forEach((s, si) => {
      for (let i = 0; i < n; i++) {
        const v = s.values[i];
        if (typeof v !== "number" || !Number.isFinite(v)) continue;
        const x = plot.x + slot * i + (slot - group) / 2 + bw * si;
        const y = Math.min(yOf(v), zeroY);
        bars.push({ x, y, w: bw, h: Math.abs(yOf(v) - zeroY), v, series: si, label: spec.labels[i] ?? "" });
      }
    });
  } else {
    spec.series.forEach((s, si) => {
      const runs: LinePoint[][] = [];
      let run: LinePoint[] = [];
      for (let i = 0; i < n; i++) {
        const v = s.values[i];
        if (typeof v !== "number" || !Number.isFinite(v)) {
          if (run.length) runs.push(run);
          run = [];
          continue;
        }
        run.push({ x: centre(i), y: yOf(v), v });
      }
      if (run.length) runs.push(run);
      lines.push({ series: si, runs });
    });
  }

  // Thin the category labels so they never overlap: roughly 6px per character.
  const longest = Math.max(1, ...spec.labels.map((l) => l.length));
  const every = Math.max(1, Math.ceil((longest * 6 + 4) / slot));
  const xLabels = spec.labels.map((t, i) => ({ x: centre(i), text: t })).filter((_l, i) => i % every === 0);

  return {
    ticks: ticksV.map((v) => ({ v, y: yOf(v), label: compactNumber(v) })),
    zeroY,
    bars,
    lines,
    xLabels,
    plot,
  };
}
