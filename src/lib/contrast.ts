/* ────────────────────────────────────────────────────────────────────────────
   Readable text over something we did not choose.

   A desktop icon label sits directly on the wallpaper. Its colour comes from
   `--text`, which belongs to the THEME — so a light theme over a dark
   wallpaper paints near-black letters on near-black pixels and the label is
   gone. No token can fix this, because no token knows what is behind it.

   CSS `contrast-color()` is the right tool when the background is a colour you
   can name, and it is used for that elsewhere. It cannot help here: it takes a
   colour value, not whatever happens to be painted underneath. So the pixels
   get read.

   Everything in this file is pure arithmetic over pixel data, which is what
   makes the part that actually decides legibility testable without a browser.

   (The integrity gate in scripts/check.mjs carries its own copy of the
   luminance formula. It is a plain-node script and cannot import TypeScript,
   and six lines of WCAG arithmetic is a smaller cost than a build step that
   exists only to share them.)
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * White, and the softest near-black that still guarantees WCAG AA.
 *
 * Measured, not chosen by eye. With only two colours there is a crossover
 * background where neither is comfortable, and the worst case there is:
 *
 *   #0b0b0d -> 4.44:1   (fails AA)
 *   #050506 -> 4.52:1   (clears it)
 *   #000000 -> 4.59:1
 *
 * So #0b0b0d — the obvious "soft black" — is the one value that breaks the
 * guarantee, by a margin too small to see and large enough to matter. #050506
 * keeps almost all of the softness and makes "every choice clears AA" a true
 * statement rather than an aspiration. A test asserts it across the range.
 */
export const PAPER = "#ffffff";
export const INK = "#050506";

/** WCAG relative luminance. Channels are 0-255. */
export function relativeLuminance(r: number, g: number, b: number): number {
  const lin = (v: number) => {
    const x = Math.min(255, Math.max(0, v)) / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two luminances. 1 = identical, 21 = max. */
export function contrastRatio(a: number, b: number): number {
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * White or ink, whichever contrasts more with this background.
 *
 * The crossover is at luminance ≈ 0.179, not 0.5, because luminance is already
 * perceptual: a mid-grey of 0.5 is much closer to white than to black in
 * contrast terms. Splitting at 0.5 would put black text on backgrounds where
 * white is measurably more readable.
 */
export function pickTextColor(backgroundLuminance: number): string {
  const bg = Math.min(1, Math.max(0, backgroundLuminance));
  const white = relativeLuminance(255, 255, 255);
  const ink = relativeLuminance(5, 5, 6);
  return contrastRatio(bg, white) >= contrastRatio(bg, ink) ? PAPER : INK;
}

/** A dark overlay at `dim` opacity sits between the wallpaper and the text, so
 *  the luminance the text actually faces is lower than the wallpaper's. */
export function applyDim(luminance: number, dim: number): number {
  const d = Math.min(1, Math.max(0, dim));
  return Math.min(1, Math.max(0, luminance)) * (1 - d);
}

/* ── sampling ────────────────────────────────────────────────────────────── */

export interface LuminanceGrid {
  cols: number;
  rows: number;
  /** Row-major mean luminance per cell, 0-1. */
  cells: Float32Array;
}

/**
 * Reduce RGBA pixel data to a coarse luminance grid.
 *
 * Coarse on purpose. A wallpaper is a gradient or a photograph, and one number
 * per icon-sized region is all a label needs — sampling per pixel would cost
 * far more and answer the same question. `step` skips pixels within a cell for
 * the same reason: a 4-pixel stride over a gradient changes the mean by
 * nothing anyone can see.
 */
export function luminanceGrid(
  data: Uint8ClampedArray | number[],
  width: number,
  height: number,
  cols: number,
  rows: number,
  step = 4,
): LuminanceGrid {
  const c = Math.max(1, Math.floor(cols));
  const r = Math.max(1, Math.floor(rows));
  const cells = new Float32Array(c * r);
  if (width <= 0 || height <= 0) return { cols: c, rows: r, cells };

  const counts = new Uint32Array(c * r);
  const stride = Math.max(1, Math.floor(step));

  for (let y = 0; y < height; y += stride) {
    const row = Math.min(r - 1, Math.floor((y / height) * r));
    for (let x = 0; x < width; x += stride) {
      const col = Math.min(c - 1, Math.floor((x / width) * c));
      const i = (y * width + x) * 4;
      const alpha = (data[i + 3] ?? 255) / 255;
      // A transparent pixel shows the page behind it rather than its own
      // colour, so weight it toward nothing rather than counting it as black.
      const lum = relativeLuminance(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0) * alpha;
      const cell = row * c + col;
      cells[cell] = (cells[cell] ?? 0) + lum;
      counts[cell] = (counts[cell] ?? 0) + 1;
    }
  }
  for (let i = 0; i < cells.length; i++) {
    const n = counts[i] ?? 0;
    cells[i] = n > 0 ? (cells[i] ?? 0) / n : 0;
  }
  return { cols: c, rows: r, cells };
}

/** Read the grid at a normalised point. Out-of-range clamps to the edge cell,
 *  because an icon dragged past the surface still needs a colour. */
export function sampleGrid(grid: LuminanceGrid, u: number, v: number): number {
  if (grid.cells.length === 0) return 0;
  const col = Math.min(grid.cols - 1, Math.max(0, Math.floor(u * grid.cols)));
  const row = Math.min(grid.rows - 1, Math.max(0, Math.floor(v * grid.rows)));
  return grid.cells[row * grid.cols + col] ?? 0;
}

/**
 * The colour an element at this point should paint its text.
 *
 * Returns both the colour and the shadow that goes with it. The shadow is not
 * decoration: a grid cell is an average, and a label lying across a hard edge
 * in the wallpaper faces both extremes at once. The halo is what keeps that
 * case readable, and it is the same thing macOS does.
 */
export function textStyleAt(grid: LuminanceGrid, u: number, v: number, dim = 0): { color: string; textShadow: string } {
  const lum = applyDim(sampleGrid(grid, u, v), dim);
  const color = pickTextColor(lum);
  const halo = color === PAPER ? "rgba(0,0,0,0.85)" : "rgba(255,255,255,0.85)";
  return { color, textShadow: `0 1px 2px ${halo}, 0 0 4px ${halo}` };
}
