"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAssets, type Asset, type AssetPart } from "./Assets";
import { useVFS } from "@/kernel/vfs";
import { bus } from "@/kernel/bus";
import type { AppProps } from "@/kernel/types";
import { uid, download } from "@/lib/format";
import { ask } from "@/lib/useAI";
import { ErrorNote, Spinner, Markdown } from "./_ui";
import {
  FORGE_KINDS, getForgeKind, extractJson, num, vec3, stackedCount, spreadOverlapping,
} from "@/lib/forge-schema";
import { ForgeViewport } from "@/lib/forge-viewport";
import type { SceneDoc, SceneEntity, ScenePart } from "@/lib/forge-scene";
import type { Light, Emitter, Vec3 } from "@/lib/forge-render";
import { cn } from "@/lib/cn";
import { Icon } from "@/shell/icons";
import { initHistory, record, undo as undoStep, redo as redoStep, canUndo, canRedo, type History } from "@/lib/undo-history";
import { snapVec, dropToGround, duplicatePosition, alignTo, type V3, type AlignAxis } from "@/lib/forge-ops";
import { exportMeshes, saveBlob, type MeshFormat } from "./_forgeExport";

/* ────────────────────────────────────────────────────────────────────────────
   Forge 3D — build a world with a model, then let it look at what it built.

   The viewport is WebGL now (lib/forge-viewport.ts). The previous software
   painter sorted whole faces by centroid depth, which is fine until a scene
   has a large flat surface: a ground plane's centroid can sit closer than a
   river lying on top of it, so the ground draws last and the river vanishes —
   and only from some angles, because it depends entirely on where the
   centroids land. A depth buffer is the fix, and it comes with real geometry,
   rotations, PBR materials and shadows, which is the rest of what was missing.

   The panel is three things, in the order you need them: make something, look
   at what is there, change how it is lit. Everything else is one menu.
   ──────────────────────────────────────────────────────────────────────────── */

export interface Entity extends SceneEntity {
  assetId: string | null;
  parts: AssetPart[];
  physics?: Asset["physics"];
}

export interface Scene extends SceneDoc {
  name: string;
  entities: Entity[];
  gravity: number;
}

const DEFAULT_LIGHTS: Light[] = [
  { id: "key", name: "Key", kind: "directional", position: [-0.7, 1.35, 0.85], color: "#fff1dc", intensity: 1.15, range: 0, on: true },
  { id: "fill", name: "Sky fill", kind: "directional", position: [0.8, 0.55, -0.9], color: "#93b9ff", intensity: 0.42, range: 0, on: true },
];

const BLANK: Scene = {
  name: "Untitled scene",
  entities: [],
  lights: DEFAULT_LIGHTS.map((l) => ({ ...l })),
  fx: [],
  gravity: -9.81,
  ambient: 0.34,
  sky: "#93b7d8",
  fog: 260,
};

/* ── Normalising what a model returns ─────────────────────────────────────── */

function toPart(raw: unknown, i: number): AssetPart & ScenePart {
  const p = (raw ?? {}) as Record<string, unknown>;
  return {
    id: typeof p.id === "string" ? p.id : `p${i}`,
    name: typeof p.name === "string" ? p.name : `Part ${i + 1}`,
    shape: (typeof p.shape === "string" ? p.shape : "box") as AssetPart["shape"],
    position: vec3(p.position, [0, 0, 0]),
    rotation: vec3(p.rotation, [0, 0, 0]),
    scale: vec3(p.scale, [1, 1, 1]),
    color: typeof p.color === "string" ? p.color : "#8b8b95",
    roughness: typeof p.roughness !== "undefined" ? num(p.roughness, 0.72) : undefined,
    metalness: typeof p.metalness !== "undefined" ? num(p.metalness, 0.05) : undefined,
    emissive: typeof p.emissive === "string" ? p.emissive : undefined,
    opacity: typeof p.opacity !== "undefined" ? num(p.opacity, 1) : undefined,
  };
}

function toEntity(raw: unknown): Entity | null {
  const e = (raw ?? {}) as Record<string, unknown>;
  const parts = Array.isArray(e.parts) ? e.parts : null;
  if (!parts || parts.length === 0) return null;
  return {
    id: uid("ent"),
    name: typeof e.name === "string" ? e.name : "Object",
    assetId: null,
    position: vec3(e.position, [0, 0, 0]),
    rotation: vec3(e.rotation, [0, 0, 0]),
    scale: vec3(e.scale, [1, 1, 1]),
    visible: true,
    physics: e.physics as Asset["physics"] | undefined,
    parts: parts.map(toPart),
  };
}

function toLight(raw: unknown): Light | null {
  const l = (raw ?? {}) as Record<string, unknown>;
  if (!Array.isArray(l.position) && typeof l.position !== "object") return null;
  return {
    id: uid("lt"),
    name: typeof l.name === "string" ? l.name : "Light",
    kind: l.kind === "point" ? "point" : "directional",
    position: vec3(l.position, [0, 5, 0]),
    color: typeof l.color === "string" ? l.color : "#ffffff",
    intensity: Math.max(0, Math.min(4, num(l.intensity, 1))),
    range: num(l.range, 14),
    on: true,
  };
}

function toEmitter(raw: unknown): Emitter | null {
  const e = (raw ?? {}) as Record<string, unknown>;
  if (!Array.isArray(e.position) && typeof e.position !== "object") return null;
  const clamped = (v: unknown, d: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, num(v, d)));
  return {
    id: uid("fx"),
    name: typeof e.name === "string" ? e.name : "Emitter",
    position: vec3(e.position, [0, 1, 0]),
    color: typeof e.color === "string" ? e.color : "#ffb347",
    color2: typeof e.color2 === "string" ? e.color2 : "#4a2010",
    // Clamped, not trusted: rate 100000 should give a busy effect, not a
    // locked-up tab.
    rate: clamped(e.rate, 30, 1, 200),
    life: clamped(e.life, 1.4, 0.1, 10),
    speed: clamped(e.speed, 1.6, 0, 20),
    spread: clamped(e.spread, 0.35, 0, 1),
    size: clamped(e.size, 0.12, 0.01, 1.5),
    gravity: clamped(e.gravity, 0.6, -30, 30),
    blend: e.blend === "normal" ? "normal" : "add",
    on: true,
  };
}

