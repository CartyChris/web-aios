"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAssets, type Asset, type AssetPart } from "./Assets";
import { useVFS } from "@/kernel/vfs";
import { bus } from "@/kernel/bus";
import type { AppProps } from "@/kernel/types";
import { uid, download } from "@/lib/format";
import { ask } from "@/lib/useAI";
import { Tabs, Empty, ErrorNote, CopyButton, Spinner, Markdown } from "./_ui";
import { FORGE_KINDS, getForgeKind, extractJson } from "@/lib/forge-schema";
import {
  makeProjector, partFaces, lightAt, stepParticles, hexToRgb, rgbCss, shade,
  type Light, type Emitter, type Particle, type Camera, type Vec3, type Face,
} from "@/lib/forge-render";
import { cn } from "@/lib/cn";
import { Icon } from "@/shell/icons";

/* ────────────────────────────────────────────────────────────────────────────
   Forge 3D.

   A world editor where the model builds and then *looks at what it built*.

   Two things make this more than a prompt box bolted to a scene graph:

   - Real lighting. Every face carries a true normal and is shaded by the
     actual light set, so "make it moonlit with a fire on the left" changes the
     picture rather than a slider. Particles are a real CPU system, so fire
     layers and drifts the way fire does.
   - Vision. The viewport renders to a PNG and goes back to the model as an
     image. A model describing a scene from JSON is guessing at what it looks
     like; a model looking at the render can see that the roof floats, that
     everything is the same shade of grey, that the composition is flat. That
     is the difference between generating a scene and art-directing one.

   The render loop never touches React state. It reads refs and draws. The
   previous version called setScene() from inside draw() to advance physics,
   which re-rendered the whole app on every simulated frame and tore down the
   loop's own effect — the single biggest cost in this file, now gone.
   ──────────────────────────────────────────────────────────────────────────── */

export interface Entity {
  id: string;
  name: string;
  assetId: string | null;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  visible: boolean;
  parts: AssetPart[];
  physics?: Asset["physics"];
}

export interface Scene {
  name: string;
  entities: Entity[];
  lights: Light[];
  fx: Emitter[];
  gravity: number;
  ambient: number;
  sky: string;
}

const DEFAULT_LIGHTS: Light[] = [
  { id: "key", name: "Key (sun)", kind: "directional", position: [-0.6, 1.4, 0.8], color: "#fff4e0", intensity: 1.05, range: 0, on: true },
  { id: "fill", name: "Sky fill", kind: "directional", position: [0.7, 0.5, -0.9], color: "#8fb8ff", intensity: 0.38, range: 0, on: true },
];

const BLANK: Scene = {
  name: "Untitled scene",
  entities: [],
  lights: DEFAULT_LIGHTS.map((l) => ({ ...l })),
  fx: [],
  gravity: -9.81,
  ambient: 0.32,
  sky: "#0b1a2e",
};

/** Normalise whatever a model returned into an Entity we can actually draw.
 *  Every field is defaulted, because one missing `scale` should not throw away
 *  a scene that is otherwise perfectly good. */
function toEntity(raw: unknown): Entity | null {
  const e = raw as Partial<Entity> & { parts?: unknown };
  if (!e || !Array.isArray(e.parts) || e.parts.length === 0) return null;
  const v3 = (v: unknown, d: Vec3): Vec3 =>
    Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n)) ? (v as Vec3) : d;
  return {
    id: uid("ent"),
    name: typeof e.name === "string" ? e.name : "Object",
    assetId: null,
    position: v3(e.position, [0, 0, 0]),
    rotation: v3(e.rotation, [0, 0, 0]),
    scale: v3(e.scale, [1, 1, 1]),
    visible: true,
    physics: e.physics,
    parts: (e.parts as AssetPart[])
      .filter((p) => p && typeof p === "object")
      .map((p, i) => ({
        id: p.id ?? `p${i}`,
        name: p.name ?? `Part ${i + 1}`,
        shape: p.shape ?? "box",
        position: v3(p.position, [0, 0, 0]),
        rotation: p.rotation,
        scale: v3(p.scale, [1, 1, 1]),
        color: typeof p.color === "string" ? p.color : "#8b8b95",
        roughness: p.roughness,
        metalness: p.metalness,
        emissive: p.emissive,
      })),
  };
}

function toLight(raw: unknown): Light | null {
  const l = raw as Partial<Light>;
  if (!l || !Array.isArray(l.position) || l.position.length !== 3) return null;
  return {
    id: uid("lt"),
    name: typeof l.name === "string" ? l.name : "Light",
    kind: l.kind === "point" ? "point" : "directional",
    position: l.position as Vec3,
    color: typeof l.color === "string" ? l.color : "#ffffff",
    intensity: typeof l.intensity === "number" ? Math.max(0, Math.min(4, l.intensity)) : 1,
    range: typeof l.range === "number" ? l.range : 12,
    on: true,
  };
}

