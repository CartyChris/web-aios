"use client";

import { useEffect, useRef } from "react";
import { useSettings } from "@/kernel/settings";
import { isShaderWallpaper } from "@/lib/wallpaper-shaders";
import { ShaderWallpaper } from "./ShaderWallpaper";

/** Procedural wallpapers drawn on one canvas.
 *
 *  Everything derives from the live theme tokens, so changing the accent colour
 *  repaints the background too — the desktop never looks like two designs
 *  stapled together. The loop self-throttles: when animation is off it draws a
 *  single frame and stops, costing nothing. */
export function Wallpaper() {
  const kind = useSettings((s) => s.wallpaper);
  const image = useSettings((s) => s.wallpaperImage);
  const blur = useSettings((s) => s.wallpaperBlur);
  const dim = useSettings((s) => s.wallpaperDim);
  const animate = useSettings((s) => s.wallpaperAnimate);
  const motion = useSettings((s) => s.motion);
  const themeId = useSettings((s) => s.themeId);
  const accent = useSettings((s) => s.accent);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || kind === "image") return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const css = getComputedStyle(document.documentElement);
    const read = (n: string, fallback: string) => css.getPropertyValue(n).trim() || fallback;
    const bg = read("--bg", "#07111f");
    const bg2 = read("--bg2", "#132845");
    const a1 = read("--accent", "#67e8f9");
    const a2 = read("--accent2", "#8b5cf6");

    let w = 0;
    let h = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = () => {
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    // Deterministic field so a static frame looks identical across reloads.
    const rand = (() => {
      let seed = 1337;
      return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    })();
    const stars = Array.from({ length: 260 }, () => ({ x: rand(), y: rand(), r: rand() * 1.5 + 0.3, p: rand() * Math.PI * 2 }));
    const dots = Array.from({ length: 70 }, () => ({
      x: rand(), y: rand(), vx: (rand() - 0.5) * 0.0006, vy: (rand() - 0.5) * 0.0006, r: rand() * 2.4 + 0.8,
    }));

    const draw = (t: number) => {
      const time = animate && motion ? t / 1000 : 0;
      ctx.clearRect(0, 0, w, h);

      const grad = ctx.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, bg);
      grad.addColorStop(1, bg2);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      switch (kind) {
        case "mesh": {
          // Three drifting radial blobs — the classic "aurora mesh" look, but
          // cheap: additive fills, no per-pixel work.
          const blobs = [
            { c: a1, x: 0.25 + Math.sin(time * 0.11) * 0.16, y: 0.28 + Math.cos(time * 0.13) * 0.14, r: 0.62 },
            { c: a2, x: 0.76 + Math.cos(time * 0.09) * 0.14, y: 0.34 + Math.sin(time * 0.12) * 0.16, r: 0.58 },
            { c: a1, x: 0.5 + Math.sin(time * 0.07 + 2) * 0.22, y: 0.82 + Math.cos(time * 0.1) * 0.1, r: 0.7 },
          ];
          ctx.globalCompositeOperation = "lighter";
          for (const b of blobs) {
            const R = Math.max(w, h) * b.r;
            const g = ctx.createRadialGradient(b.x * w, b.y * h, 0, b.x * w, b.y * h, R);
            g.addColorStop(0, hexA(b.c, 0.42));
            g.addColorStop(0.45, hexA(b.c, 0.12));
            g.addColorStop(1, hexA(b.c, 0));
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, w, h);
          }
          ctx.globalCompositeOperation = "source-over";
          break;
        }
        case "stars": {
          for (const s of stars) {
            const tw = animate && motion ? 0.55 + 0.45 * Math.sin(time * 1.6 + s.p) : 0.8;
            ctx.fillStyle = hexA("#ffffff", tw * 0.85);
            ctx.beginPath();
            ctx.arc(s.x * w, s.y * h, s.r, 0, Math.PI * 2);
            ctx.fill();
          }
          const g = ctx.createRadialGradient(w * 0.5, h * 1.1, 0, w * 0.5, h * 1.1, h);
          g.addColorStop(0, hexA(a2, 0.3));
          g.addColorStop(1, hexA(a2, 0));
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, w, h);
          break;
        }
        case "grid": {
          const step = 42;
          const off = animate && motion ? (time * 14) % step : 0;
          ctx.strokeStyle = hexA(a1, 0.14);
          ctx.lineWidth = 1;
          ctx.beginPath();
          for (let x = -step + off; x < w + step; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
          for (let y = -step + off; y < h + step; y += step) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
          ctx.stroke();
          const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
          g.addColorStop(0, hexA(a2, 0.22));
          g.addColorStop(1, hexA(a2, 0));
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, w, h);
          break;
        }
        case "waves": {
          for (let i = 0; i < 6; i++) {
            const amp = 26 + i * 9;
            const yBase = h * (0.42 + i * 0.1);
            ctx.beginPath();
            ctx.moveTo(0, yBase);
            for (let x = 0; x <= w; x += 8) {
              const y = yBase + Math.sin(x / (150 + i * 26) + time * (0.25 + i * 0.05) + i) * amp;
              ctx.lineTo(x, y);
            }
            ctx.lineTo(w, h);
            ctx.lineTo(0, h);
            ctx.closePath();
            ctx.fillStyle = hexA(i % 2 ? a2 : a1, 0.07);
            ctx.fill();
          }
          break;
        }
        case "rings": {
          const cx = w * 0.5;
          const cy = h * 0.5;
          for (let i = 0; i < 26; i++) {
            const r = ((i * 46 + (animate && motion ? (time * 16) % 46 : 0)) % (Math.max(w, h) * 0.85)) + 8;
            ctx.strokeStyle = hexA(i % 2 ? a1 : a2, 0.1 * (1 - r / (Math.max(w, h) * 0.9)));
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.stroke();
          }
          break;
        }
        case "topo": {
          ctx.lineWidth = 1;
          for (let i = 0; i < 22; i++) {
            ctx.beginPath();
            const phase = i * 0.5 + time * 0.12;
            for (let x = 0; x <= w; x += 6) {
              const n = Math.sin(x / 190 + phase) * Math.cos(x / 77 - phase * 0.6) * 46;
              const y = (h / 22) * i + n;
              if (x === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            }
            ctx.strokeStyle = hexA(i % 3 === 0 ? a1 : a2, 0.14);
            ctx.stroke();
          }
          break;
        }
        case "particles": {
          for (const d of dots) {
            if (animate && motion) {
              d.x = (d.x + d.vx + 1) % 1;
              d.y = (d.y + d.vy + 1) % 1;
            }
            ctx.fillStyle = hexA(a1, 0.5);
            ctx.beginPath();
            ctx.arc(d.x * w, d.y * h, d.r, 0, Math.PI * 2);
            ctx.fill();
          }
          // Link nearby particles — the constellation effect, capped at a
          // modest radius so the cost stays O(n²) on a small n.
          ctx.lineWidth = 0.6;
          for (let i = 0; i < dots.length; i++) {
            for (let j = i + 1; j < dots.length; j++) {
              const dx = (dots[i].x - dots[j].x) * w;
              const dy = (dots[i].y - dots[j].y) * h;
              const dist = Math.hypot(dx, dy);
              if (dist < 130) {
                ctx.strokeStyle = hexA(a2, 0.16 * (1 - dist / 130));
                ctx.beginPath();
                ctx.moveTo(dots[i].x * w, dots[i].y * h);
                ctx.lineTo(dots[j].x * w, dots[j].y * h);
                ctx.stroke();
              }
            }
          }
          break;
        }
        case "noise": {
          ctx.globalAlpha = 0.05;
          for (let i = 0; i < 2600; i++) {
            ctx.fillStyle = i % 2 ? a1 : a2;
            ctx.fillRect(rand() * w, rand() * h, 2, 2);
          }
          ctx.globalAlpha = 1;
          break;
        }
        case "solid": {
          ctx.fillStyle = bg;
          ctx.fillRect(0, 0, w, h);
          break;
        }
        default:
          break; // "flat" is the base gradient already painted.
      }

      if (animate && motion && kind !== "solid" && kind !== "flat" && kind !== "noise") {
        rafRef.current = requestAnimationFrame(draw);
      }
    };

    rafRef.current = requestAnimationFrame(draw);
    const ro = new ResizeObserver(() => {
      resize();
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(draw);
    });
    ro.observe(canvas);
    return () => {
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
    };
  }, [kind, animate, motion, themeId, accent]);

  // z-0, not a negative index: the desktop root does not establish a stacking
  // context, so a negative z-index paints this canvas behind the body's own
  // background colour and the wallpaper vanishes entirely.
  return (
    <div className="absolute inset-0 z-0 overflow-hidden" aria-hidden>
      {kind === "image" && image ? (
        <div
          className="absolute inset-0 bg-cover bg-center"
          style={{ backgroundImage: `url(${image})`, filter: blur ? `blur(${blur}px)` : undefined, transform: blur ? "scale(1.06)" : undefined }}
        />
      ) : isShaderWallpaper(kind) ? (
        // Keyed by kind: a fresh canvas per shader, so no GL state from the
        // previous recipe can leak into the next one. The gradient underneath
        // is what shows if WebGL2 is unavailable or a shader fails to compile.
        <div className="absolute inset-0" style={{ background: "linear-gradient(135deg, var(--bg), var(--bg2))" }}>
          <ShaderWallpaper key={kind} kind={kind} animate={animate && motion} blur={blur} />
        </div>
      ) : (
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" style={{ filter: blur ? `blur(${blur}px)` : undefined }} />
      )}
      <div className="absolute inset-0" style={{ background: "#000", opacity: dim }} />
    </div>
  );
}

/** Accept #rgb, #rrggbb or an already-alpha colour and return rgba(). */
function hexA(hex: string, alpha: number): string {
  const h = hex.trim();
  if (h.startsWith("rgb")) return h.replace(/rgba?\(([^)]+)\)/, (_, inner) => `rgba(${inner.split(",").slice(0, 3).join(",")},${alpha})`);
  let c = h.replace("#", "");
  if (c.length === 3) c = c.split("").map((ch) => ch + ch).join("");
  const n = parseInt(c || "000000", 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