/* ══════════════════════════════════════════════════════════════════════════ */

/** The open scene survives a reload.
 *
 *  It did not before, and closing the window threw away however long you had
 *  spent building — which makes a scene feel disposable and stops anyone
 *  investing in one. Stored under its own key rather than in the settings
 *  store because a scene is work, not a preference. */
const SCENE_KEY = "webaios.forge.scene.v1";

function loadScene(): Scene {
  if (typeof localStorage === "undefined") return BLANK;
  try {
    const raw = localStorage.getItem(SCENE_KEY);
    if (!raw) return BLANK;
    const parsed = JSON.parse(raw) as Partial<Scene>;
    if (!Array.isArray(parsed.entities)) return BLANK;
    return {
      ...BLANK,
      ...parsed,
      lights: parsed.lights?.length ? parsed.lights : DEFAULT_LIGHTS.map((l) => ({ ...l })),
      fx: parsed.fx ?? [],
    };
  } catch {
    return BLANK;
  }
}

export default function Forge3D({ args }: AppProps) {
  const assets = useAssets();
  const vfs = useVFS();
  /* The scene lives inside an undo history. Children still receive a plain
     setScene: their edits are recorded under one key, so a slider drag or a
     number being typed folds into a single step. Discrete actions (duplicate,
     align, delete, import) go through `commitScene`, which is always its own
     step. */
  const [hist, setHist] = useState<History<Scene>>(() => initHistory(loadScene()));
  const scene = hist.present;
  const setScene = useCallback<React.Dispatch<React.SetStateAction<Scene>>>((u) => {
    const now = Date.now();
    setHist((h) => record(h, typeof u === "function" ? (u as (s: Scene) => Scene)(h.present) : u, { now, key: "edit" }));
  }, []);
  const commitScene = useCallback((u: (s: Scene) => Scene) => {
    const now = Date.now();
    setHist((h) => record(h, u(h.present), { now }));
  }, []);
  const doUndo = useCallback(() => setHist((h) => undoStep(h)), []);
  const doRedo = useCallback(() => setHist((h) => redoStep(h)), []);
  /** Grid snap for moves (metres) and turns (degrees). 0 is off. */
  const [snap, setSnap] = useState<{ move: number; turn: number }>({ move: 0, turn: 0 });
  const [exporting, setExporting] = useState<MeshFormat | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [panel, setPanel] = useState<"make" | "scene" | "look">("make");
  const [error, setError] = useState<string | null>(null);
  const [fps, setFps] = useState(0);
  const [grid, setGrid] = useState(true);
  const [menu, setMenu] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<ForgeViewport | null>(null);

  // One viewport for the life of the window. It owns its own frame loop and
  // never re-reads React state, so orbiting costs nothing above a draw call.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const vp = new ForgeViewport(canvas, { onFps: setFps, onSelect: setSel });
    viewportRef.current = vp;
    return () => { vp.dispose(); viewportRef.current = null; };
  }, []);

  useEffect(() => { viewportRef.current?.setScene(scene); }, [scene]);

  // Persist on a trailing timer: a slider drag fires this thirty times a
  // second, and writing a whole scene to localStorage that often is a
  // measurable stall.
  useEffect(() => {
    const t = setTimeout(() => {
      try { localStorage.setItem(SCENE_KEY, JSON.stringify(scene)); } catch { /* quota — not worth interrupting for */ }
    }, 600);
    return () => clearTimeout(t);
  }, [scene]);
  useEffect(() => { viewportRef.current?.select(sel); }, [sel]);
  useEffect(() => { viewportRef.current?.setGridVisible(grid); }, [grid]);

  const spawn = useCallback((assetId: string) => {
    const a = assets.assets.find((x) => x.id === assetId);
    if (!a) return;
    // Id and heading are chosen out here: an updater may run twice, and must
    // be pure. Spawning is its own undo step.
    const id = uid("ent");
    const heading = Math.round(Math.random() * 360);
    commitScene((s) => {
      // Drop it somewhere free rather than on top of whatever is at the origin.
      const ring = s.entities.length;
      const angle = ring * 2.4;
      const e: Entity = {
        id, name: a.name, assetId: a.id,
        position: [Math.round(Math.cos(angle) * (2 + ring * 1.4) * 10) / 10, 0, Math.round(Math.sin(angle) * (2 + ring * 1.4) * 10) / 10],
        rotation: [0, heading, 0], scale: [1, 1, 1],
        visible: true, parts: a.parts, physics: a.physics,
      };
      return { ...s, entities: [...s.entities, e] };
    });
    setSel(id);
  }, [assets.assets, commitScene]);

  const spawnArg = args?.spawnAsset as string | undefined;
  const [spawnedArg, setSpawnedArg] = useState<string | undefined>(undefined);
  if (spawnArg && spawnArg !== spawnedArg) {
    setSpawnedArg(spawnArg);
    spawn(spawnArg);
  }

  const entity = scene.entities.find((e) => e.id === sel) ?? null;
  const patch = useCallback((id: string, p: Partial<Entity>) => {
    const q = { ...p };
    if (snap.move > 0 && q.position) q.position = snapVec(q.position as V3, snap.move);
    if (snap.turn > 0 && q.rotation) q.rotation = snapVec(q.rotation as V3, snap.turn);
    setScene((s) => ({ ...s, entities: s.entities.map((e) => (e.id === id ? { ...e, ...q } : e)) }));
  }, [snap, setScene]);

  /* ── discrete edits, each its own undo step ── */

  const duplicate = useCallback((id: string) => {
    // The id is minted out here: an updater may run twice, and must be pure.
    const nid = uid("ent");
    commitScene((s) => {
      const src = s.entities.find((e) => e.id === id);
      if (!src) return s;
      const c: Entity = { ...src, id: nid, name: `${src.name} copy`, position: duplicatePosition(src.position as V3, s.entities.map((e) => e.position as V3)) };
      return { ...s, entities: [...s.entities, c] };
    });
    setSel(nid);
  }, [commitScene]);

  const removeEntity = useCallback((id: string) => {
    commitScene((s) => ({ ...s, entities: s.entities.filter((x) => x.id !== id) }));
    setSel((cur) => (cur === id ? null : cur));
  }, [commitScene]);

  const ground = useCallback((id: string) => {
    commitScene((s) => ({ ...s, entities: s.entities.map((e) => (e.id === id ? { ...e, position: dropToGround(e.position as V3, e.parts, e.scale as V3) } : e)) }));
  }, [commitScene]);

  const alignOthers = useCallback((id: string, axis: AlignAxis) => {
    commitScene((s) => {
      const ref = s.entities.find((e) => e.id === id);
      if (!ref) return s;
      return { ...s, entities: s.entities.map((e) => (e.id === id ? e : { ...e, position: alignTo([e.position as V3], ref.position as V3, axis)[0] })) };
    });
  }, [commitScene]);

  const exportAs = useCallback(async (format: MeshFormat, only?: string[]) => {
    setExporting(format);
    setError(null);
    try {
      const out = await exportMeshes(scene, scene.name, format, only);
      saveBlob(out.blob, out.filename);
      bus.emit("notify", { title: `Exported ${out.filename}`, body: `${out.meshes} mesh${out.meshes === 1 ? "" : "es"}, ${(out.bytes / 1024).toFixed(1)} KB`, kind: "success" });
    } catch (e) {
      setError(e instanceof Error ? `Export failed: ${e.message}` : "Export failed.");
    } finally { setExporting(null); }
  }, [scene]);

  const onKey = useCallback((e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest("input, textarea, select, [contenteditable]")) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (mod && k === "z" && !e.shiftKey) { e.preventDefault(); doUndo(); }
    else if (mod && ((k === "z" && e.shiftKey) || k === "y")) { e.preventDefault(); doRedo(); }
    else if (mod && k === "d" && sel) { e.preventDefault(); duplicate(sel); }
    else if ((e.key === "Delete" || e.key === "Backspace") && sel) { e.preventDefault(); removeEntity(sel); }
    else if (k === "g" && sel && !mod) { e.preventDefault(); ground(sel); }
  }, [doUndo, doRedo, duplicate, removeEntity, ground, sel]);

  const capture = useCallback((max?: number) => viewportRef.current?.capture(max) ?? null, []);
  const exportScene = useCallback(() => JSON.stringify({ __forge3d: 3, scene }, null, 2), [scene]);

  // Menu actions are stable callbacks rather than closures built inside the
  // render body: reading viewportRef while rendering is a concurrent-mode
  // hazard, and the lint that catches it is right.
  const frameScene = useCallback(() => viewportRef.current?.frameScene(), []);
  const saveToFiles = useCallback(() => {
    vfs.write(`/scenes/${scene.name.replace(/\s+/g, "_")}.json`, exportScene(), { appId: "forge3d" });
    bus.emit("notify", { title: "Scene saved to Files", kind: "success" });
  }, [vfs, scene.name, exportScene]);
  const exportJson = useCallback(
    () => download(`${scene.name.replace(/\s+/g, "_")}.json`, exportScene(), "application/json"),
    [scene.name, exportScene],
  );
  const clearScene = useCallback(() => {
    // Undoable, which is what makes it safe to leave in a menu without a confirm.
    commitScene((s) => ({ ...BLANK, name: s.name, lights: DEFAULT_LIGHTS.map((l) => ({ ...l })) }));
    setSel(null);
  }, [commitScene]);

  const partCount = useMemo(() => scene.entities.reduce((a, e) => a + e.parts.length, 0), [scene.entities]);

  return (
    <div className="flex h-full flex-col outline-none" tabIndex={-1} onKeyDown={onKey}>
      {/* ── Title bar: the name, the state of things, and one menu ── */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-2.5 py-1.5">
        <input
          value={scene.name}
          onChange={(e) => setScene((s) => ({ ...s, name: e.target.value }))}
          className="min-w-0 max-w-52 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-[13px] font-medium outline-none hover:border-[var(--border)] focus:border-[var(--accent)]"
          aria-label="Scene name"
        />
        <div className="flex-1" />
        <button className="os-btn !px-1.5 !py-1 text-[11px]" onClick={doUndo} disabled={!canUndo(hist)} title={`Undo (Ctrl+Z) · ${hist.past.length} step${hist.past.length === 1 ? "" : "s"}`} aria-label="Undo">
          <Icon name="refresh" size={12} style={{ transform: "scaleX(-1)" }} />
        </button>
        <button className="os-btn !px-1.5 !py-1 text-[11px]" onClick={doRedo} disabled={!canRedo(hist)} title={`Redo (Ctrl+Shift+Z) · ${hist.future.length} step${hist.future.length === 1 ? "" : "s"}`} aria-label="Redo">
          <Icon name="refresh" size={12} />
        </button>
        <select
          className="os-input !w-auto !py-0.5 text-[10.5px]"
          value={`${snap.move}|${snap.turn}`}
          onChange={(e) => { const [m, t] = e.target.value.split("|").map(Number); setSnap({ move: m, turn: t }); }}
          aria-label="Snap"
          title="Snap moves and turns to a grid"
        >
          <option value="0|0">snap off</option>
          <option value="0.25|15">0.25 m · 15°</option>
          <option value="0.5|15">0.5 m · 15°</option>
          <option value="1|45">1 m · 45°</option>
        </select>
        <span className="os-chip tabular-nums" title="Objects · parts · lights · effects">
          {scene.entities.length} · {partCount}p · {scene.lights.length}L · {scene.fx.length}fx
        </span>
        <span className="os-chip tabular-nums hidden sm:inline-flex" title="Viewport frame rate">{fps} fps</span>
        <div className="relative">
          <button className="os-btn !py-1 text-[11px]" onClick={() => setMenu((m) => !m)} title="Scene menu">
            <Icon name="menu" size={12} />
          </button>
          {menu && (
            <>
              <div className="fixed inset-0 z-[40]" onClick={() => setMenu(false)} />
              <div className="glass absolute right-0 top-full z-[50] mt-1 w-48 p-1.5 shadow-2xl" style={{ borderRadius: "var(--radius)" }}>
                <MenuItem icon="save" label="Save to Files" onClick={() => { saveToFiles(); setMenu(false); }} />
                <MenuItem icon="download" label="Export .json" onClick={() => { exportJson(); setMenu(false); }} />
                <MenuItem icon="package" label={exporting === "glb" ? "Exporting .glb…" : "Export .glb (glTF)"} onClick={() => { setMenu(false); void exportAs("glb"); }} />
                <MenuItem icon="package" label={exporting === "obj" ? "Exporting .obj…" : "Export .obj"} onClick={() => { setMenu(false); void exportAs("obj"); }} />
                <MenuItem icon="grid" label={grid ? "Hide grid" : "Show grid"} onClick={() => { setGrid((g) => !g); setMenu(false); }} />
                <MenuItem icon="eye" label="Frame scene" onClick={() => { frameScene(); setMenu(false); }} />
                <MenuItem icon="trash" label="Clear scene" onClick={() => { clearScene(); setMenu(false); }} />
                <label className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] hover:bg-[var(--accent)]/18">
                  <Icon name="folder" size={12} />Import .json
                  <input
                    type="file" accept="application/json" hidden
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      setMenu(false);
                      if (!f) return;
                      try {
                        const parsed = JSON.parse(await f.text());
                        const sc = parsed.scene ?? parsed;
                        if (!Array.isArray(sc.entities)) throw new Error("No entities array found.");
                        commitScene(() => ({ ...BLANK, ...sc, lights: sc.lights?.length ? sc.lights : DEFAULT_LIGHTS, fx: sc.fx ?? [] }));
                        setTimeout(frameScene, 60);
                      } catch (err) { setError(err instanceof Error ? err.message : "Import failed."); }
                      e.target.value = "";
                    }}
                  />
                </label>
              </div>
            </>
          )}
        </div>
      </div>

      {error && <div className="px-2.5 pt-2"><ErrorNote error={error} onDismiss={() => setError(null)} /></div>}

      <div className="app-split flex min-h-0 flex-1">
        {/* ── Viewport ── */}
        <div className="relative min-w-0 flex-1 bg-black">
          <canvas ref={canvasRef} className="block h-full w-full touch-none" />
          {scene.entities.length === 0 && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <div className="max-w-xs text-center">
                <Icon name="cube3d" size={34} style={{ opacity: 0.35 }} />
                <div className="mt-2 text-[13px] font-medium opacity-70">Nothing here yet</div>
                <div className="mt-1 text-[11.5px] text-[var(--muted)]">
                  Describe a place, a prop or a character on the right and it gets built here.
                </div>
              </div>
            </div>
          )}
          <div className="pointer-events-none absolute bottom-2 left-2 rounded px-2 py-1 text-[10px] text-[var(--muted)]" style={{ background: "color-mix(in srgb, var(--bg) 62%, transparent)" }}>
            drag orbit · right-drag pan · scroll zoom · click to select · Ctrl+Z undo
          </div>
          {exporting && (
            <div className="absolute right-2 top-2 rounded px-2 py-1 text-[10.5px]" style={{ background: "color-mix(in srgb, var(--bg) 75%, transparent)" }} role="status">
              <Spinner label={`Exporting .${exporting}…`} />
            </div>
          )}
        </div>

        {/* ── Panel ── */}
        <div className="app-aside flex w-[19rem] shrink-0 flex-col border-l border-[var(--border)]">
          <div className="flex shrink-0 gap-1 border-b border-[var(--border)] p-1.5">
            {([["make", "Make", "wand"], ["scene", "Scene", "layers"], ["look", "Look", "spark"]] as const).map(([id, label, icon]) => (
              <button
                key={id}
                onClick={() => setPanel(id)}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-[12px] transition",
                  panel === id ? "bg-[var(--accent)]/18 text-[var(--text)] ring-1 ring-[var(--accent)]" : "text-[var(--muted)] hover:bg-white/6",
                )}
              >
                <Icon name={icon} size={12} />{label}
              </button>
            ))}
          </div>

          {/* The bottom padding keeps the last row (rotation, scale) scrollable
              clear of a phone's home indicator and the shell's own bar. */}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2.5 pb-[calc(env(safe-area-inset-bottom,0px)+3rem)]">
            {panel === "make" && (
              <MakePanel
                scene={scene}
                setScene={setScene}
                setSel={setSel}
                setError={setError}
                capture={capture}
                reframe={frameScene}
              />
            )}
            {panel === "scene" && (
              <ScenePanel
                scene={scene} setScene={setScene} sel={sel} setSel={setSel}
                entity={entity} patch={patch} assets={assets} spawn={spawn}
                ops={{ duplicate, remove: removeEntity, ground, alignOthers, exportOne: (id, f) => void exportAs(f, [id]), busy: !!exporting }}
              />
            )}
            {panel === "look" && <LookPanel scene={scene} setScene={setScene} />}
          </div>
        </div>
      </div>
    </div>
  );
}

