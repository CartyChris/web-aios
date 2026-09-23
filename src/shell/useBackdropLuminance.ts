"use client";

import { useEffect, useState } from "react";
import { useSettings } from "@/kernel/settings";
import { luminanceGrid, type LuminanceGrid } from "@/lib/contrast";
import { isShaderWallpaper } from "@/lib/wallpaper-shaders";
import { readShaderWallpaperPixels } from "./ShaderWallpaper";

/* ────────────────────────────────────────────────────────────────────────────
   What the wallpaper actually looks like, as numbers.

   The desktop reads its own background so text on top of it can choose a
   readable colour. Only the reading lives here; the arithmetic is in
   lib/contrast.ts, where it can be tested.

   Two things are worth knowing:

   - The procedural wallpapers are drawn on a canvas WE draw, so `getImageData`
     is free and exact. A user-supplied image is a CSS background, so it is
     redrawn once into an offscreen canvas to be read. A remote image would
     taint that canvas and throw; the catch falls back to a neutral grid rather
     than leaving the desktop with no answer.
   - It re-reads on a debounce, not per frame. An animated wallpaper changes
     continuously and nobody needs a label whose colour flickers with it —
     the mean luminance of a region barely moves anyway.
   ──────────────────────────────────────────────────────────────────────────── */

const COLS = 12;
const ROWS = 8;
/** Long enough that an animated wallpaper does not drive constant re-reads,
 *  short enough that switching theme feels immediate. */
const SETTLE_MS = 400;

const NEUTRAL: LuminanceGrid = { cols: 1, rows: 1, cells: new Float32Array([0]) };

export function useBackdropLuminance(): LuminanceGrid {
  const kind = useSettings((s) => s.wallpaper);
  const image = useSettings((s) => s.wallpaperImage);
  const themeId = useSettings((s) => s.themeId);
  const accent = useSettings((s) => s.accent);
  const blur = useSettings((s) => s.wallpaperBlur);
  const [grid, setGrid] = useState<LuminanceGrid>(NEUTRAL);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;

    const refresh = async () => {
      const px = await readWallpaperPixels(kind, image);
      if (!cancelled && px) setGrid(luminanceGrid(px.data, px.width, px.height, COLS, ROWS, px.width > 200 ? 8 : 1));
    };

    // Two passes: one after the wallpaper has had a frame to paint, one later
    // for the procedural wallpapers that ease in.
    timer = window.setTimeout(() => { void refresh(); }, SETTLE_MS);
    const second = window.setTimeout(() => { void refresh(); }, SETTLE_MS * 4);
    const onResize = () => { void refresh(); };
    window.addEventListener("resize", onResize);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearTimeout(second);
      window.removeEventListener("resize", onResize);
    };
  }, [kind, image, themeId, accent, blur]);

  return grid;
}

/**
 * The wallpaper's pixels, however it is drawn. Shared by the label-contrast
 * sampler and "theme from wallpaper" so the two cannot disagree about what
 * the desktop looks like.
 *
 * Procedural wallpapers are a canvas we draw, so reading it is exact. A user
 * image is redrawn small into an offscreen canvas: this is a mean over
 * regions, and 96x64 answers that exactly as well as 4K. A remote image
 * without CORS taints the canvas and throws on read — that returns null
 * rather than guessing.
 */
export async function readWallpaperPixels(kind: string, image: string | null): Promise<{ data: Uint8ClampedArray; width: number; height: number } | null> {
  if (kind === "image" && image) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          const off = document.createElement("canvas");
          off.width = 96;
          off.height = 64;
          const ctx = off.getContext("2d", { willReadFrequently: true });
          if (!ctx) return resolve(null);
          ctx.drawImage(img, 0, 0, off.width, off.height);
          resolve({ data: ctx.getImageData(0, 0, off.width, off.height).data, width: off.width, height: off.height });
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = image;
    });
  }
  // A shader wallpaper is a WebGL canvas: a 2D context cannot read it, and its
  // buffer is not preserved between frames. The renderer hands over a frame.
  if (isShaderWallpaper(kind)) return readShaderWallpaperPixels();
  const canvas = document.querySelector<HTMLCanvasElement>("canvas");
  if (!canvas || canvas.width === 0 || canvas.height === 0) return null;
  try {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    return { data: ctx.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, height: canvas.height };
  } catch {
    return null;
  }
}
