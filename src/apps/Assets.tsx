"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { bus } from "@/kernel/bus";
import type { AppProps } from "@/kernel/types";
import { uid, download } from "@/lib/format";
import { Empty, ErrorNote, Tabs, CopyButton, Spinner } from "./_ui";
import { sanitizeParts } from "@/lib/forge-ops";
import { trackJob } from "@/kernel/jobs";
import { exportMeshes, saveBlob, type MeshFormat } from "./_forgeExport";
import { ask } from "@/lib/useAI";
import { getForgeKind, extractJson } from "@/lib/forge-schema";
import { renderThumbnail, invalidateThumbnail } from "@/lib/forge-thumbnail";
import { cn } from "@/lib/cn";
import { Icon } from "@/shell/icons";

/* ────────────────────────────────────────────────────────────────────────────
   Asset Studio — grown out of the ported asset_forge_library.

   The original's schema is preserved exactly (id / name / kind / icon / tags /
   physics / parts), so assets exported from AssetForgePhysics import here
   unchanged and assets built here go back out the same way. Forge 3D reads
   from this store directly.

   What is new is that you no longer have to type twenty parts by hand. Describe
   the thing and a model composes it out of primitives; every asset gets a real
   lit thumbnail rendered from its own geometry, so the library shows what you
   actually made rather than a coloured square.
   ──────────────────────────────────────────────────────────────────────────── */

export interface AssetPart {
  id: string;
  name: string;
  shape: "box" | "sphere" | "cylinder" | "cone" | "plane" | "capsule";
  position: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number];
  color?: string;
  metalness?: number;
  roughness?: number;
  emissive?: string;
}

export interface AssetPhysics {
  bodyType: "static" | "dynamic" | "kinematic";
  collider: "box" | "sphere" | "capsule" | "mesh" | "none";
  mass: number;
  friction: number;
  restitution: number;
  solid: boolean;
}

export interface Asset {
  id: string;
  name: string;
  kind: "prop" | "character" | "structure" | "light" | "puzzle" | "weapon" | "vehicle" | "fx";
  icon: string;
  tags: string[];
  physics: AssetPhysics;
  parts: AssetPart[];
  updatedAt: number;
}