/** One row of the scene menu. A component rather than a mapped array of
 *  closures: building those in the render body counts as calling a ref reader
 *  during render, which concurrent rendering does not guarantee is safe. */
function MenuItem({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] hover:bg-[var(--accent)]/18">
      <Icon name={icon} size={12} />{label}
    </button>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   MAKE — describe it, build it, then let the model look at it
   ══════════════════════════════════════════════════════════════════════════ */

function MakePanel({ scene, setScene, setSel, setError, capture, reframe }: {
  scene: Scene;
  setScene: React.Dispatch<React.SetStateAction<Scene>>;
  setSel: (id: string | null) => void;
  setError: (e: string | null) => void;
  capture: (max?: number) => string | null;
  reframe: () => void;
}) {
  const [kindId, setKindId] = useState("map");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [critique, setCritique] = useState<string | null>(null);
  const [shot, setShot] = useState<string | null>(null);
  const [reference, setReference] = useState<string | null>(null);
  const kind = getForgeKind(kindId);

  const sceneSummary = useCallback(() => JSON.stringify({
    sky: scene.sky, ambient: scene.ambient, fog: scene.fog,
    lights: scene.lights.map(({ name, kind: k, position, color, intensity, range }) => ({ name, kind: k, position, color, intensity, range })),
    entities: scene.entities.map((e) => ({ name: e.name, position: e.position, rotation: e.rotation, parts: e.parts.length })),
    fx: scene.fx.map((f) => ({ name: f.name, position: f.position, blend: f.blend })),
  }), [scene]);

  /** Merge what came back. Counting happens before the update because a state
   *  updater must be pure. */
  const applyResult = useCallback((data: unknown, opts: { replace?: boolean } = {}) => {
    const d = (data ?? {}) as Record<string, unknown>;
    let ents = Array.isArray(d.entities) ? d.entities.map(toEntity).filter((e): e is Entity => !!e) : [];
    const lts = Array.isArray(d.lights) ? d.lights.map(toLight).filter((l): l is Light => !!l) : [];
    const ems = Array.isArray(d.fx) ? d.fx.map(toEmitter).filter((e): e is Emitter => !!e) : [];

    // A model that ignores the placement rules produces a heap at the origin
    // where every object is inside every other one. Rescue it and say so,
    // rather than handing back a scene that looks like one object.
    let rescued = 0;
    if (ents.length > 1) {
      const positions = ents.map((e) => e.position);
      rescued = stackedCount(positions);
      if (rescued > 0) {
        const spread = spreadOverlapping(positions);
        ents = ents.map((e, i) => ({ ...e, position: spread[i] }));
      }
    }

    const added = ents.length + lts.length + ems.length;
    setScene((s) => ({
      ...s,
      entities: ents.length ? (opts.replace ? ents : [...s.entities, ...ents]) : s.entities,
      lights: lts.length ? lts : s.lights,
      fx: ems.length ? (kindId === "fx" ? [...s.fx, ...ems] : ems) : s.fx,
      sky: typeof d.sky === "string" && /^#[0-9a-f]{6}$/i.test(d.sky) ? d.sky : s.sky,
      ambient: typeof d.ambient !== "undefined" ? Math.max(0, Math.min(1, num(d.ambient, s.ambient))) : s.ambient,
      fog: typeof d.fog !== "undefined" ? Math.max(0, num(d.fog, s.fog ?? 260)) : s.fog,
    }));
    if (ents.length) { setSel(ents[ents.length - 1].id); setTimeout(reframe, 80); }

    if (added === 0) {
      setError("The reply parsed but contained nothing this scene can use. Try again, or pick a stronger model.");
    } else if (rescued > 0) {
      bus.emit("notify", {
        title: `Added ${added} item${added === 1 ? "" : "s"}`,
        body: `${rescued} arrived stacked at the same spot and were spread out — the model ignored the placement rule. Another pass usually fixes it properly.`,
        kind: "warn",
      });
    } else {
      bus.emit("notify", { title: `Added ${added} item${added === 1 ? "" : "s"}`, kind: "success" });
    }
  }, [kindId, setScene, setSel, setError, reframe]);

  const build = useCallback(async () => {
    if (!prompt.trim() || busy) return;
    setBusy("build"); setError(null); setCritique(null);
    try {
      const needsScene = kindId === "lighting" || kindId === "fx";
      const text = `${prompt}${reference ? "\n\nMatch the reference image: its subject, palette, mood and proportions." : ""}${needsScene ? `\n\nCurrent scene:\n${sceneSummary()}` : ""}`;
      const content: Parameters<typeof ask>[0]["messages"][number]["content"] = reference
        ? [{ type: "text", text }, { type: "image", dataUrl: reference }]
        : text;
      // Scenes are long. A map with sixteen detailed entities does not fit in
      // 16k, and a truncated reply is a wasted call.
      const res = await ask({ messages: [{ role: "user", content }], system: kind.brief, maxTokens: 32000 });
      applyResult(extractJson(res.text), { replace: kindId === "map" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Generation failed.");
    } finally { setBusy(null); }
  }, [prompt, busy, kind, kindId, reference, sceneSummary, setError, applyResult]);

  const look = useCallback(async (andFix: boolean) => {
    if (busy) return;
    const png = capture();
    if (!png) { setError("Could not read the viewport."); return; }
    setShot(png);
    setBusy(andFix ? "fix" : "look"); setError(null); setCritique(null);
    try {
      const res = await ask({
        maxTokens: andFix ? 32000 : 700,
        system: andFix
          ? `You are an art director who can edit the scene. You are shown a render and the scene data.

Look at the IMAGE first and find what is actually wrong: objects floating or sunk into the ground, objects stacked in one place, wrong relative scale, a flat or muddy palette, everything at one height, lighting with no direction, an empty or unbalanced composition.

Then fix it. Return ONE json block with only what should change:
{ "sky": "#rrggbb", "ambient": 0..1, "fog": number, "lights": [...], "entities": [...] }

Include "entities" ONLY if you are rebuilding the layout — doing so REPLACES every object, so include all of them, each with its own distinct "position" in metres. Do not return entities all at the same position.

Before the json, write two sentences saying what you saw and what you changed.`
          : `You are an art director reviewing a render of a 3D scene. You are shown the image and the scene data.

Say what is actually visible and what is wrong with it. Be specific and concrete — "the roof floats about half a metre above the walls", not "check your alignment". Cover composition, scale, palette and lighting. Three to five bullets, no preamble, no praise padding. End with the single highest-value change to make next.`,
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
        try { applyResult(extractJson(res.text), { replace: true }); }
        catch { setError("It described changes but returned no usable JSON. The critique is still worth reading."); }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "The model could not look at the scene.");
    } finally { setBusy(null); }
  }, [busy, capture, sceneSummary, applyResult, setError]);

  return (
    <div>
      <div className="mb-2 grid grid-cols-3 gap-1.5">
        {FORGE_KINDS.map((k) => (
          <button
            key={k.id}
            onClick={() => setKindId(k.id)}
            title={k.blurb}
            className={cn(
              "flex flex-col items-center gap-1 rounded-lg border px-1 py-2 text-[10px] transition",
              kindId === k.id
                ? "border-[var(--accent)] bg-[var(--accent)]/14"
                : "border-[var(--border)] hover:bg-white/5",
            )}
          >
            <Icon name={k.icon} size={16} style={{ color: kindId === k.id ? "var(--accent)" : "var(--muted)" }} />
            <span className="truncate">{k.name}</span>
          </button>
        ))}
      </div>
      <p className="mb-2 text-[11px] leading-snug text-[var(--muted)]">{kind.blurb}</p>

      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) build(); }}
        rows={3}
        placeholder={kind.placeholder}
        className="os-input mb-2 resize-y !py-1.5 text-[12px]"
      />

      {reference && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-[var(--accent)] p-1.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={reference} alt="Reference" className="h-9 w-9 shrink-0 rounded object-cover" />
          <span className="min-w-0 flex-1 text-[10px] leading-snug text-[var(--muted)]">Reference attached — needs a model that can see.</span>
          <button className="shrink-0 opacity-60 hover:opacity-100" onClick={() => setReference(null)} aria-label="Remove reference"><Icon name="close" size={11} /></button>
        </div>
      )}

      <div className="mb-3 flex gap-1.5">
        <button className="os-btn flex-1 !py-1.5 text-[12px]" data-variant="primary" onClick={build} disabled={!!busy || !prompt.trim()}>
          <Icon name="wand" size={12} className="mr-1.5" />{busy === "build" ? "Building…" : "Build"}
        </button>
        <label className="os-btn shrink-0 !py-1.5" title="Attach a reference image for a vision model to work from">
          <Icon name="image" size={12} />
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

      <div className="rounded-lg border border-[var(--border)] p-2">
        <div className="mb-1 flex items-center gap-1.5">
          <Icon name="eye" size={12} style={{ color: "var(--accent)" }} />
          <span className="text-[12px] font-medium">Let it look</span>
        </div>
        <p className="mb-2 text-[10.5px] leading-relaxed text-[var(--muted)]">
          Renders the viewport and sends the picture to your model. Reading JSON it is guessing at what the scene
          looks like; looking at the render it can see that the roof floats. Needs a model with vision.
        </p>
        <div className="flex gap-1.5">
          <button className="os-btn flex-1 !py-1 text-[11px]" onClick={() => look(false)} disabled={!!busy || scene.entities.length === 0}>
            {busy === "look" ? "Looking…" : "Review"}
          </button>
          <button className="os-btn flex-1 !py-1 text-[11px]" onClick={() => look(true)} disabled={!!busy || scene.entities.length === 0}>
            {busy === "fix" ? "Fixing…" : "Review & fix"}
          </button>
        </div>
      </div>

      {busy && <div className="mt-2"><Spinner label={busy === "build" ? "Composing…" : "Looking at the render…"} /></div>}

      {shot && (critique || busy === "look" || busy === "fix") && (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img src={shot} alt="What the model was shown" className="mt-2 w-full rounded-lg border border-[var(--border)]" />
      )}

      {critique && (
        <div className="mt-2 rounded-lg border border-[var(--border)] p-2">
          <div className="os-label mb-1">What it saw</div>
          <Markdown text={critique} className="!text-[11px]" />
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   SCENE — what is in it, and the selected object
   ══════════════════════════════════════════════════════════════════════════ */

interface SceneOps {
  duplicate: (id: string) => void;
  remove: (id: string) => void;
  ground: (id: string) => void;
  alignOthers: (id: string, axis: AlignAxis) => void;
  exportOne: (id: string, f: MeshFormat) => void;
  busy: boolean;
}

function ScenePanel({ scene, sel, setSel, entity, patch, assets, spawn, ops }: {
  scene: Scene;
  setScene: React.Dispatch<React.SetStateAction<Scene>>;
  sel: string | null;
  setSel: (id: string | null) => void;
  entity: Entity | null;
  patch: (id: string, p: Partial<Entity>) => void;
  assets: { assets: Asset[]; add: (a: Asset) => void };
  spawn: (id: string) => void;
  ops: SceneOps;
}) {
  return (
    <div>
      <div className="os-label mb-1.5">Objects ({scene.entities.length})</div>
      {scene.entities.length === 0 && (
        <p className="mb-3 text-[11px] leading-relaxed text-[var(--muted)]">
          Nothing placed. Describe something on the Make tab, or drop in an asset below.
        </p>
      )}
      <div className="mb-3 space-y-0.5">
        {scene.entities.map((e) => (
          <div key={e.id} className={cn("flex items-center gap-1.5 rounded-md px-1.5 py-1", sel === e.id ? "bg-[var(--accent)]/16" : "hover:bg-white/6")}>
            <button onClick={() => patch(e.id, { visible: !e.visible })} className="opacity-60 hover:opacity-100" title={e.visible ? "Hide" : "Show"} aria-label={`${e.visible ? "Hide" : "Show"} ${e.name}`}>
              <Icon name={e.visible ? "eye" : "eyeoff"} size={11} />
            </button>
            <button onClick={() => setSel(e.id)} className="min-w-0 flex-1 truncate text-left text-[11.5px]">{e.name}</button>
            <span className="shrink-0 text-[9px] text-[var(--muted)]" title={`${e.parts.length} parts`}>{e.parts.length}</span>
            <button
              className="opacity-40 hover:opacity-100"
              onClick={() => ops.remove(e.id)}
              aria-label={`Delete ${e.name}`}
              title="Delete (undo with Ctrl+Z)"
            >
              <Icon name="close" size={11} />
            </button>
          </div>
        ))}
      </div>

      {entity && (
        <div className="mb-3 rounded-lg border border-[var(--accent)] p-2">
          <input
            value={entity.name}
            onChange={(e) => patch(entity.id, { name: e.target.value })}
            className="os-input mb-2 !py-1 text-[12px] font-medium"
          />
          {(["position", "rotation", "scale"] as const).map((field) => (
            <div key={field} className="mb-1.5">
              <div className="os-label mb-1 !text-[9px]">{field}{field === "rotation" ? " (degrees)" : field === "position" ? " (metres)" : ""}</div>
              <div className="flex gap-1">
                {[0, 1, 2].map((axis) => (
                  <input
                    key={axis} type="number" step={field === "scale" ? 0.1 : field === "rotation" ? 5 : 0.5}
                    value={entity[field][axis]}
                    onChange={(ev) => { const v = [...entity[field]] as Vec3; v[axis] = Number(ev.target.value); patch(entity.id, { [field]: v }); }}
                    className="os-input !py-1 text-[11px]"
                    aria-label={`${field} ${"xyz"[axis]}`}
                  />
                ))}
              </div>
            </div>
          ))}
          <div className="mt-2 flex flex-wrap gap-1">
            <button className="os-btn !px-2 !py-0.5 text-[10.5px]" title="Duplicate (Ctrl+D), placed clear of other objects" onClick={() => ops.duplicate(entity.id)}>
              Duplicate
            </button>
            <button className="os-btn !px-2 !py-0.5 text-[10.5px]" title="Rest the lowest part on the ground (G). Rotation is not accounted for." onClick={() => ops.ground(entity.id)}>
              Drop to ground
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
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1">
            <span className="text-[10px] text-[var(--muted)]">Align others to this:</span>
            {([0, 1, 2] as const).map((axis) => (
              <button
                key={axis}
                className="os-btn !px-2 !py-0.5 text-[10.5px]"
                disabled={scene.entities.length < 2}
                aria-label={`Align every other object's ${"XYZ"[axis]} to this one`}
                onClick={() => ops.alignOthers(entity.id, axis)}
              >
                {"XYZ"[axis]}
              </button>
            ))}
            <span className="flex-1" />
            <button className="os-btn !px-2 !py-0.5 text-[10.5px]" disabled={ops.busy} onClick={() => ops.exportOne(entity.id, "glb")}>.glb</button>
            <button className="os-btn !px-2 !py-0.5 text-[10.5px]" disabled={ops.busy} onClick={() => ops.exportOne(entity.id, "obj")}>.obj</button>
          </div>
        </div>
      )}

      <div className="os-label mb-1.5">Asset Studio</div>
      {assets.assets.length === 0 ? (
        <p className="text-[11px] text-[var(--muted)]">No assets yet.</p>
      ) : (
        <div className="grid grid-cols-3 gap-1.5">
          {assets.assets.slice(0, 12).map((a) => (
            <button key={a.id} onClick={() => spawn(a.id)} className="rounded-lg border border-[var(--border)] p-1.5 text-center hover:bg-white/5" title={`Place ${a.name}`}>
              <Icon name={a.icon || "assets"} size={15} style={{ color: "var(--accent)" }} />
              <div className="truncate text-[9.5px]">{a.name}</div>
            </button>
          ))}
        </div>
      )}
      <button className="os-btn mt-2 w-full !py-1 text-[11px]" onClick={() => bus.emit("app:open", { appId: "assets" })}>
        Open Asset Studio
      </button>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   LOOK — sky, light, atmosphere, particles
   ══════════════════════════════════════════════════════════════════════════ */

const SKY_PRESETS: Array<{ name: string; sky: string; ambient: number; fog: number; lights: Array<Partial<Light>> }> = [
  { name: "Noon", sky: "#9cc4e8", ambient: 0.55, fog: 320, lights: [{ color: "#fffaf0", intensity: 1.35, position: [-0.4, 2.4, 0.7] }, { color: "#bcd8ff", intensity: 0.45, position: [0.8, 0.6, -0.8] }] },
  { name: "Golden", sky: "#e8b97f", ambient: 0.34, fog: 220, lights: [{ color: "#ffca7a", intensity: 1.5, position: [-1.4, 0.65, 0.5] }, { color: "#7fa8e0", intensity: 0.34, position: [1, 0.7, -0.7] }] },
  { name: "Dusk", sky: "#4a4b74", ambient: 0.26, fog: 170, lights: [{ color: "#ff9d6e", intensity: 0.9, position: [-1.6, 0.35, 0.3] }, { color: "#6f86d8", intensity: 0.5, position: [0.7, 1, -0.9] }] },
  { name: "Night", sky: "#101a2e", ambient: 0.16, fog: 130, lights: [{ color: "#9fb7ff", intensity: 0.55, position: [-0.5, 1.6, -0.9] }, { color: "#38507f", intensity: 0.25, position: [1, 0.4, 0.8] }] },
  { name: "Overcast", sky: "#b9c0c8", ambient: 0.68, fog: 240, lights: [{ color: "#e8eef5", intensity: 0.75, position: [-0.3, 2.8, 0.4] }, { color: "#c6cfda", intensity: 0.4, position: [0.6, 1.2, -0.6] }] },
  { name: "Studio", sky: "#1a1c22", ambient: 0.3, fog: 0, lights: [{ color: "#ffffff", intensity: 1.5, position: [-0.8, 1.4, 1.1] }, { color: "#8fa8d8", intensity: 0.6, position: [1.2, 0.5, -0.9] }] },
];

function LookPanel({ scene, setScene }: { scene: Scene; setScene: React.Dispatch<React.SetStateAction<Scene>> }) {
  const setLight = (id: string, p: Partial<Light>) =>
    setScene((s) => ({ ...s, lights: s.lights.map((l) => (l.id === id ? { ...l, ...p } : l)) }));
  const setFx = (id: string, p: Partial<Emitter>) =>
    setScene((s) => ({ ...s, fx: s.fx.map((f) => (f.id === id ? { ...f, ...p } : f)) }));

  const live = useMemo(
    () => Math.round(scene.fx.reduce((a, f) => a + (f.on === false ? 0 : f.rate * f.life), 0)),
    [scene.fx],
  );

  const applyPreset = (p: (typeof SKY_PRESETS)[number]) =>
    setScene((s) => ({
      ...s,
      sky: p.sky,
      ambient: p.ambient,
      fog: p.fog,
      // Presets retune the two primary lights and leave anything you added.
      lights: s.lights.map((l, i) => (p.lights[i] ? { ...l, ...p.lights[i] } as Light : l)),
    }));

  return (
    <div>
      <div className="os-label mb-1.5">Time of day</div>
      <div className="mb-3 grid grid-cols-3 gap-1.5">
        {SKY_PRESETS.map((p) => (
          <button
            key={p.name}
            onClick={() => applyPreset(p)}
            className={cn("rounded-lg border p-1 text-[10px] transition hover:-translate-y-0.5", scene.sky === p.sky ? "border-[var(--accent)]" : "border-[var(--border)]")}
          >
            <span className="mb-1 block h-6 w-full rounded" style={{ background: `linear-gradient(${p.sky}, color-mix(in srgb, ${p.sky} 45%, #000))` }} />
            {p.name}
          </button>
        ))}
      </div>

      <div className="mb-3 space-y-1.5">
        <label className="flex items-center gap-2 text-[11px]">
          <span className="w-16 shrink-0 text-[var(--muted)]">Sky</span>
          <input type="color" value={scene.sky} onChange={(e) => setScene((s) => ({ ...s, sky: e.target.value }))} className="h-6 w-10 cursor-pointer rounded border border-[var(--border)] bg-transparent" />
        </label>
        <label className="block text-[11px]">
          <span className="text-[var(--muted)]">Ambient</span> {scene.ambient.toFixed(2)}
          <input type="range" min={0} max={1} step={0.01} value={scene.ambient} onChange={(e) => setScene((s) => ({ ...s, ambient: Number(e.target.value) }))} className="w-full accent-[var(--accent)]" />
        </label>
        <label className="block text-[11px]">
          <span className="text-[var(--muted)]">Fog</span> {scene.fog ? `${Math.round(scene.fog)}m` : "off"}
          <input type="range" min={0} max={600} step={10} value={scene.fog ?? 0} onChange={(e) => setScene((s) => ({ ...s, fog: Number(e.target.value) }))} className="w-full accent-[var(--accent)]" />
        </label>
      </div>

      <div className="os-label mb-1.5 flex items-center justify-between">
        <span>Lights ({scene.lights.length})</span>
        <button
          className="os-btn !px-1.5 !py-0 !text-[10px]"
          title="Add a point light"
          onClick={() => setScene((s) => ({ ...s, lights: [...s.lights, { id: uid("lt"), name: "Point light", kind: "point", position: [0, 3, 0], color: "#ffd9a0", intensity: 1.4, range: 10, on: true }] }))}
        >
          <Icon name="plus" size={10} />
        </button>
      </div>
      {scene.lights.map((l) => (
        <div key={l.id} className="mb-1.5 rounded-lg border border-[var(--border)] p-2">
          <div className="mb-1 flex items-center gap-1.5">
            <button onClick={() => setLight(l.id, { on: l.on === false })} title={l.on === false ? "Enable" : "Disable"} className="opacity-70 hover:opacity-100">
              <Icon name={l.on === false ? "eyeoff" : "eye"} size={11} />
            </button>
            <input value={l.name} onChange={(e) => setLight(l.id, { name: e.target.value })} className="min-w-0 flex-1 bg-transparent text-[11.5px] outline-none" />
            <input type="color" value={l.color} onChange={(e) => setLight(l.id, { color: e.target.value })} className="h-5 w-7 cursor-pointer rounded border border-[var(--border)] bg-transparent" />
            <button className="opacity-40 hover:opacity-100" onClick={() => setScene((s) => ({ ...s, lights: s.lights.filter((x) => x.id !== l.id) }))} aria-label="Delete light">
              <Icon name="close" size={11} />
            </button>
          </div>
          <div className="mb-1 flex gap-1">
            {(["directional", "point"] as const).map((k) => (
              <button key={k} onClick={() => setLight(l.id, { kind: k })} className={cn("os-btn !px-1.5 !py-0 !text-[9.5px]", l.kind === k && "!border-[var(--accent)] !bg-[var(--accent)]/16")}>{k}</button>
            ))}
            <span className="ml-auto self-center text-[9px] text-[var(--muted)]">{l.kind === "directional" ? "direction" : "position"}</span>
          </div>
          <div className="mb-1 flex gap-1">
            {[0, 1, 2].map((axis) => (
              <input
                key={axis} type="number" step={0.25} value={l.position[axis]}
                onChange={(e) => { const v = [...l.position] as Vec3; v[axis] = Number(e.target.value); setLight(l.id, { position: v }); }}
                className="os-input !py-0.5 text-[10px]"
                aria-label={`light ${"xyz"[axis]}`}
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
              <input type="range" min={1} max={80} step={1} value={l.range} onChange={(e) => setLight(l.id, { range: Number(e.target.value) })} className="w-full accent-[var(--accent)]" />
            </label>
          )}
        </div>
      ))}

      <div className="os-label mb-1.5 mt-3 flex items-center justify-between">
        <span>Particles ({scene.fx.length})</span>
        <span className="flex items-center gap-1.5">
          {live > 0 && <span className="!normal-case">~{live} live</span>}
          <button
            className="os-btn !px-1.5 !py-0 !text-[10px]"
            title="Add an emitter"
            onClick={() => setScene((s) => ({ ...s, fx: [...s.fx, { id: uid("fx"), name: "Emitter", position: [0, 0.6, 0], color: "#ffb347", color2: "#5a1d05", rate: 40, life: 1.5, speed: 1.8, spread: 0.3, size: 0.12, gravity: 0.8, blend: "add", on: true }] }))}
          >
            <Icon name="plus" size={10} />
          </button>
        </span>
      </div>
      {scene.fx.length === 0 && (
        <p className="text-[10.5px] leading-relaxed text-[var(--muted)]">
          None yet. Ask the Make tab for &ldquo;a crackling campfire&rdquo; and it will layer the emitters for you.
        </p>
      )}
      {scene.fx.map((f) => (
        <div key={f.id} className="mb-1.5 rounded-lg border border-[var(--border)] p-2">
          <div className="mb-1 flex items-center gap-1.5">
            <button onClick={() => setFx(f.id, { on: f.on === false })} className="opacity-70 hover:opacity-100">
              <Icon name={f.on === false ? "eyeoff" : "eye"} size={11} />
            </button>
            <input value={f.name} onChange={(e) => setFx(f.id, { name: e.target.value })} className="min-w-0 flex-1 bg-transparent text-[11.5px] outline-none" />
            <input type="color" value={f.color} onChange={(e) => setFx(f.id, { color: e.target.value })} className="h-5 w-6 cursor-pointer rounded border border-[var(--border)] bg-transparent" title="Colour at birth" />
            <input type="color" value={f.color2} onChange={(e) => setFx(f.id, { color2: e.target.value })} className="h-5 w-6 cursor-pointer rounded border border-[var(--border)] bg-transparent" title="Colour at death" />
            <button className="opacity-40 hover:opacity-100" onClick={() => setScene((s) => ({ ...s, fx: s.fx.filter((x) => x.id !== f.id) }))} aria-label="Delete emitter">
              <Icon name="close" size={11} />
            </button>
          </div>
          <div className="mb-1 flex gap-1">
            {[0, 1, 2].map((axis) => (
              <input
                key={axis} type="number" step={0.5} value={f.position[axis]}
                onChange={(e) => { const v = [...f.position] as Vec3; v[axis] = Number(e.target.value); setFx(f.id, { position: v }); }}
                className="os-input !py-0.5 text-[10px]"
                aria-label={`emitter ${"xyz"[axis]}`}
              />
            ))}
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
