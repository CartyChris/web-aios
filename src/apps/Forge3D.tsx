"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAssets, type Asset, type AssetPart } from "./Assets";
import { useVFS } from "@/kernel/vfs";
import { bus } from "@/kernel/bus";
import type { AppProps } from "@/kernel/types";
import { uid, download } from "@/lib/format";
import { Tabs, Empty, ErrorNote, CopyButton } from "./_ui";
import { cn } from "@/lib/cn";
import { Icon } from "@/shell/icons";

/* ────────────────────────────────────────────────────────────────────────────
   Forge 3D — ported from universal_3d_game_editor_harness_v7.

   The original leaned on a WebGL renderer. This port draws the scene with a
   software isometric projection on a 2D canvas instead, for a reason that
   matters here: it adds zero bytes of dependency to an OS that must stay fast
   to boot, and it works identically on a phone. The scene graph, the entity
   model and the exported format are the parts worth keeping, and those are
   faithful — a scene exported here carries the same entity/transform/physics
   shape the original used, so it round-trips.
   ──────────────────────────────────────────────────────────────────────────── */

export interface Entity {
  id: string;
  name: string;
  assetId: string | null;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  visible: boolean;
  parts: AssetPart[];
  physics?: Asset["physics"];
}

export interface Scene {
  name: string;
  entities: Entity[];
  gravity: number;
  ambient: number;
  sky: string;
}

const BLANK: Scene = { name: "Untitled scene", entities: [], gravity: -9.81, ambient: 0.55, sky: "#0b1a2e" };

