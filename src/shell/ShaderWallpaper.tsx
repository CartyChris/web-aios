"use client";

import { useEffect, useRef } from "react";
import { resolveTokens, useSettings } from "@/kernel/settings";
import { useCustomThemes } from "@/kernel/customthemes";
import {
  VERTEX_SHADER,
  backingSize,
  composeFragment,
  hexToLinear,
  linearLuminance,
  shaderRecipe,
} from "@/lib/wallpaper-shaders";

/* ────────────────────────────────────────────────────────────────────────────
   The WebGL2 renderer behind the shader wallpapers.

   The recipes and their node graph live in lib/wallpaper-shaders.ts. This
   file is only render-loop discipline, the part three.js gets right and a
   hand-rolled canvas usually does not:

   - devicePixelRatio capped, then scaled by the recipe (soft fields render at
     half resolution and let the compositor upscale), then clamped to a pixel
     budget — see backingSize().
   - Resize through a ResizeObserver, never per frame.
   - The loop stops outright when the tab is hidden, when the OS asks for
     reduced motion, or when animation is off in Settings — one static frame is
     drawn and nothing else runs.
   - No allocation per frame: uniforms are set from numbers held in a ref.
   - Every GL object is deleted on unmount, and a lost context is survived.
   - Colours are the resolved theme tokens, read from the store rather than
     from computed style, so they can never be one render stale.
   ──────────────────────────────────────────────────────────────────────────── */

interface Live {
  animate: boolean;
  /** bg, bg2, accent, accent2 — linear RGB, 12 floats. */
  colors: number[];
  dark: number;
}

type Snapshot = () => HTMLCanvasElement | null;
let activeSnapshot: Snapshot | null = null;

/** The live shader wallpaper's pixels, for the label-contrast sampler and
 *  "theme from wallpaper". A WebGL canvas cannot be read with a 2D context, and
 *  its drawing buffer is not preserved (preserving it costs a copy on every
 *  frame), so this renders one frame and copies it out in the same task,
 *  before the compositor gets a chance to clear it. */
export function readShaderWallpaperPixels(): { data: Uint8ClampedArray; width: number; height: number } | null {
  const src = activeSnapshot?.();
  if (!src || src.width === 0 || src.height === 0) return null;
  try {
    const off = document.createElement("canvas");
    off.width = 192;
    off.height = 120;
    const ctx = off.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(src, 0, 0, off.width, off.height);
    return { data: ctx.getImageData(0, 0, off.width, off.height).data, width: off.width, height: off.height };
  } catch {
    return null;
  }
}

/** Seconds of "virtual time" a static frame is drawn at. t = 0 is the least
 *  interesting moment of most recipes (every phase aligned). */
const STATIC_TIME = 23;