function toEmitter(raw: unknown): Emitter | null {
  const e = raw as Partial<Emitter>;
  if (!e || !Array.isArray(e.position) || e.position.length !== 3) return null;
  const num = (v: unknown, d: number, lo: number, hi: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;
  return {
    id: uid("fx"),
    name: typeof e.name === "string" ? e.name : "Emitter",
    position: e.position as Vec3,
    color: typeof e.color === "string" ? e.color : "#ffb347",
    color2: typeof e.color2 === "string" ? e.color2 : "#4a2010",
    // Clamped, not trusted: a model that writes rate 100000 should produce a
    // busy effect, not a locked-up tab.
    rate: num(e.rate, 30, 1, 200),
    life: num(e.life, 1.4, 0.1, 10),
    speed: num(e.speed, 1.6, 0, 20),
    spread: num(e.spread, 0.35, 0, 1),
    size: num(e.size, 0.12, 0.01, 1.5),
    gravity: num(e.gravity, 0.6, -30, 30),
    blend: e.blend === "normal" ? "normal" : "add",
    on: true,
  };
}

export default function Forge3D({ args }: AppProps) {
  const assets = useAssets();
  const vfs = useVFS();
  const [scene, setScene] = useState<Scene>(BLANK);
  const [sel, setSel] = useState<string | null>(null);
  const [tab, setTab] = useState("forge");
  const [error, setError] = useState<string | null>(null);
  const [cam, setCam] = useState<Camera>({ yaw: 0.7, pitch: 0.55, zoom: 46, panX: 0, panY: 0 });
  const [playing, setPlaying] = useState(false);
  const [showFx, setShowFx] = useState(true);
  const [fps, setFps] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ x: number; y: number; yaw: number; pitch: number; pan: boolean; panX: number; panY: number } | null>(null);

  // Everything the render loop reads lives in a ref. The loop is started once
  // and never restarted, so orbiting the camera costs one frame of drawing
  // rather than a React render plus an effect teardown.
  const sceneRef = useRef(scene);
  const camRef = useRef(cam);
  const selRef = useRef(sel);
  const playRef = useRef(playing);
  const fxRef = useRef(showFx);
  const particles = useRef<Particle[]>([]);
  const velocities = useRef<Map<string, number>>(new Map());
  const simY = useRef<Map<string, number>>(new Map());

  // Written after render rather than during it. Assigning a ref in the render
  // body is a concurrent-rendering hazard — React may render a component it
  // then throws away, and the loop would draw from state that never committed.
  useEffect(() => {
    sceneRef.current = scene;
    camRef.current = cam;
    selRef.current = sel;
    playRef.current = playing;
    fxRef.current = showFx;
  });

  const spawn = useCallback((assetId: string) => {
    const a = assets.assets.find((x) => x.id === assetId);
    if (!a) return;
    const e: Entity = {
      id: uid("ent"), name: a.name, assetId: a.id,
      position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
      visible: true, parts: a.parts, physics: a.physics,
    };
    setScene((s) => ({ ...s, entities: [...s.entities, e] }));
    setSel(e.id);
  }, [assets.assets]);

  // Asset Studio can launch us with something to place; do it once.
  const spawnArg = args?.spawnAsset as string | undefined;
  const [spawnedArg, setSpawnedArg] = useState<string | undefined>(undefined);
  if (spawnArg && spawnArg !== spawnedArg) {
    setSpawnedArg(spawnArg);
    spawn(spawnArg);
  }

  const entity = scene.entities.find((e) => e.id === sel) ?? null;

  const patch = useCallback((id: string, p: Partial<Entity>) => {
    setScene((s) => ({ ...s, entities: s.entities.map((e) => (e.id === id ? { ...e, ...p } : e)) }));
  }, []);

  /* ── Render loop ───────────────────────────────────────────────────────── */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const g = canvas.getContext("2d", { alpha: false });
    if (!g) return;

    let raf = 0;
    let last = performance.now();
    let frames = 0, fpsClock = last;

    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      frames++;
      if (now - fpsClock > 500) { setFps(Math.round((frames * 1000) / (now - fpsClock))); frames = 0; fpsClock = now; }

      const s = sceneRef.current;
      const c = camRef.current;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr; canvas.height = h * dpr;
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);

      const project = makeProjector(c, w, h);
      const lights = s.lights.filter((l) => l.on !== false);

      // Sky
      const grad = g.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, s.sky);
      grad.addColorStop(1, shade(s.sky, -0.5));
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);

      // Ground grid
      g.strokeStyle = "rgba(255,255,255,0.075)";
      g.lineWidth = 1;
      const N = 14;
      g.beginPath();
      for (let i = -N; i <= N; i++) {
        const a = project(i, 0, -N), b = project(i, 0, N);
        const p = project(-N, 0, i), q = project(N, 0, i);
        g.moveTo(a.x, a.y); g.lineTo(b.x, b.y);
        g.moveTo(p.x, p.y); g.lineTo(q.x, q.y);
      }
      g.stroke();

      for (const [axis, color] of [[[1, 0, 0], "#ff5f57"], [[0, 1, 0], "#28c840"], [[0, 0, 1], "#60a5fa"]] as const) {
        const o = project(0, 0, 0);
        const p = project(axis[0] * 3, axis[1] * 3, axis[2] * 3);
        g.strokeStyle = color; g.lineWidth = 1.5;
        g.beginPath(); g.moveTo(o.x, o.y); g.lineTo(p.x, p.y); g.stroke();
      }

      // Physics runs into a ref, not into state — that is what keeps this loop
      // independent of React. It is committed back to the scene on stop.
      if (playRef.current) {
        for (const e of s.entities) {
          if (e.physics?.bodyType !== "dynamic") continue;
          const y0 = simY.current.get(e.id) ?? e.position[1];
          let v = (velocities.current.get(e.id) ?? 0) + s.gravity * dt;
          let y = y0 + v * dt;
          if (y <= 0) { y = 0; v = -v * (e.physics.restitution ?? 0); if (Math.abs(v) < 0.3) v = 0; }
          velocities.current.set(e.id, v);
          simY.current.set(e.id, y);
        }
      }

      // Faces, painter's algorithm.
      const faces: Array<Face & { selected: boolean }> = [];
      for (const e of s.entities) {
        if (!e.visible) continue;
        const y = playRef.current ? simY.current.get(e.id) ?? e.position[1] : e.position[1];
        const origin: Vec3 = [e.position[0], y, e.position[2]];
        const selected = e.id === selRef.current;
        for (const part of e.parts) {
          for (const f of partFaces(part, origin, e.scale, project)) faces.push({ ...f, selected });
        }
      }
      faces.sort((a, b) => a.depth - b.depth);

      for (const f of faces) {
        const [lr, lg, lb] = lightAt(f.normal, f.cx, f.cy, f.cz, lights, s.ambient);
        const [br, bg, bb] = hexToRgb(f.color);
        g.beginPath();
        g.moveTo(f.pts[0].x, f.pts[0].y);
        for (let i = 1; i < f.pts.length; i++) g.lineTo(f.pts[i].x, f.pts[i].y);
        g.closePath();
        g.fillStyle = rgbCss(br * lr, bg * lg, bb * lb);
        g.fill();
        if (f.emissive) {
          const [er, eg, eb] = hexToRgb(f.emissive);
          g.globalAlpha = 0.4;
          g.fillStyle = rgbCss(er, eg, eb);
          g.fill();
          g.globalAlpha = 1;
        }
        g.strokeStyle = f.selected ? "#67e8f9" : "rgba(0,0,0,0.3)";
        g.lineWidth = f.selected ? 1.8 : 0.5;
        g.stroke();
      }

      // Light gizmos, so a light you cannot see is still a thing you can find.
      for (const l of s.lights) {
        const p = l.kind === "point" ? project(...l.position) : project(l.position[0] * 5, l.position[1] * 5, l.position[2] * 5);
        g.beginPath();
        g.arc(p.x, p.y, 5, 0, Math.PI * 2);
        g.fillStyle = l.on === false ? "rgba(128,128,128,0.4)" : l.color;
        g.fill();
        g.strokeStyle = "rgba(0,0,0,0.5)";
        g.lineWidth = 1;
        g.stroke();
      }

      // Particles
      if (fxRef.current && s.fx.length) {
        const pool = stepParticles(particles.current, s.fx, dt);
        const drawn = pool
          .map((p) => ({ p, s: project(p.x, p.y, p.z) }))
          .sort((a, b) => a.s.depth - b.s.depth);
        for (const { p, s: ps } of drawn) {
          const e = s.fx[p.emitter];
          if (!e) continue;
          const t = p.age / p.life;
          const [r1, g1, b1] = hexToRgb(e.color);
          const [r2, g2, b2] = hexToRgb(e.color2);
          g.globalCompositeOperation = e.blend === "add" ? "lighter" : "source-over";
          g.globalAlpha = Math.max(0, 1 - t) * (e.blend === "add" ? 0.85 : 0.6);
          g.fillStyle = rgbCss(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
          g.beginPath();
          g.arc(ps.x, ps.y, Math.max(0.6, e.size * c.zoom * (1 - t * 0.4)), 0, Math.PI * 2);
          g.fill();
        }
        g.globalAlpha = 1;
        g.globalCompositeOperation = "source-over";
      } else if (particles.current.length) {
        particles.current.length = 0;
      }

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  /** Commit the simulation back into the scene when play stops, so what you
   *  see is what you then edit. */
  const togglePlay = useCallback(() => {
    if (playing) {
      setScene((s) => ({
        ...s,
        entities: s.entities.map((e) => {
          const y = simY.current.get(e.id);
          return y === undefined ? e : { ...e, position: [e.position[0], y, e.position[2]] as Vec3 };
        }),
      }));
    }
    velocities.current.clear();
    simY.current.clear();
    setPlaying((p) => !p);
  }, [playing]);

  /* ── Vision capture ────────────────────────────────────────────────────── */

  /** The viewport as a PNG a vision model can look at.
   *
   *  Downscaled to 896px: image tokens scale with area, and nothing in this
   *  renderer carries detail that survives past that anyway. */
  const capture = useCallback((max = 896): string | null => {
    const src = canvasRef.current;
    if (!src || !src.width) return null;
    const scale = Math.min(1, max / Math.max(src.width, src.height));
    const off = document.createElement("canvas");
    off.width = Math.round(src.width * scale);
    off.height = Math.round(src.height * scale);
    const g = off.getContext("2d");
    if (!g) return null;
    g.drawImage(src, 0, 0, off.width, off.height);
    return off.toDataURL("image/png");
  }, []);

  const exportScene = useCallback(() => JSON.stringify({ __forge3d: 2, scene }, null, 2), [scene]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border)] px-2.5 py-1.5">
        <input value={scene.name} onChange={(e) => setScene((s) => ({ ...s, name: e.target.value }))} className="os-input !w-40 !py-1 text-[12px] font-medium" />
        <button className={cn("os-btn !py-1 text-[11px]", playing && "!border-[var(--accent)] !bg-[var(--accent)]/16")} onClick={togglePlay}>
          <Icon name={playing ? "stop" : "play"} size={11} className="mr-1" />{playing ? "Stop" : "Play"}
        </button>
        <button className={cn("os-btn !py-1 text-[11px]", showFx && scene.fx.length > 0 && "!border-[var(--accent)]")} onClick={() => setShowFx((v) => !v)} title="Toggle particle effects">
          <Icon name="sparkles" size={11} className="mr-1" />FX
        </button>
        <button className="os-btn !py-1 text-[11px]" onClick={() => setCam({ yaw: 0.7, pitch: 0.55, zoom: 46, panX: 0, panY: 0 })}>Reset view</button>
        <div className="flex-1" />
        <span className="os-chip tabular-nums" title="Render loop frame rate">{fps} fps</span>
        <span className="os-chip">{scene.entities.length} obj · {scene.lights.length} lights · {scene.fx.length} fx</span>
        <button className="os-btn !py-1 text-[11px]" onClick={() => { vfs.write(`/scenes/${scene.name.replace(/\s+/g, "_")}.json`, exportScene(), { appId: "forge3d" }); bus.emit("notify", { title: "Scene saved to Files", kind: "success" }); }}>Save</button>
        <button className="os-btn !py-1 text-[11px]" onClick={() => download(`${scene.name.replace(/\s+/g, "_")}.json`, exportScene(), "application/json")}>Export</button>
        <label className="os-btn !py-1 text-[11px]">
          Import
          <input
            type="file" accept="application/json" hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              try {
                const parsed = JSON.parse(await f.text());
                const sc = parsed.scene ?? parsed;
                if (!Array.isArray(sc.entities)) throw new Error("No entities array found.");
                setScene({ ...BLANK, ...sc, lights: sc.lights ?? DEFAULT_LIGHTS, fx: sc.fx ?? [] });
              } catch (err) { setError(err instanceof Error ? err.message : "Import failed."); }
              e.target.value = "";
            }}
          />
        </label>
      </div>

      <div className="px-2.5 pt-2"><ErrorNote error={error} onDismiss={() => setError(null)} /></div>

      <div className="app-split flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <canvas
            ref={canvasRef}
            className="h-full w-full cursor-grab touch-none active:cursor-grabbing"
            onPointerDown={(e) => {
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              dragRef.current = { x: e.clientX, y: e.clientY, yaw: cam.yaw, pitch: cam.pitch, pan: e.shiftKey || e.button === 1, panX: cam.panX, panY: cam.panY };
            }}
            onPointerMove={(e) => {
              const d = dragRef.current;
              if (!d) return;
              if (d.pan) setCam((c) => ({ ...c, panX: d.panX + (e.clientX - d.x), panY: d.panY + (e.clientY - d.y) }));
              else setCam((c) => ({ ...c, yaw: d.yaw + (e.clientX - d.x) * 0.008, pitch: Math.max(0.05, Math.min(1.45, d.pitch + (e.clientY - d.y) * 0.006)) }));
            }}
            onPointerUp={() => (dragRef.current = null)}
            onWheel={(e) => setCam((c) => ({ ...c, zoom: Math.max(8, Math.min(180, c.zoom * (e.deltaY > 0 ? 0.92 : 1.08))) }))}
          />
          <div className="pointer-events-none absolute bottom-2 left-2 rounded px-2 py-1 text-[10px] text-[var(--muted)]" style={{ background: "color-mix(in srgb, var(--bg) 70%, transparent)" }}>
            drag orbit · shift-drag pan · scroll zoom
          </div>
        </div>

        <div className="app-aside flex w-72 shrink-0 flex-col border-l border-[var(--border)]">
          <Tabs
            tabs={[
              { id: "forge", label: "Forge", icon: "wand" },
              { id: "scene", label: "Scene", icon: "layers" },
              { id: "light", label: "Light", icon: "spark" },
              { id: "props", label: "Inspect", icon: "tune" },
            ]}
            active={tab}
            onChange={setTab}
          />
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {tab === "forge" && <ForgePanel scene={scene} setScene={setScene} setSel={setSel} setError={setError} capture={capture} />}

            {tab === "scene" && (
              <>
                {scene.entities.length === 0 && <div className="py-6 text-center text-[11px] text-[var(--muted)]">Empty scene. Describe something on the Forge tab, or drop in an asset.</div>}
                {scene.entities.map((e) => (
                  <div key={e.id} className={cn("mb-0.5 flex items-center gap-1.5 rounded px-2 py-1", sel === e.id ? "bg-[var(--accent)]/16" : "hover:bg-white/6")}>
                    <button onClick={() => patch(e.id, { visible: !e.visible })} className="opacity-70" title={e.visible ? "Hide" : "Show"}>
                      <Icon name={e.visible ? "eye" : "eyeoff"} size={11} />
                    </button>
                    <button onClick={() => { setSel(e.id); setTab("props"); }} className="min-w-0 flex-1 truncate text-left text-[11.5px]">{e.name}</button>
                    <span className="shrink-0 text-[9px] text-[var(--muted)]">{e.parts.length}</span>
                    <button className="opacity-50 hover:opacity-100" onClick={() => { setScene((s) => ({ ...s, entities: s.entities.filter((x) => x.id !== e.id) })); if (sel === e.id) setSel(null); }}>
                      <Icon name="close" size={11} />
                    </button>
                  </div>
                ))}

                <div className="mt-3 border-t border-[var(--border)] pt-2">
                  <div className="os-label mb-1.5">Asset Studio</div>
                  {assets.assets.length === 0 ? (
                    <div className="text-[11px] text-[var(--muted)]">No assets yet.</div>
                  ) : (
                    <div className="grid grid-cols-3 gap-1">
                      {assets.assets.slice(0, 12).map((a) => (
                        <button key={a.id} onClick={() => spawn(a.id)} className="os-card !p-1.5 text-center" title={`Place ${a.name}`}>
                          <Icon name={a.icon || "assets"} size={16} style={{ color: "var(--accent)" }} />
                          <div className="truncate text-[9.5px]">{a.name}</div>
                        </button>
                      ))}
                    </div>
                  )}
                  <button className="os-btn mt-1.5 w-full !py-1 text-[11px]" onClick={() => bus.emit("app:open", { appId: "assets" })}>
                    Open Asset Studio
                  </button>
                </div>
              </>
            )}

            {tab === "light" && <LightPanel scene={scene} setScene={setScene} />}

            {tab === "props" && (
              !entity ? (
                <Empty icon="search" title="Nothing selected" body="Pick an object on the Scene tab." />
              ) : (
                <>
                  <input value={entity.name} onChange={(e) => patch(entity.id, { name: e.target.value })} className="os-input mb-2 !py-1 text-[12px] font-medium" />
                  {(["position", "rotation", "scale"] as const).map((field) => (
                    <div key={field} className="mb-2">
                      <div className="os-label mb-1">{field}</div>
                      <div className="flex gap-1">
                        {[0, 1, 2].map((axis) => (
                          <input
                            key={axis} type="number" step={field === "scale" ? 0.1 : 0.25}
                            value={entity[field][axis]}
                            onChange={(ev) => { const v = [...entity[field]] as Vec3; v[axis] = Number(ev.target.value); patch(entity.id, { [field]: v }); }}
                            className="os-input !py-1 text-[11px]"
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                  <div className="mb-2 text-[11px] text-[var(--muted)]">
                    {entity.parts.length} part{entity.parts.length === 1 ? "" : "s"} · {entity.physics?.bodyType ?? "no physics"}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <button
                      className="os-btn !px-2 !py-0.5 text-[10.5px]"
                      onClick={() => {
                        const c: Entity = { ...entity, id: uid("ent"), position: [entity.position[0] + 1.5, entity.position[1], entity.position[2]] };
                        setScene((s) => ({ ...s, entities: [...s.entities, c] }));
                        setSel(c.id);
                      }}
                    >
                      Duplicate
                    </button>
                    <button
                      className="os-btn !px-2 !py-0.5 text-[10.5px]"
                      title="Save this object to Asset Studio so you can reuse it"
                      onClick={() => {
                        assets.add({
                          id: uid("asset"), name: entity.name, kind: "prop", icon: "assets", tags: ["forge"],
                          physics: entity.physics ?? { bodyType: "static", collider: "box", mass: 0, friction: 0.6, restitution: 0.1, solid: true },
                          parts: entity.parts, updatedAt: Date.now(),
                        });
                        bus.emit("notify", { title: `"${entity.name}" saved to Asset Studio`, kind: "success" });
                      }}
                    >
                      Save as asset
                    </button>
                    <CopyButton text={JSON.stringify(entity, null, 2)} label="Copy" className="!px-2 !py-0.5 !text-[10.5px]" />
                  </div>
                </>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   The Forge panel — build with a model, then let it look
   ══════════════════════════════════════════════════════════════════════════ */

function ForgePanel({ scene, setScene, setSel, setError, capture }: {
  scene: Scene;
  setScene: React.Dispatch<React.SetStateAction<Scene>>;
  setSel: (id: string | null) => void;
  setError: (e: string | null) => void;
  capture: (max?: number) => string | null;
}) {
  const [kindId, setKindId] = useState("asset");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [critique, setCritique] = useState<string | null>(null);
  const [shot, setShot] = useState<string | null>(null);
  const [reference, setReference] = useState<string | null>(null);
  const kind = getForgeKind(kindId);

  /** A compact text description of what is already in the scene. Sent
   *  alongside the render so the model can reason about names and numbers as
   *  well as pixels — it cannot read a coordinate off an image. */
  const sceneSummary = useCallback(() => JSON.stringify({
    sky: scene.sky,
    ambient: scene.ambient,
    lights: scene.lights.map(({ name, kind: k, position, color, intensity, range }) => ({ name, kind: k, position, color, intensity, range })),
    entities: scene.entities.map((e) => ({ name: e.name, position: e.position, scale: e.scale, parts: e.parts.length })),
    fx: scene.fx.map((f) => ({ name: f.name, position: f.position, blend: f.blend })),
  }), [scene]);

  /** Merge whatever the model returned into the scene.
   *
   *  Counting happens before the update rather than inside it: a state updater
   *  must be pure, and one that also increments a variable outside itself runs
   *  twice in development and reports double. */
  const applyResult = useCallback((data: unknown) => {
    const d = data as { entities?: unknown[]; lights?: unknown[]; fx?: unknown[]; sky?: string; ambient?: number };
    const ents = Array.isArray(d.entities) ? d.entities.map(toEntity).filter((e): e is Entity => !!e) : [];
    const lts = Array.isArray(d.lights) ? d.lights.map(toLight).filter((l): l is Light => !!l) : [];
    const ems = Array.isArray(d.fx) ? d.fx.map(toEmitter).filter((e): e is Emitter => !!e) : [];
    const added = ents.length + lts.length + ems.length;

    setScene((s) => ({
      ...s,
      // A map replaces the world; a single object joins it.
      entities: ents.length ? (kindId === "map" ? ents : [...s.entities, ...ents]) : s.entities,
      lights: lts.length ? lts : s.lights,
      fx: ems.length ? (kindId === "fx" ? [...s.fx, ...ems] : ems) : s.fx,
      sky: typeof d.sky === "string" && /^#[0-9a-f]{6}$/i.test(d.sky) ? d.sky : s.sky,
      ambient: typeof d.ambient === "number" ? Math.max(0, Math.min(1, d.ambient)) : s.ambient,
    }));
    if (ents.length) setSel(ents[ents.length - 1].id);

    if (added === 0) setError("The reply parsed, but contained nothing this scene can use. Try again, or pick a stronger model.");
    else bus.emit("notify", { title: `Added ${added} item${added === 1 ? "" : "s"}`, kind: "success" });
  }, [kindId, setScene, setSel, setError]);

  const build = useCallback(async () => {
    if (!prompt.trim() || busy) return;
    setBusy("build"); setError(null); setCritique(null);
    try {
      const needsScene = kindId === "lighting" || kindId === "fx";
      const content: Parameters<typeof ask>[0]["messages"][number]["content"] = reference
        ? [
            { type: "text", text: `${prompt}\n\nMatch the reference image: its subject, palette, mood and proportions.${needsScene ? `\n\nCurrent scene:\n${sceneSummary()}` : ""}` },
            { type: "image", dataUrl: reference },
          ]
        : `${prompt}${needsScene ? `\n\nCurrent scene:\n${sceneSummary()}` : ""}`;

      const res = await ask({ messages: [{ role: "user", content }], system: kind.brief, maxTokens: 16000 });
      applyResult(extractJson(res.text));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Generation failed.");
    } finally { setBusy(null); }
  }, [prompt, busy, kind, kindId, reference, sceneSummary, setError, applyResult]);

  /* ── Vision ────────────────────────────────────────────────────────────── */

  const look = useCallback(async (andFix: boolean) => {
    if (busy) return;
    const png = capture();
    if (!png) { setError("Could not read the viewport."); return; }
    setShot(png);
    setBusy(andFix ? "fix" : "look"); setError(null); setCritique(null);
    try {
      const res = await ask({
        maxTokens: andFix ? 16000 : 700,
        system: andFix
          ? `You are an art director with the power to edit the scene. You are shown a render of a 3D scene and its data.

First, look at the image and find what is actually wrong: objects floating or sunk into the ground, wrong relative scale, a flat or muddy palette, everything at one height, lighting with no direction, an empty composition.

Then fix it. Return ONE json block containing only what should change:
{ "sky": "#rrggbb", "ambient": 0..1, "lights": [...], "entities": [...] }
Include "entities" ONLY if you are rebuilding the layout — doing so replaces every object, so include all of them if you do.
Before the json, write two sentences saying what you saw and what you changed.`
          : `You are an art director reviewing a render of a 3D scene. You are shown the image and the scene data.

Say what is actually visible and what is wrong with it. Be specific and concrete — "the roof floats about half a metre above the walls", not "check your alignment". Comment on composition, scale, palette and lighting. Three to five bullets, no preamble, no praise padding. End with the single highest-value change to make next.`,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: `Scene data:\n${sceneSummary()}` },
            { type: "image", dataUrl: png },
          ],
        }],
      });
      setCritique(res.text.replace(/```json[\s\S]*?```/g, "").trim() || "(no comment)");
      if (andFix) {
        try { applyResult(extractJson(res.text)); }
        catch { setError("It described changes but returned no usable JSON. The critique is still worth reading."); }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "The model could not look at the scene.");
    } finally { setBusy(null); }
  }, [busy, capture, sceneSummary, applyResult, setError]);

  return (
    <div>
      <div className="os-label mb-1.5">What to make</div>
      <div className="mb-2 grid grid-cols-3 gap-1">
        {FORGE_KINDS.map((k) => (
          <button
            key={k.id}
            onClick={() => setKindId(k.id)}
            title={k.blurb}
            className={cn("os-card !p-1.5 text-center", kindId === k.id && "!border-[var(--accent)] ring-1 ring-[var(--accent)]")}
          >
            <Icon name={k.icon} size={15} style={{ color: "var(--accent)" }} />
            <div className="truncate text-[9.5px]">{k.name}</div>
          </button>
        ))}
      </div>
      <div className="mb-2 text-[10.5px] leading-snug text-[var(--muted)]">{kind.blurb}</div>

      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) build(); }}
        rows={3}
        placeholder={kind.placeholder}
        className="os-input mb-1.5 resize-y !py-1 text-[11.5px]"
      />

      {reference && (
        <div className="mb-1.5 flex items-center gap-1.5 rounded-[calc(var(--radius)*0.5)] border border-[var(--accent)] p-1">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={reference} alt="Reference" className="h-10 w-10 shrink-0 rounded object-cover" />
          <span className="min-w-0 flex-1 text-[10px] text-[var(--muted)]">Reference image attached — needs a model that can see.</span>
          <button className="shrink-0 opacity-60 hover:opacity-100" onClick={() => setReference(null)}><Icon name="close" size={11} /></button>
        </div>
      )}

      <div className="mb-2 flex gap-1">
        <button className="os-btn flex-1 !py-1 text-[11px]" data-variant="primary" onClick={build} disabled={!!busy || !prompt.trim()}>
          <Icon name="wand" size={11} className="mr-1" />{busy === "build" ? "Building…" : "Build"}
        </button>
        <label className="os-btn shrink-0 !py-1 text-[11px]" title="Attach a reference image for a vision model to work from">
          <Icon name="image" size={11} />
          <input
            type="file" accept="image/*" hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              if (f.size > 4 * 1024 * 1024) { setError("Pick an image under 4 MB — it is sent inline with the prompt."); return; }
              const reader = new FileReader();
              reader.onload = () => setReference(String(reader.result));
              reader.readAsDataURL(f);
              e.target.value = "";
            }}
          />
        </label>
      </div>

      <div className="mt-3 border-t border-[var(--border)] pt-2">
        <div className="os-label mb-1">Let it look</div>
        <p className="mb-1.5 text-[10px] leading-relaxed text-[var(--muted)]">
          Renders the viewport and sends the picture to your model. A model reading JSON is guessing at what the scene
          looks like; one looking at the render can see that the roof floats. Needs a model with vision.
        </p>
        <div className="flex gap-1">
          <button className="os-btn flex-1 !py-1 text-[11px]" onClick={() => look(false)} disabled={!!busy || scene.entities.length === 0}>
            <Icon name="eye" size={11} className="mr-1" />{busy === "look" ? "Looking…" : "Review"}
          </button>
          <button className="os-btn flex-1 !py-1 text-[11px]" onClick={() => look(true)} disabled={!!busy || scene.entities.length === 0}>
            <Icon name="brush" size={11} className="mr-1" />{busy === "fix" ? "Fixing…" : "Review & fix"}
          </button>
        </div>
      </div>

      {busy && <div className="mt-2"><Spinner label={busy === "build" ? "Composing…" : "Looking at the render…"} /></div>}

      {shot && (critique || busy === "look" || busy === "fix") && (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img src={shot} alt="What the model was shown" className="mt-2 w-full rounded-[calc(var(--radius)*0.5)] border border-[var(--border)]" />
      )}

      {critique && (
        <div className="os-card mt-2 !p-2">
          <div className="os-label mb-1">What it saw</div>
          <Markdown text={critique} className="!text-[11px]" />
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   Lights and particles
   ══════════════════════════════════════════════════════════════════════════ */

function LightPanel({ scene, setScene }: { scene: Scene; setScene: React.Dispatch<React.SetStateAction<Scene>> }) {
  const setLight = (id: string, p: Partial<Light>) =>
    setScene((s) => ({ ...s, lights: s.lights.map((l) => (l.id === id ? { ...l, ...p } : l)) }));
  const setFx = (id: string, p: Partial<Emitter>) =>
    setScene((s) => ({ ...s, fx: s.fx.map((f) => (f.id === id ? { ...f, ...p } : f)) }));

  const totalParticles = useMemo(
    () => Math.round(scene.fx.reduce((a, f) => a + (f.on === false ? 0 : f.rate * f.life), 0)),
    [scene.fx],
  );

  return (
    <div>
      <div className="mb-2">
        <label className="mb-1.5 block text-[11px]">
          Sky
          <input type="color" value={scene.sky} onChange={(e) => setScene((s) => ({ ...s, sky: e.target.value }))} className="ml-1.5 h-6 w-10 cursor-pointer rounded border border-[var(--border)] bg-transparent align-middle" />
        </label>
        <label className="block text-[11px]">
          Ambient {scene.ambient.toFixed(2)}
          <input type="range" min={0} max={1} step={0.01} value={scene.ambient} onChange={(e) => setScene((s) => ({ ...s, ambient: Number(e.target.value) }))} className="w-full accent-[var(--accent)]" />
        </label>
        <label className="block text-[11px]">
          Gravity {scene.gravity.toFixed(2)}
          <input type="range" min={-30} max={0} step={0.1} value={scene.gravity} onChange={(e) => setScene((s) => ({ ...s, gravity: Number(e.target.value) }))} className="w-full accent-[var(--accent)]" />
        </label>
      </div>

      <div className="os-label mb-1 mt-3 flex items-center justify-between">
        <span>Lights ({scene.lights.length})</span>
        <button
          className="os-btn !px-1.5 !py-0 !text-[10px]"
          onClick={() => setScene((s) => ({ ...s, lights: [...s.lights, { id: uid("lt"), name: "Point light", kind: "point", position: [0, 3, 0], color: "#ffd9a0", intensity: 1.4, range: 8, on: true }] }))}
        >
          <Icon name="plus" size={10} />
        </button>
      </div>
      {scene.lights.map((l) => (
        <div key={l.id} className="os-card mb-1.5 !p-2">
          <div className="mb-1 flex items-center gap-1.5">
            <button onClick={() => setLight(l.id, { on: l.on === false })} title={l.on === false ? "Enable" : "Disable"}>
              <Icon name={l.on === false ? "eyeoff" : "eye"} size={11} />
            </button>
            <input value={l.name} onChange={(e) => setLight(l.id, { name: e.target.value })} className="min-w-0 flex-1 bg-transparent text-[11.5px] outline-none" />
            <input type="color" value={l.color} onChange={(e) => setLight(l.id, { color: e.target.value })} className="h-5 w-7 cursor-pointer rounded border border-[var(--border)] bg-transparent" />
            <button className="opacity-50 hover:opacity-100" onClick={() => setScene((s) => ({ ...s, lights: s.lights.filter((x) => x.id !== l.id) }))}>
              <Icon name="close" size={11} />
            </button>
          </div>
          <div className="mb-1 flex gap-1">
            {(["directional", "point"] as const).map((k) => (
              <button key={k} onClick={() => setLight(l.id, { kind: k })} className={cn("os-btn !px-1.5 !py-0 !text-[9.5px]", l.kind === k && "!border-[var(--accent)] !bg-[var(--accent)]/16")}>{k}</button>
            ))}
          </div>
          <div className="mb-1 flex gap-1">
            {[0, 1, 2].map((axis) => (
              <input
                key={axis} type="number" step={0.25} value={l.position[axis]}
                onChange={(e) => { const v = [...l.position] as Vec3; v[axis] = Number(e.target.value); setLight(l.id, { position: v }); }}
                className="os-input !py-0.5 text-[10px]"
              />
            ))}
          </div>
          <label className="block text-[10px]">
            Intensity {l.intensity.toFixed(2)}
            <input type="range" min={0} max={3} step={0.05} value={l.intensity} onChange={(e) => setLight(l.id, { intensity: Number(e.target.value) })} className="w-full accent-[var(--accent)]" />
          </label>
          {l.kind === "point" && (
            <label className="block text-[10px]">
              Range {l.range.toFixed(0)}m
              <input type="range" min={1} max={60} step={1} value={l.range} onChange={(e) => setLight(l.id, { range: Number(e.target.value) })} className="w-full accent-[var(--accent)]" />
            </label>
          )}
        </div>
      ))}

      <div className="os-label mb-1 mt-3 flex items-center justify-between">
        <span>Particles ({scene.fx.length})</span>
        <span className="flex items-center gap-1.5">
          {totalParticles > 0 && <span className="!normal-case">~{totalParticles} live</span>}
          <button
            className="os-btn !px-1.5 !py-0 !text-[10px]"
            title="Add an emitter by hand"
            onClick={() => setScene((s) => ({ ...s, fx: [...s.fx, { id: uid("fx"), name: "Emitter", position: [0, 0.4, 0], color: "#ffb347", color2: "#5a1d05", rate: 40, life: 1.5, speed: 1.8, spread: 0.3, size: 0.12, gravity: 0.8, blend: "add", on: true }] }))}
          >
            <Icon name="plus" size={10} />
          </button>
        </span>
      </div>
      {scene.fx.length === 0 && (
        <div className="text-[10.5px] leading-relaxed text-[var(--muted)]">
          None yet. Ask the Forge tab for &ldquo;a crackling campfire&rdquo; and it will layer the emitters for you, or add one by hand and tune it.
        </div>
      )}
      {scene.fx.map((f) => (
        <div key={f.id} className="os-card mb-1.5 !p-2">
          <div className="mb-1 flex items-center gap-1.5">
            <button onClick={() => setFx(f.id, { on: f.on === false })}>
              <Icon name={f.on === false ? "eyeoff" : "eye"} size={11} />
            </button>
            <input value={f.name} onChange={(e) => setFx(f.id, { name: e.target.value })} className="min-w-0 flex-1 bg-transparent text-[11.5px] outline-none" />
            <input type="color" value={f.color} onChange={(e) => setFx(f.id, { color: e.target.value })} className="h-5 w-6 cursor-pointer rounded border border-[var(--border)] bg-transparent" title="Colour at birth" />
            <input type="color" value={f.color2} onChange={(e) => setFx(f.id, { color2: e.target.value })} className="h-5 w-6 cursor-pointer rounded border border-[var(--border)] bg-transparent" title="Colour at death" />
            <button className="opacity-50 hover:opacity-100" onClick={() => setScene((s) => ({ ...s, fx: s.fx.filter((x) => x.id !== f.id) }))}>
              <Icon name="close" size={11} />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-x-2">
            {([["rate", 1, 200, 1], ["life", 0.1, 8, 0.1], ["speed", 0, 16, 0.1], ["size", 0.01, 1, 0.01], ["spread", 0, 1, 0.02], ["gravity", -12, 12, 0.1]] as const).map(([key, lo, hi, step]) => (
              <label key={key} className="block text-[9.5px]">
                {key} {(f[key] as number).toFixed(2)}
                <input
                  type="range" min={lo} max={hi} step={step} value={f[key] as number}
                  onChange={(e) => setFx(f.id, { [key]: Number(e.target.value) } as Partial<Emitter>)}
                  className="w-full accent-[var(--accent)]"
                />
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