export default function Forge3D({ args }: AppProps) {
  const assets = useAssets();
  const vfs = useVFS();
  const [scene, setScene] = useState<Scene>(BLANK);
  const [sel, setSel] = useState<string | null>(null);
  const [tab, setTab] = useState("scene");
  const [error, setError] = useState<string | null>(null);
  const [cam, setCam] = useState({ yaw: 0.7, pitch: 0.55, zoom: 46, panX: 0, panY: 0 });
  const [playing, setPlaying] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ x: number; y: number; yaw: number; pitch: number; pan: boolean; panX: number; panY: number } | null>(null);
  const velRef = useRef<Map<string, number>>(new Map());

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

  // Asset Library can launch us with an asset to place; do it once.
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

  /* ── Renderer ──────────────────────────────────────────────────────────── */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const g = canvas.getContext("2d");
    if (!g) return;
    let raf = 0;

    const project = (x: number, y: number, z: number, w: number, h: number) => {
      const { yaw, pitch, zoom, panX, panY } = cam;
      // Yaw about Y, then tilt. Enough for an editor viewport; a full matrix
      // stack would be more code for no visible gain at this fidelity.
      const cx = Math.cos(yaw), sy = Math.sin(yaw);
      const rx = x * cx - z * sy;
      const rz = x * sy + z * cx;
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      const sx = rx * zoom + w / 2 + panX;
      const syy = (rz * cp - y * 1.0) * zoom * 0.62 + h / 2 + panY;
      return { x: sx, y: syy, depth: rz * cp + y * sp };
    };

    const draw = () => {
      const w = canvas.width = canvas.clientWidth;
      const h = canvas.height = canvas.clientHeight;
      g.clearRect(0, 0, w, h);

      const grad = g.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, scene.sky);
      grad.addColorStop(1, shade(scene.sky, -0.45));
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);

      // Ground grid
      g.strokeStyle = "rgba(255,255,255,0.09)";
      g.lineWidth = 1;
      const N = 12;
      for (let i = -N; i <= N; i++) {
        const a = project(i, 0, -N, w, h), b = project(i, 0, N, w, h);
        const c = project(-N, 0, i, w, h), d = project(N, 0, i, w, h);
        g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.moveTo(c.x, c.y); g.lineTo(d.x, d.y); g.stroke();
      }
      // Axes
      for (const [axis, color] of [[[1, 0, 0], "#ff5f57"], [[0, 1, 0], "#28c840"], [[0, 0, 1], "#60a5fa"]] as const) {
        const o = project(0, 0, 0, w, h);
        const p = project(axis[0] * 3, axis[1] * 3, axis[2] * 3, w, h);
        g.strokeStyle = color; g.lineWidth = 1.5;
        g.beginPath(); g.moveTo(o.x, o.y); g.lineTo(p.x, p.y); g.stroke();
      }

      // Painter's algorithm: sort every part by depth and draw back to front.
      type Drawable = { depth: number; pts: { x: number; y: number }[]; color: string; selected: boolean; emissive?: string };
      const drawables: Drawable[] = [];

      for (const e of scene.entities) {
        if (!e.visible) continue;
        for (const part of e.parts) {
          const px = e.position[0] + (part.position?.[0] ?? 0) * e.scale[0];
          const py = e.position[1] + (part.position?.[1] ?? 0) * e.scale[1];
          const pz = e.position[2] + (part.position?.[2] ?? 0) * e.scale[2];
          const s = part.scale ?? [1, 1, 1];
          const sx = s[0] * e.scale[0] * 0.5, sy2 = s[1] * e.scale[1] * 0.5, sz = s[2] * e.scale[2] * 0.5;

          const corners: [number, number, number][] = [
            [px - sx, py - sy2, pz - sz], [px + sx, py - sy2, pz - sz], [px + sx, py - sy2, pz + sz], [px - sx, py - sy2, pz + sz],
            [px - sx, py + sy2, pz - sz], [px + sx, py + sy2, pz - sz], [px + sx, py + sy2, pz + sz], [px - sx, py + sy2, pz + sz],
          ];
          const proj = corners.map(([a, b, c]) => project(a, b, c, w, h));
          const faces: [number[], number][] = [
            [[4, 5, 6, 7], 1.0],   // top — lit
            [[0, 1, 5, 4], 0.72],
            [[1, 2, 6, 5], 0.58],
            [[2, 3, 7, 6], 0.72],
            [[3, 0, 4, 7], 0.58],
          ];
          for (const [idx, light] of faces) {
            const pts = idx.map((i) => proj[i]);
            const depth = pts.reduce((a, p) => a + p.depth, 0) / pts.length;
            drawables.push({
              depth,
              pts,
              color: shade(part.color ?? "#8b8b95", (light - 1) * (1 - scene.ambient) - (1 - light) * 0.15),
              selected: e.id === sel,
              emissive: part.emissive,
            });
          }
        }
      }

      drawables.sort((a, b) => a.depth - b.depth);
      for (const d of drawables) {
        g.beginPath();
        g.moveTo(d.pts[0].x, d.pts[0].y);
        for (const p of d.pts.slice(1)) g.lineTo(p.x, p.y);
        g.closePath();
        g.fillStyle = d.color;
        g.fill();
        if (d.emissive) { g.globalAlpha = 0.35; g.fillStyle = d.emissive; g.fill(); g.globalAlpha = 1; }
        g.strokeStyle = d.selected ? "#67e8f9" : "rgba(0,0,0,0.35)";
        g.lineWidth = d.selected ? 1.8 : 0.6;
        g.stroke();
      }

      if (playing) {
        // A deliberately simple integrator: enough to sanity-check masses and
        // ground contact, not a physics engine. Labelled as such in the UI.
        setScene((s) => ({
          ...s,
          entities: s.entities.map((e) => {
            if (e.physics?.bodyType !== "dynamic") return e;
            const v = (velRef.current.get(e.id) ?? 0) + s.gravity * 0.016;
            let y = e.position[1] + v * 0.016;
            let nv = v;
            if (y <= 0) { y = 0; nv = -v * (e.physics.restitution ?? 0); if (Math.abs(nv) < 0.25) nv = 0; }
            velRef.current.set(e.id, nv);
            return { ...e, position: [e.position[0], y, e.position[2]] as [number, number, number] };
          }),
        }));
        raf = requestAnimationFrame(draw);
      }
    };

    draw();
    if (playing) raf = requestAnimationFrame(draw);
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [scene, cam, sel, playing]);

  const exportScene = useCallback(() => JSON.stringify({ __forge3d: 1, scene }, null, 2), [scene]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border)] px-2.5 py-1.5">
        <input value={scene.name} onChange={(e) => setScene((s) => ({ ...s, name: e.target.value }))} className="os-input !w-44 !py-1 text-[12px] font-medium" />
        <button className={cn("os-btn !py-1 text-[11px]", playing && "!border-[var(--ok)] !bg-[var(--ok)]/16")} onClick={() => { setPlaying((p) => !p); velRef.current.clear(); }}>
          {playing ? "◼ Stop" : "▶ Play"}
        </button>
        <button className="os-btn !py-1 text-[11px]" onClick={() => setCam({ yaw: 0.7, pitch: 0.55, zoom: 46, panX: 0, panY: 0 })}>Reset view</button>
        <div className="flex-1" />
        <span className="os-chip">{scene.entities.length} entities</span>
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
                setScene({ ...BLANK, ...sc });
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
            className="h-full w-full cursor-grab active:cursor-grabbing"
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

        <div className="app-aside flex w-64 shrink-0 flex-col border-l border-[var(--border)]">
          <Tabs tabs={[{ id: "scene", label: "Scene" }, { id: "assets", label: "Assets" }, { id: "props", label: "Inspector" }]} active={tab} onChange={setTab} />
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {tab === "scene" && (
              <>
                {scene.entities.length === 0 && <div className="py-6 text-center text-[11px] text-[var(--muted)]">Empty scene. Add something from the Assets tab.</div>}
                {scene.entities.map((e) => (
                  <div key={e.id} className={cn("mb-0.5 flex items-center gap-1.5 rounded px-2 py-1", sel === e.id ? "bg-[var(--accent)]/16" : "hover:bg-white/6")}>
                    <button onClick={() => patch(e.id, { visible: !e.visible })} className="text-[10px] opacity-70">{e.visible ? "◉" : "○"}</button>
                    <button onClick={() => { setSel(e.id); setTab("props"); }} className="min-w-0 flex-1 truncate text-left text-[11.5px]">{e.name}</button>
                    <button className="text-[10px] opacity-50 hover:opacity-100" onClick={() => { setScene((s) => ({ ...s, entities: s.entities.filter((x) => x.id !== e.id) })); if (sel === e.id) setSel(null); }}><Icon name="close" size={11} /></button>
                  </div>
                ))}
                <div className="mt-3 space-y-2">
                  <label className="block text-[11px]">Sky
                    <input type="color" value={scene.sky} onChange={(e) => setScene((s) => ({ ...s, sky: e.target.value }))} className="ml-1.5 h-6 w-10 cursor-pointer rounded border border-[var(--border)] bg-transparent align-middle" />
                  </label>
                  <label className="block text-[11px]">Ambient light
                    <input type="range" min={0} max={1} step={0.05} value={scene.ambient} onChange={(e) => setScene((s) => ({ ...s, ambient: Number(e.target.value) }))} className="w-full accent-[var(--accent)]" />
                  </label>
                  <label className="block text-[11px]">Gravity {scene.gravity.toFixed(2)}
                    <input type="range" min={-30} max={0} step={0.1} value={scene.gravity} onChange={(e) => setScene((s) => ({ ...s, gravity: Number(e.target.value) }))} className="w-full accent-[var(--accent)]" />
                  </label>
                  <div className="text-[10px] leading-snug text-[var(--muted)]">
                    Play mode runs a simple gravity + restitution integrator for sanity-checking masses. It is not a full physics engine.
                  </div>
                </div>
              </>
            )}

            {tab === "assets" && (
              assets.assets.length === 0 ? (
                <Empty icon="assets" title="No assets" body="Add some in Asset Library." />
              ) : (
                <div className="grid grid-cols-2 gap-1.5">
                  {assets.assets.map((a) => (
                    <button key={a.id} onClick={() => spawn(a.id)} className="os-card !p-2 text-center">
                      <div className="text-2xl">{a.icon}</div>
                      <div className="truncate text-[10.5px]">{a.name}</div>
                    </button>
                  ))}
                </div>
              )
            )}

            {tab === "props" && (
              !entity ? (
                <Empty icon="search" title="Nothing selected" body="Pick an entity on the Scene tab." />
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
                            onChange={(ev) => { const v = [...entity[field]] as [number, number, number]; v[axis] = Number(ev.target.value); patch(entity.id, { [field]: v }); }}
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
                    <button className="os-btn !px-2 !py-0.5 text-[10.5px]" onClick={() => { const c = { ...entity, id: uid("ent"), position: [entity.position[0] + 1.5, entity.position[1], entity.position[2]] as [number, number, number] }; setScene((s) => ({ ...s, entities: [...s.entities, c] })); setSel(c.id); }}>Duplicate</button>
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

/** Lighten or darken a hex colour by a signed fraction. */
function shade(hex: string, amount: number): string {
  let c = hex.replace("#", "");
  if (c.length === 3) c = c.split("").map((x) => x + x).join("");
  const n = parseInt(c || "888888", 16);
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const r = clamp(((n >> 16) & 255) * (1 + amount));
  const g = clamp(((n >> 8) & 255) * (1 + amount));
  const b = clamp((n & 255) * (1 + amount));
  return `rgb(${r},${g},${b})`;
}