const SEED: Asset[] = [
  {
    id: "asset_crate", name: "Physics Crate", kind: "prop", icon: "gate", tags: ["physics", "crate"],
    physics: { bodyType: "dynamic", collider: "box", mass: 3, friction: 0.7, restitution: 0.05, solid: true },
    parts: [{ id: "p1", name: "Wooden Crate Body", shape: "box", position: [0, 0.55, 0], scale: [1.1, 1.1, 1.1], color: "#a4733f", roughness: 0.85, metalness: 0 }],
    updatedAt: Date.now(),
  },
  {
    id: "asset_barrel", name: "Barrel", kind: "prop", icon: "assets", tags: ["prop", "barrel"],
    physics: { bodyType: "dynamic", collider: "capsule", mass: 5, friction: 0.6, restitution: 0.1, solid: true },
    parts: [{ id: "p1", name: "Barrel Body", shape: "cylinder", position: [0, 0.6, 0], scale: [0.5, 1.2, 0.5], color: "#6b4a2c", roughness: 0.8, metalness: 0.1 }],
    updatedAt: Date.now(),
  },
  {
    id: "asset_tree", name: "Low Poly Tree", kind: "prop", icon: "assets", tags: ["nature", "lowpoly"],
    physics: { bodyType: "static", collider: "capsule", mass: 0, friction: 0.9, restitution: 0, solid: true },
    parts: [
      { id: "p1", name: "Trunk", shape: "cylinder", position: [0, 0.9, 0], scale: [0.18, 1.8, 0.18], color: "#5b3a21", roughness: 0.95, metalness: 0 },
      { id: "p2", name: "Canopy", shape: "cone", position: [0, 2.3, 0], scale: [1.1, 1.8, 1.1], color: "#2f6b33", roughness: 0.9, metalness: 0 },
    ],
    updatedAt: Date.now(),
  },
  {
    id: "asset_torch", name: "Torch Light", kind: "light", icon: "spark", tags: ["light", "fx"],
    physics: { bodyType: "static", collider: "none", mass: 0, friction: 0, restitution: 0, solid: false },
    parts: [
      { id: "p1", name: "Handle", shape: "cylinder", position: [0, 0.4, 0], scale: [0.05, 0.8, 0.05], color: "#3b2a1a", roughness: 1, metalness: 0 },
      { id: "p2", name: "Flame", shape: "sphere", position: [0, 0.9, 0], scale: [0.16, 0.24, 0.16], color: "#ffb347", emissive: "#ff7a18", roughness: 0.3, metalness: 0 },
    ],
    updatedAt: Date.now(),
  },
  {
    id: "asset_npc", name: "Modular Humanoid NPC", kind: "character", icon: "agents", tags: ["character", "npc"],
    physics: { bodyType: "kinematic", collider: "capsule", mass: 70, friction: 0.5, restitution: 0, solid: true },
    parts: [
      { id: "p1", name: "Torso", shape: "box", position: [0, 1.1, 0], scale: [0.45, 0.7, 0.25], color: "#4a6fa5", roughness: 0.7, metalness: 0 },
      { id: "p2", name: "Head", shape: "sphere", position: [0, 1.65, 0], scale: [0.22, 0.24, 0.22], color: "#d9a97e", roughness: 0.8, metalness: 0 },
      { id: "p3", name: "Legs", shape: "box", position: [0, 0.45, 0], scale: [0.36, 0.9, 0.22], color: "#2f3b52", roughness: 0.8, metalness: 0 },
    ],
    updatedAt: Date.now(),
  },
  {
    id: "asset_door", name: "Puzzle Door", kind: "puzzle", icon: "app", tags: ["puzzle", "interactive"],
    physics: { bodyType: "kinematic", collider: "box", mass: 0, friction: 0.4, restitution: 0, solid: true },
    parts: [
      { id: "p1", name: "Frame", shape: "box", position: [0, 1.2, 0], scale: [1.3, 2.4, 0.14], color: "#4b4b53", roughness: 0.6, metalness: 0.5 },
      { id: "p2", name: "Rune", shape: "sphere", position: [0, 1.4, 0.09], scale: [0.18, 0.18, 0.04], color: "#67e8f9", emissive: "#22d3ee", roughness: 0.2, metalness: 0.2 },
    ],
    updatedAt: Date.now(),
  },
];

interface AssetState {
  assets: Asset[];
  add: (a: Asset) => void;
  patch: (id: string, p: Partial<Asset>) => void;
  remove: (id: string) => void;
  importJson: (text: string) => { ok: number; error?: string };
  reseed: () => void;
}

export const useAssets = create<AssetState>()(
  persist(
    (set, get) => ({
      assets: SEED,
      add: (a) => set((s) => ({ assets: [a, ...s.assets] })),
      patch: (id, p) => set((s) => ({ assets: s.assets.map((a) => (a.id === id ? { ...a, ...p, updatedAt: Date.now() } : a)) })),
      remove: (id) => set((s) => ({ assets: s.assets.filter((a) => a.id !== id) })),
      importJson: (text) => {
        try {
          const parsed = JSON.parse(text);
          // Accept either a library file or a single .asset.json, which is what
          // the original exporter produced.
          const list: unknown[] = Array.isArray(parsed) ? parsed : parsed.assets ?? [parsed];
          const valid = list.filter((x): x is Asset => Boolean(x && typeof x === "object" && "name" in (x as object) && "parts" in (x as object)));
          if (!valid.length) return { ok: 0, error: "No assets found in that file." };
          const existing = new Set(get().assets.map((a) => a.id));
          const incoming = valid.map((a) => (existing.has(a.id) ? { ...a, id: uid("asset") } : a));
          set((s) => ({ assets: [...incoming, ...s.assets] }));
          return { ok: incoming.length };
        } catch (e) {
          return { ok: 0, error: e instanceof Error ? e.message : "Invalid JSON." };
        }
      },
      reseed: () => set({ assets: SEED }),
    }),
    { name: "webaios.assets.v1", storage: createJSONStorage(() => localStorage) },
  ),
);