export function ShaderWallpaper({ kind, animate, blur }: { kind: string; animate: boolean; blur: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<Live>({ animate, colors: new Array(12).fill(0), dark: 1 });
  const pokeRef = useRef<(() => void) | null>(null);

  const themeId = useSettings((s) => s.themeId);
  const accent = useSettings((s) => s.accent);
  const accent2 = useSettings((s) => s.accent2);
  const customVars = useSettings((s) => s.customVars);
  const profileId = useSettings((s) => s.profileId);
  const generated = useCustomThemes((s) => s.themes);

  /* GL lifetime: one program per wallpaper kind. */
  useEffect(() => {
    const canvas = canvasRef.current;
    const recipe = shaderRecipe(kind);
    if (!canvas || !recipe) return;
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: "low-power",
    });
    // No WebGL2: the wrapper's CSS gradient stays visible, which is a
    // correct if plainer wallpaper rather than a black rectangle.
    if (!gl) {
      canvas.dataset.glError = "webgl2 unavailable";
      return;
    }

    const fragment = composeFragment(recipe);
    let program: WebGLProgram | null = null;
    let vs: WebGLShader | null = null;
    let fs: WebGLShader | null = null;
    let uRes: WebGLUniformLocation | null = null;
    let uTime: WebGLUniformLocation | null = null;
    let uBg: WebGLUniformLocation | null = null;
    let uBg2: WebGLUniformLocation | null = null;
    let uA1: WebGLUniformLocation | null = null;
    let uA2: WebGLUniformLocation | null = null;
    let uDark: WebGLUniformLocation | null = null;

    const compile = (type: number, source: string): WebGLShader | null => {
      const sh = gl.createShader(type);
      if (!sh) return null;
      gl.shaderSource(sh, source);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
        canvas.dataset.glError = gl.getShaderInfoLog(sh) || "compile failed";
        gl.deleteShader(sh);
        return null;
      }
      return sh;
    };

    const release = () => {
      if (program) gl.deleteProgram(program);
      if (vs) gl.deleteShader(vs);
      if (fs) gl.deleteShader(fs);
      program = vs = fs = null;
    };

    const init = (): boolean => {
      release();
      vs = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
      fs = compile(gl.FRAGMENT_SHADER, fragment);
      if (!vs || !fs) return false;
      program = gl.createProgram();
      if (!program) return false;
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
        canvas.dataset.glError = gl.getProgramInfoLog(program) || "link failed";
        release();
        return false;
      }
      uRes = gl.getUniformLocation(program, "u_res");
      uTime = gl.getUniformLocation(program, "u_time");
      uBg = gl.getUniformLocation(program, "u_bg");
      uBg2 = gl.getUniformLocation(program, "u_bg2");
      uA1 = gl.getUniformLocation(program, "u_a1");
      uA2 = gl.getUniformLocation(program, "u_a2");
      uDark = gl.getUniformLocation(program, "u_dark");
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      delete canvas.dataset.glError;
      canvas.dataset.glReady = "1";
      return true;
    };

    let ok = init();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    let raf = 0;
    let last = 0;
    let elapsed = STATIC_TIME;

    const resize = () => {
      const { width, height } = backingSize(canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio || 1, recipe.scale);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    };

    const render = () => {
      if (!ok || !program || gl.isContextLost()) return;
      const c = liveRef.current.colors;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(program);
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, elapsed);
      gl.uniform3f(uBg, c[0], c[1], c[2]);
      gl.uniform3f(uBg2, c[3], c[4], c[5]);
      gl.uniform3f(uA1, c[6], c[7], c[8]);
      gl.uniform3f(uA2, c[9], c[10], c[11]);
      gl.uniform1f(uDark, liveRef.current.dark);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const frame = (now: number) => {
      // Clamped so a long stall (debugger, a slow frame) does not jump the scene.
      elapsed += Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;
      render();
      raf = requestAnimationFrame(frame);
    };

    const shouldRun = () => ok && liveRef.current.animate && !reduce.matches && !document.hidden;

    const sync = () => {
      if (shouldRun()) {
        if (!raf) {
          last = performance.now();
          raf = requestAnimationFrame(frame);
        }
      } else {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        render();
      }
    };

    resize();
    render();
    sync();
    pokeRef.current = () => { render(); sync(); };

    const ro = new ResizeObserver(() => { resize(); render(); });
    ro.observe(canvas);
    const onVisibility = () => sync();
    document.addEventListener("visibilitychange", onVisibility);
    reduce.addEventListener("change", onVisibility);

    const onLost = (e: Event) => {
      e.preventDefault();
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      ok = false;
    };
    const onRestored = () => {
      program = vs = fs = null; // the old handles died with the context
      ok = init();
      resize();
      render();
      sync();
    };
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);

    const snapshot: Snapshot = () => {
      if (!ok) return null;
      render();
      return canvas;
    };
    activeSnapshot = snapshot;

    return () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      reduce.removeEventListener("change", onVisibility);
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      if (activeSnapshot === snapshot) activeSnapshot = null;
      pokeRef.current = null;
      if (!gl.isContextLost()) release();
    };
  }, [kind]);

  /* Theme and animation: update what the running loop reads, then poke it. */
  useEffect(() => {
    const tokens = resolveTokens(useSettings.getState());
    const bg = hexToLinear(tokens["--bg"] ?? "#07111f");
    const bg2 = hexToLinear(tokens["--bg2"] ?? "#132845");
    const a1 = hexToLinear(tokens["--accent"] ?? "#67e8f9");
    const a2 = hexToLinear(tokens["--accent2"] ?? "#8b5cf6");
    const live = liveRef.current;
    live.colors = [...bg, ...bg2, ...a1, ...a2];
    live.dark = linearLuminance(bg) < 0.18 ? 1 : 0;
    live.animate = animate;
    pokeRef.current?.();
  }, [kind, animate, themeId, accent, accent2, customVars, profileId, generated]);

  return (
    <canvas
      ref={canvasRef}
      data-wallpaper={kind}
      className="absolute inset-0 h-full w-full"
      style={{ filter: blur ? `blur(${blur}px)` : undefined }}
    />
  );
}
