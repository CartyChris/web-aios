"use client";

import { useEffect, useRef } from "react";
import { useSettings } from "@/kernel/settings";
import { useWM } from "@/kernel/wm";
import { bus } from "@/kernel/bus";
import { iconRadius, themeForHour, SOUND_SETS, type SoundEvent, type Tone } from "@/lib/customize";

/* The customizations that draw or play (rules and validation are in
   lib/customize.ts): window animation and icon shape as root attributes the
   CSS reads, a screen-effects overlay (grain, vignette, scanlines, tint), a
   cursor effect, interface sounds, and the day/night theme switch. Mounted
   once by each shell. Every overlay ignores the pointer. */

const GRAIN = `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 1 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>")`;

let audio: AudioContext | null = null;
function play(tones: Tone[], volume: number) {
  try {
    audio ??= new AudioContext();
    let at = audio.currentTime;
    for (const t of tones) {
      const osc = audio.createOscillator();
      const g = audio.createGain();
      osc.type = t.type;
      osc.frequency.setValueAtTime(t.freq, at);
      if (t.to) osc.frequency.exponentialRampToValueAtTime(t.to, at + t.ms / 1000);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, t.gain * volume), at + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, at + t.ms / 1000);
      osc.connect(g).connect(audio.destination);
      osc.start(at);
      osc.stop(at + t.ms / 1000 + 0.02);
      at += t.ms / 1000 * 0.8;
    }
  } catch { /* no audio: silence is the fallback */ }
}

export function CustomizeLayer() {
  const c = useSettings((s) => s.customize);
  const themeId = useSettings((s) => s.themeId);
  const motion = useSettings((s) => s.motion);
  const canvas = useRef<HTMLCanvasElement>(null);

  // Window animation and icon shape: attributes and a variable the CSS reads.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.windowAnim = c.windowAnim;
    root.style.setProperty("--os-icon-radius", iconRadius(c.iconShape));
  }, [c.windowAnim, c.iconShape]);

  // Sounds on window open/close, notifications and (for "click") button presses.
  useEffect(() => {
    if (c.uiSounds === "off") return;
    const set = SOUND_SETS[c.uiSounds];
    const fire = (e: SoundEvent) => play(set[e], c.uiVolume);
    let count = useWM.getState().windows.length;
    const unsubWm = useWM.subscribe((s) => {
      if (s.windows.length > count) fire("open");
      else if (s.windows.length < count) fire("close");
      count = s.windows.length;
    });
    const offNotify = bus.on("notify", (p) => fire((p as { kind?: string })?.kind === "error" ? "error" : "notify"));
    const onDown = (e: PointerEvent) => { if ((e.target as HTMLElement)?.closest?.("button")) fire("click"); };
    window.addEventListener("pointerdown", onDown, true);
    return () => { unsubWm(); offNotify(); window.removeEventListener("pointerdown", onDown, true); };
  }, [c.uiSounds, c.uiVolume]);

  // Day/night: checked now and every minute.
  useEffect(() => {
    if (!c.autoTheme.on) return;
    const check = () => {
      const want = themeForHour(new Date().getHours(), c.autoTheme);
      if (want !== useSettings.getState().themeId) useSettings.getState().applyTheme(want);
    };
    check();
    const t = setInterval(check, 60_000);
    return () => clearInterval(t);
  }, [c.autoTheme, themeId]);

  // Cursor effect: one canvas, drawn only while there is something to draw.
  useEffect(() => {
    const cv = canvas.current;
    if (!cv || c.cursorFx === "off" || !motion || matchMedia("(pointer: coarse)").matches) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    // Hex only: the alpha is appended as two more hex digits.
    const accent = () => { const a = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(); return /^#[0-9a-f]{6}$/i.test(a) ? a : "#67e8f9"; };
    let color = accent();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const size = () => { cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); color = accent(); };
    size();
    const trail: Array<{ x: number; y: number; t: number }> = [];
    let x = -999, y = -999, raf = 0, last = 0;
    const draw = (now: number) => {
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      if (c.cursorFx === "glow") {
        const g = ctx.createRadialGradient(x, y, 0, x, y, 90);
        g.addColorStop(0, `${color}55`);
        g.addColorStop(1, `${color}00`);
        ctx.fillStyle = g;
        ctx.fillRect(x - 90, y - 90, 180, 180);
      } else if (c.cursorFx === "spotlight") {
        ctx.fillStyle = "rgba(0,0,0,0.45)";
        ctx.fillRect(0, 0, innerWidth, innerHeight);
        ctx.globalCompositeOperation = "destination-out";
        const g = ctx.createRadialGradient(x, y, 40, x, y, 220);
        g.addColorStop(0, "rgba(0,0,0,1)");
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, innerWidth, innerHeight);
        ctx.globalCompositeOperation = "source-over";
      } else {
        while (trail.length && now - trail[0].t > 450) trail.shift();
        for (const p of trail) {
          const a = 1 - (now - p.t) / 450;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 2 + a * 5, 0, Math.PI * 2);
          ctx.fillStyle = `${color}${Math.round(a * 180).toString(16).padStart(2, "0")}`;
          ctx.fill();
        }
      }
      // Keep drawing while the trail fades; otherwise stop until the pointer moves.
      raf = c.cursorFx === "trail" && trail.length ? requestAnimationFrame(draw) : 0;
    };
    const onMove = (e: PointerEvent) => {
      x = e.clientX; y = e.clientY;
      if (c.cursorFx === "trail" && e.timeStamp - last > 12) { trail.push({ x, y, t: performance.now() }); last = e.timeStamp; }
      if (!raf) raf = requestAnimationFrame(draw);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("resize", size);
    return () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("resize", size); cancelAnimationFrame(raf); ctx.clearRect(0, 0, innerWidth, innerHeight); };
  }, [c.cursorFx, motion, themeId]);

  const fx = c.screenFx;
  return (
    <>
      {c.cursorFx !== "off" && <canvas ref={canvas} className="pointer-events-none fixed inset-0 z-[7990] h-full w-full" aria-hidden data-cursor-fx={c.cursorFx} />}
      {(fx.grain > 0 || fx.vignette > 0 || fx.scanlines || fx.tint) && (
        <div className="pointer-events-none fixed inset-0 z-[7980]" aria-hidden data-screen-fx>
          {fx.tint && <div className="absolute inset-0" style={{ background: fx.tint, mixBlendMode: "soft-light", opacity: 0.35 }} />}
          {fx.grain > 0 && <div className="absolute inset-0" style={{ backgroundImage: GRAIN, opacity: fx.grain * 0.35, mixBlendMode: "overlay" }} />}
          {fx.scanlines && <div className="absolute inset-0" style={{ backgroundImage: "repeating-linear-gradient(to bottom, rgba(0,0,0,0.18) 0 1px, transparent 1px 3px)" }} />}
          {fx.vignette > 0 && <div className="absolute inset-0" style={{ background: `radial-gradient(ellipse at center, transparent 45%, rgba(0,0,0,${0.85 * fx.vignette}) 100%)` }} />}
        </div>
      )}
    </>
  );
}