/** A small render of an asset, drawn by the same engine as the Forge viewport.
 *
 *  Rendered offscreen through one shared WebGL context — a canvas per card
 *  exhausts the browser's context limit at around sixteen and then previews
 *  start silently disappearing. */
function AssetThumb({ asset, size = 256 }: { asset: Asset; size?: number }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    // Rendering is synchronous and touches the GPU, so it is deferred out of
    // the commit — a library of thirty assets would otherwise block paint.
    let alive = true;
    const t = setTimeout(() => {
      if (!alive) return;
      invalidateThumbnail(asset.id);
      setUrl(renderThumbnail({ id: asset.id, updatedAt: asset.updatedAt, parts: asset.parts }, size));
    }, 0);
    return () => { alive = false; clearTimeout(t); };
  }, [asset, size]);

  if (!url) {
    return (
      <div className="grid h-full w-full place-items-center opacity-25">
        <Icon name={asset.icon || "assets"} size={22} />
      </div>
    );
  }
  /* eslint-disable-next-line @next/next/no-img-element */
  return <img src={url} alt={`${asset.name} preview`} className="h-full w-full object-contain" />;
}

/** Describe an asset; a model composes it. */
function AssetForge({ onCreated, setError }: { onCreated: (a: Asset) => void; setError: (e: string | null) => void }) {
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<Asset["kind"]>("prop");
  const [busy, setBusy] = useState(false);
  const [reference, setReference] = useState<string | null>(null);
  const [chars, setChars] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(async () => {
    if (!prompt.trim() || busy) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(true); setError(null); setChars(0); setNote(null);
    try {
      await trackJob({ kind: "ai", title: `Asset Studio: ${prompt.slice(0, 40)}`, target: { appId: "assets" } }, async (report) => {
      // Characters and props want different briefs — a prop composed like a
      // person, or a person composed like a prop, is the usual failure here.
      const brief = getForgeKind(kind === "character" ? "npc" : "asset").brief;
      const content: Parameters<typeof ask>[0]["messages"][number]["content"] = reference
        ? [{ type: "text", text: `${prompt}\n\nMatch the reference image: subject, palette and proportions.` }, { type: "image", dataUrl: reference }]
        : prompt;
      let reported = 0;
      const res = await ask({
        messages: [{ role: "user", content }], system: brief, maxTokens: 12000, signal: ctrl.signal,
        onDelta: (_d, full) => {
          setChars(full.length);
          if (full.length - reported >= 600) { reported = full.length; report(undefined, `${full.length.toLocaleString()} chars received`); }
        },
      });
      let data: { entities?: Array<{ name?: string; parts?: unknown[]; physics?: AssetPhysics }> };
      try {
        data = extractJson(res.text) as typeof data;
      } catch {
        throw new Error(`The reply was not the JSON asset format (${res.text.length.toLocaleString()} chars came back). Try again, or pick a stronger model.`);
      }
      const first = data?.entities?.[0];
      if (!first) throw new Error("The reply had no entity in it.");
      // Keep what can be drawn; say what could not be, rather than failing
      // the whole asset over one malformed part.
      const clean = sanitizeParts(first.parts);
      if (!clean.parts.length) throw new Error(`None of the ${Array.isArray(first.parts) ? first.parts.length : 0} parts in the reply could be drawn.`);
      if (clean.dropped || clean.reshaped) {
        setNote(`${clean.parts.length} part(s) kept.${clean.dropped ? ` ${clean.dropped} malformed part(s) dropped.` : ""}${clean.reshaped ? ` ${clean.reshaped} unknown shape(s) drawn as boxes.` : ""}`);
      }
      onCreated({
        id: uid("asset"),
        name: first.name || prompt.slice(0, 40),
        kind,
        icon: kind === "character" ? "agents" : kind === "light" ? "spark" : kind === "fx" ? "sparkles" : "assets",
        tags: ["ai", kind],
        physics: first.physics ?? { bodyType: "dynamic", collider: "box", mass: 1, friction: 0.5, restitution: 0.1, solid: true },
        parts: clean.parts as AssetPart[],
        updatedAt: Date.now(),
      });
      });
      setPrompt("");
    } catch (e) {
      setError((e as Error).name === "AbortError" ? "Stopped. Nothing was added." : e instanceof Error ? e.message : "Generation failed.");
    } finally { setBusy(false); abortRef.current = null; }
  }, [prompt, busy, kind, reference, onCreated, setError]);

  return (
    <div className="os-card mb-3">
      <div className="mb-1.5 flex items-center gap-1.5">
        <Icon name="wand" size={14} style={{ color: "var(--accent)" }} />
        <span className="text-[12.5px] font-medium">Describe an asset</span>
        <div className="flex-1" />
        <select value={kind} onChange={(e) => setKind(e.target.value as Asset["kind"])} className="os-input !w-auto !py-0.5 text-[10.5px]">
          {["prop", "character", "structure", "light", "puzzle", "weapon", "vehicle", "fx"].map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
      </div>
      <div className="flex gap-1.5">
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
          placeholder="a rusted fuel drum with a dented lid and a stencilled number"
          className="os-input min-w-0 flex-1 !py-1 text-[12px]"
        />
        <label className="os-btn shrink-0 !py-1 text-[11px]" title="Attach a reference image — needs a model that can see">
          <Icon name="image" size={11} />
          <input
            type="file" accept="image/*" hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              if (f.size > 4 * 1024 * 1024) { setError("Pick an image under 4 MB."); return; }
              const r = new FileReader();
              r.onload = () => setReference(String(r.result));
              r.readAsDataURL(f);
              e.target.value = "";
            }}
          />
        </label>
        <button className="os-btn shrink-0 !py-1 text-[11px]" data-variant="primary" onClick={run} disabled={busy || !prompt.trim()}>
          {busy ? "Building…" : "Build"}
        </button>
      </div>
      {reference && (
        <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-[var(--muted)]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={reference} alt="Reference" className="h-8 w-8 rounded object-cover" />
          Reference attached
          <button className="opacity-60 hover:opacity-100" onClick={() => setReference(null)} aria-label="Remove the reference image"><Icon name="close" size={10} /></button>
        </div>
      )}
      {busy && (
        <div className="mt-1.5 flex items-center gap-2">
          <Spinner label={chars ? `Composing parts · ${chars.toLocaleString()} chars received` : "Waiting for the model…"} />
          <button className="os-btn !px-2 !py-0.5 text-[10.5px]" onClick={() => abortRef.current?.abort()}>Stop</button>
        </div>
      )}
      {note && !busy && <p className="mt-1.5 text-[10.5px] text-[var(--muted)]" role="status">{note}</p>}
    </div>
  );
}

export default function Assets({}: AppProps) {
  const store = useAssets();
  const [tab, setTab] = useState("library");
  const [sel, setSel] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("all");
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  /* Undo for the inspector. Each entry is the whole asset as it was, which
     is small; edits to the same asset within 700ms (typing, a colour drag)
     fold into one entry. A delete is undoable too. */
  const [undoLog, setUndoLog] = useState<Array<{ asset: Asset; at: number; deleted?: boolean }>>([]);
  const [exporting, setExporting] = useState<MeshFormat | null>(null);
  const edit = useCallback((id: string, p: Partial<Asset>) => {
    const cur = store.assets.find((a) => a.id === id);
    if (cur) {
      const now = Date.now();
      setUndoLog((l) => {
        const last = l[l.length - 1];
        if (last && !last.deleted && last.asset.id === id && now - last.at < 700) return [...l.slice(0, -1), { ...last, at: now }];
        return [...l, { asset: cur, at: now }].slice(-50);
      });
    }
    store.patch(id, p);
  }, [store]);
  const undoEdit = useCallback(() => {
    const last = undoLog[undoLog.length - 1];
    if (!last) return;
    if (last.deleted) { store.add(last.asset); setSel(last.asset.id); setTab("inspect"); }
    else store.patch(last.asset.id, last.asset);
    setUndoLog((l) => l.slice(0, -1));
  }, [undoLog, store]);
  const removeAsset = useCallback((a: Asset) => {
    setUndoLog((l) => [...l, { asset: a, at: Date.now(), deleted: true }].slice(-50));
    store.remove(a.id);
    setSel(null);
    setTab("library");
  }, [store]);
  const duplicateAsset = useCallback((a: Asset) => {
    const copy: Asset = { ...a, id: uid("asset"), name: `${a.name} copy`, parts: a.parts.map((p) => ({ ...p, id: uid("part") })), updatedAt: Date.now() };
    store.add(copy);
    setSel(copy.id);
  }, [store]);
  const exportAsset = useCallback(async (a: Asset, format: MeshFormat) => {
    setExporting(format);
    setError(null);
    try {
      const out = await exportMeshes(
        { entities: [{ id: a.id, name: a.name, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], visible: true, parts: a.parts }], lights: [], fx: [], ambient: 0.5, sky: "#000000" },
        a.name, format,
      );
      saveBlob(out.blob, out.filename);
      bus.emit("notify", { title: `Exported ${out.filename}`, body: `${out.meshes} mesh${out.meshes === 1 ? "" : "es"}, ${(out.bytes / 1024).toFixed(1)} KB`, kind: "success" });
    } catch (e) {
      setError(e instanceof Error ? `Export failed: ${e.message}` : "Export failed.");
    } finally { setExporting(null); }
  }, []);

  const kinds = useMemo(() => ["all", ...Array.from(new Set(store.assets.map((a) => a.kind)))], [store.assets]);
  const filtered = store.assets.filter(
    (a) => (kind === "all" || a.kind === kind) && (!q.trim() || (a.name + a.tags.join(" ")).toLowerCase().includes(q.toLowerCase())),
  );
  const asset = store.assets.find((a) => a.id === sel) ?? null;

  const create = useCallback(() => {
    const a: Asset = {
      id: uid("asset"), name: "New asset", kind: "prop", icon: "assets", tags: [],
      physics: { bodyType: "dynamic", collider: "box", mass: 1, friction: 0.5, restitution: 0.1, solid: true },
      parts: [{ id: uid("part"), name: "Body", shape: "box", position: [0, 0.5, 0], scale: [1, 1, 1], color: "#8b8b95", roughness: 0.7, metalness: 0.1 }],
      updatedAt: Date.now(),
    };
    store.add(a);
    setSel(a.id);
    setTab("inspect");
  }, [store]);

  return (
    <div className="flex h-full flex-col">
      <Tabs tabs={[{ id: "library", label: `Library (${store.assets.length})`, icon: "assets" }, { id: "inspect", label: "Inspector", icon: "search" }]} active={tab} onChange={setTab} />

      {/* Search and the one thing you came to do stay visible; moving and
          copying the library go in a menu, the same shape Forge 3D uses. Five
          equal-weight buttons is a toolbar nobody reads. */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--border)] px-2.5 py-1.5">
        <Icon name="search" size={13} style={{ color: "var(--muted)" }} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search assets…"
          className="min-w-20 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-[var(--muted)]"
        />
        <select value={kind} onChange={(e) => setKind(e.target.value)} className="os-input !w-auto !py-1 text-[11px]">
          {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <button className="os-btn !py-1 text-[11px]" onClick={create}>
          <Icon name="plus" size={11} className="mr-1" />New
        </button>
        {undoLog.length > 0 && (
          <button className="os-btn !py-1 text-[11px]" onClick={undoEdit} title={undoLog[undoLog.length - 1].deleted ? `Restore "${undoLog[undoLog.length - 1].asset.name}"` : `Undo the last edit to "${undoLog[undoLog.length - 1].asset.name}"`}>
            Undo{undoLog.length > 1 ? ` (${undoLog.length})` : ""}
          </button>
        )}
        <div className="relative">
          <button className="os-btn !py-1 text-[11px]" onClick={() => setMenu((m) => !m)} title="Library menu" aria-label="Library menu">
            <Icon name="menu" size={12} />
          </button>
          {menu && (
            <>
              <div className="fixed inset-0 z-[40]" onClick={() => setMenu(false)} />
              <div className="glass absolute right-0 top-full z-[50] mt-1 w-48 p-1.5 shadow-2xl" style={{ borderRadius: "var(--radius)" }}>
                <button
                  onClick={() => { setMenu(false); fileRef.current?.click(); }}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] hover:bg-[var(--accent)]/18"
                >
                  <Icon name="folder" size={12} />Import .json
                </button>
                <button
                  onClick={() => { setMenu(false); download("asset_library.json", JSON.stringify({ assets: store.assets }, null, 2), "application/json"); }}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] hover:bg-[var(--accent)]/18"
                >
                  <Icon name="download" size={12} />Export all
                </button>
                <button
                  onClick={() => { setMenu(false); bus.emit("app:open", { appId: "forge3d" }); }}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] hover:bg-[var(--accent)]/18"
                >
                  <Icon name="cube3d" size={12} />Open Forge 3D
                </button>
              </div>
            </>
          )}
        </div>
        <input
          ref={fileRef} type="file" accept="application/json" hidden multiple
          onChange={async (e) => {
            for (const f of Array.from(e.target.files ?? [])) {
              const r = store.importJson(await f.text());
              if (r.error) setError(`${f.name}: ${r.error}`);
              else bus.emit("notify", { title: `Imported ${r.ok} asset(s)`, kind: "success" });
            }
            e.target.value = "";
          }}
        />
      </div>

      <div className="px-2.5 pt-2"><ErrorNote error={error} onDismiss={() => setError(null)} /></div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === "library" && <AssetForge onCreated={(a) => { store.add(a); setSel(a.id); }} setError={setError} />}
        {tab === "library" && (
          filtered.length === 0 ? (
            <Empty icon="assets" title="No assets" body="Describe one above, create a blank, or import a .asset.json exported from AssetForge — the schema is identical." action={<button className="os-btn" onClick={store.reseed}>Restore starter set</button>} />
          ) : (
            <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))" }}>
              {filtered.map((a) => (
                <button
                  key={a.id}
                  onClick={() => { setSel(a.id); setTab("inspect"); }}
                  className={cn("os-card text-left transition hover:-translate-y-0.5", sel === a.id && "!border-[var(--accent)]")}
                >
                  <div className="mb-2 h-20 overflow-hidden rounded-[calc(var(--radius)*0.6)]" style={{ background: `color-mix(in srgb, ${a.parts[0]?.color ?? "var(--accent)"} 18%, transparent)` }}>
                    <AssetThumb asset={a} />
                  </div>
                  <div className="truncate text-[12.5px] font-medium">{a.name}</div>
                  <div className="text-[10px] text-[var(--muted)]">{a.kind} · {a.parts.length} part{a.parts.length === 1 ? "" : "s"} · {a.physics.bodyType}</div>
                  {a.tags.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-0.5">
                      {a.tags.slice(0, 3).map((t) => <span key={t} className="os-chip !px-1.5 !py-0 !text-[9px]">{t}</span>)}
                    </div>
                  )}
                </button>
              ))}
            </div>
          )
        )}

        {tab === "inspect" && (
          !asset ? (
            <Empty icon="search" title="No asset selected" body="Pick one from the Library tab." />
          ) : (
            <div className="max-w-2xl">
              <div className="mb-3 flex flex-wrap items-center gap-1.5">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[calc(var(--radius)*0.5)] border border-[var(--border)]" style={{ color: "var(--accent)" }}>
                  <Icon name={asset.icon || "assets"} size={16} />
                </span>
                <select value={asset.icon} onChange={(e) => edit(asset.id, { icon: e.target.value })} className="os-input !w-auto !py-1 text-[11px]" title="Icon">
                  {["assets", "agents", "spark", "sparkles", "cube3d", "gate", "app", "home", "labs", "star"].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
                <input value={asset.name} onChange={(e) => edit(asset.id, { name: e.target.value })} className="os-input min-w-32 flex-1 !py-1 font-medium" aria-label="Asset name" />
                <select value={asset.kind} onChange={(e) => edit(asset.id, { kind: e.target.value as Asset["kind"] })} className="os-input !w-auto !py-1 text-[11px]">
                  {["prop", "character", "structure", "light", "puzzle", "weapon", "vehicle", "fx"].map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
                <button className="os-btn !py-1 text-[11px]" onClick={() => duplicateAsset(asset)}>Duplicate</button>
                <button className="os-btn !py-1 text-[11px]" onClick={() => removeAsset(asset)} title="Delete (Undo restores it)">Delete</button>
              </div>

              <div className="os-card mb-3 flex items-center gap-3">
                <div className="h-28 w-28 shrink-0 overflow-hidden rounded-[calc(var(--radius)*0.6)]" style={{ background: "color-mix(in srgb, var(--bg2) 60%, transparent)" }}>
                  <AssetThumb asset={asset} size={112} />
                </div>
                <div className="min-w-0 text-[11px] leading-relaxed text-[var(--muted)]">
                  Lit with the same code the Forge viewport uses, so this is what it will look like in a scene.
                  Primitives are drawn as their bounding boxes here — the shape you pick is carried through to export,
                  where a real engine honours it.
                </div>
              </div>

              <div className="os-card mb-3">
                <div className="os-label mb-2">Physics</div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <label className="text-[11px]">Body
                    <select value={asset.physics.bodyType} onChange={(e) => edit(asset.id, { physics: { ...asset.physics, bodyType: e.target.value as AssetPhysics["bodyType"] } })} className="os-input !py-1 text-[11px]">
                      {["static", "dynamic", "kinematic"].map((v) => <option key={v}>{v}</option>)}
                    </select>
                  </label>
                  <label className="text-[11px]">Collider
                    <select value={asset.physics.collider} onChange={(e) => edit(asset.id, { physics: { ...asset.physics, collider: e.target.value as AssetPhysics["collider"] } })} className="os-input !py-1 text-[11px]">
                      {["box", "sphere", "capsule", "mesh", "none"].map((v) => <option key={v}>{v}</option>)}
                    </select>
                  </label>
                  {(["mass", "friction", "restitution"] as const).map((k) => (
                    <label key={k} className="text-[11px]">{k}
                      <input
                        type="number" step="0.05" value={asset.physics[k]}
                        onChange={(e) => edit(asset.id, { physics: { ...asset.physics, [k]: Number(e.target.value) } })}
                        className="os-input !py-1 text-[11px]"
                      />
                    </label>
                  ))}
                </div>
              </div>

              <div className="os-card mb-3">
                <div className="mb-2 flex items-center gap-2">
                  <span className="os-label">Parts ({asset.parts.length})</span>
                  <button
                    className="os-btn !px-2 !py-0 text-[10px]"
                    onClick={() => edit(asset.id, { parts: [...asset.parts, { id: uid("part"), name: `Part ${asset.parts.length + 1}`, shape: "box", position: [0, 0.5, 0], scale: [1, 1, 1], color: "#8b8b95" }] })}
                  >
                    + Part
                  </button>
                </div>
                {asset.parts.map((p, i) => (
                  <div key={p.id} className="mb-1.5 rounded-[calc(var(--radius)*0.5)] border border-[var(--border)] p-2">
                    <div className="mb-1.5 flex items-center gap-1.5">
                      <input
                        value={p.name}
                        onChange={(e) => edit(asset.id, { parts: asset.parts.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })}
                        className="min-w-0 flex-1 bg-transparent text-[12px] font-medium outline-none"
                      />
                      <select
                        value={p.shape}
                        onChange={(e) => edit(asset.id, { parts: asset.parts.map((x, j) => (j === i ? { ...x, shape: e.target.value as AssetPart["shape"] } : x)) })}
                        className="os-input !w-auto !py-0.5 text-[10.5px]"
                      >
                        {["box", "sphere", "cylinder", "cone", "plane", "capsule"].map((v) => <option key={v}>{v}</option>)}
                      </select>
                      <input
                        type="color" value={p.color ?? "#8b8b95"}
                        onChange={(e) => edit(asset.id, { parts: asset.parts.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)) })}
                        className="h-6 w-8 cursor-pointer rounded border border-[var(--border)] bg-transparent"
                      />
                      <button className="text-[10px] opacity-60 hover:opacity-100" onClick={() => edit(asset.id, { parts: [...asset.parts.slice(0, i + 1), { ...p, id: uid("part"), name: `${p.name} copy` }, ...asset.parts.slice(i + 1)] })} aria-label={`Duplicate ${p.name}`} title="Duplicate part"><Icon name="copy" size={11} /></button>
                      <button className="text-[10px] opacity-60 hover:opacity-100" onClick={() => edit(asset.id, { parts: asset.parts.filter((_, j) => j !== i) })} aria-label={`Remove ${p.name}`}><Icon name="close" size={11} /></button>
                    </div>
                    {(["position", "scale"] as const).map((field) => (
                      <div key={field} className="mb-1 flex items-center gap-1">
                        <span className="w-14 shrink-0 text-[10px] text-[var(--muted)]">{field}</span>
                        {[0, 1, 2].map((axis) => (
                          <input
                            key={axis} type="number" step="0.05"
                            value={(p[field] ?? [0, 0, 0])[axis] ?? 0}
                            onChange={(e) => {
                              const v = [...(p[field] ?? [0, 0, 0])] as [number, number, number];
                              v[axis] = Number(e.target.value);
                              edit(asset.id, { parts: asset.parts.map((x, j) => (j === i ? { ...x, [field]: v } : x)) });
                            }}
                            className="os-input !py-0.5 text-[10.5px]"
                          />
                        ))}
                      </div>
                    ))}
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap gap-1.5">
                <CopyButton text={JSON.stringify(asset, null, 2)} label="Copy JSON" />
                <button className="os-btn !py-1 text-[11px]" disabled={!!exporting} onClick={() => void exportAsset(asset, "glb")}>{exporting === "glb" ? "Exporting…" : "Export .glb"}</button>
                <button className="os-btn !py-1 text-[11px]" disabled={!!exporting} onClick={() => void exportAsset(asset, "obj")}>{exporting === "obj" ? "Exporting…" : "Export .obj"}</button>
                <button className="os-btn !py-1 text-[11px]" onClick={() => download(`${asset.name.replace(/\s+/g, "_")}.asset.json`, JSON.stringify(asset, null, 2), "application/json")}>Export asset</button>
                <button className="os-btn !py-1 text-[11px]" onClick={() => bus.emit("app:open", { appId: "forge3d", args: { spawnAsset: asset.id } })}>Place in Forge 3D</button>
              </div>
            </div>
          )
        )}
      </div>
    </div>
  );
}
