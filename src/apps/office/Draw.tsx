"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AppProps } from "@/kernel/types";
import { shapeSvg, toSvg, toOdg, align, distribute, snap, parseDiagram, layoutGraph, bounds, type Shape, type ShapeKind } from "@/lib/office/draw";
import { parseDrawing } from "@/lib/office/files";
import { DIAGRAM_SYSTEM, extractJson } from "@/lib/office/ai";
import { useOfficeFile, FileBar, AiPanel, TB, useAiCall, downloadPackage, downloadBytes, MIME } from "./common";
import { cn } from "@/lib/cn";

/* Draw: vector drawing and diagrams. Shapes are plain data (lib/office/draw.ts);
   connectors attach to shapes by id, so they follow when a shape moves. The
   AI draws a diagram by returning nodes and edges only -- the app validates
   and lays them out. */

type Doc = { shapes: Shape[]; bg: string };
const blank = (): Doc => ({ shapes: [], bg: "#ffffff" });
type Tool = "select" | "rect" | "round" | "ellipse" | "diamond" | "text" | "line" | "arrow" | "path" | "connector";
const TOOLS: Array<[Tool, string]> = [["select", "Select"], ["rect", "Box"], ["round", "Rounded"], ["ellipse", "Ellipse"], ["diamond", "Diamond"], ["text", "Text"], ["line", "Line"], ["arrow", "Arrow"], ["path", "Pen"], ["connector", "Connect"]];
const PALETTE = ["#ffffff", "#e8eefc", "#fff3bf", "#d3f9d8", "#ffe3e3", "#f3d9fa", "#1f2937", "#3b82f6", "#10b981", "#f59e0b", "#ef4444", "none"];

let seq = 0;
const newId = () => `s${Date.now().toString(36)}${(++seq).toString(36)}`;

export default function Draw({ args }: AppProps) {
  const f = useOfficeFile("draw", args, parseDrawing, blank);
  const ai = useAiCall();
  const svg = useRef<SVGSVGElement>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [sel, setSel] = useState<string[]>([]);
  const [grid, setGrid] = useState(10);
  const [view, setView] = useState({ x: -40, y: -40, z: 1 });
  const [style, setStyle] = useState({ fill: "#e8eefc", stroke: "#1f2937", strokeW: 2, dash: false });
  const [editingText, setEditingText] = useState<string | null>(null);
  // Open by default where there is room; on a phone the document comes first.
  const [showAi, setShowAi] = useState(() => typeof window === "undefined" || window.innerWidth >= 700);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const history = useRef<{ undo: Doc[]; redo: Doc[] }>({ undo: [], redo: [] });
  const gesture = useRef<null | { kind: "move" | "create" | "resize" | "pan" | "pen"; start: [number, number]; orig: Shape[]; id?: string; handle?: string }>(null);
  const [draftPen, setDraftPen] = useState<Array<[number, number]> | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth || 800, h: el.clientHeight || 600 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const shapes = f.data.shapes;
  const byId = useMemo(() => new Map(shapes.map((s) => [s.id, s])), [shapes]);

  const commit = (next: Doc) => { history.current.undo.push(f.data); if (history.current.undo.length > 100) history.current.undo.shift(); history.current.redo = []; f.update(next); };
  const setShapes = (next: Shape[], record = true) => (record ? commit({ ...f.data, shapes: next }) : f.update({ ...f.data, shapes: next }));
  const undo = () => { const u = history.current.undo.pop(); if (u) { history.current.redo.push(f.data); f.update(u); } };
  const redo = () => { const r = history.current.redo.pop(); if (r) { history.current.undo.push(f.data); f.update(r); } };

  const toWorld = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = svg.current!.getBoundingClientRect();
    return [view.x + (e.clientX - r.left) / view.z, view.y + (e.clientY - r.top) / view.z];
  };

  const hit = (x: number, y: number): Shape | undefined => {
    for (let k = shapes.length - 1; k >= 0; k--) {
      const s = shapes[k];
      if (s.kind === "connector") continue;
      const x0 = Math.min(s.x, s.x + s.w) - 4, x1 = Math.max(s.x, s.x + s.w) + 4, y0 = Math.min(s.y, s.y + s.h) - 4, y1 = Math.max(s.y, s.y + s.h) + 4;
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return s;
    }
    return undefined;
  };

  const down = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const [x, y] = toWorld(e);
    const handle = (e.target as Element).getAttribute("data-handle");
    if (handle && sel.length === 1) { gesture.current = { kind: "resize", start: [x, y], orig: shapes, id: sel[0], handle }; return; }
    if (e.button === 1 || e.altKey) { gesture.current = { kind: "pan", start: [e.clientX, e.clientY], orig: shapes }; return; }
    if (tool === "select") {
      const s = hit(x, y);
      if (!s) { setSel([]); gesture.current = { kind: "pan", start: [e.clientX, e.clientY], orig: shapes }; return; }
      const next = e.shiftKey ? (sel.includes(s.id) ? sel.filter((i) => i !== s.id) : [...sel, s.id]) : sel.includes(s.id) ? sel : [s.id];
      setSel(next);
      gesture.current = { kind: "move", start: [x, y], orig: shapes };
      return;
    }
    if (tool === "connector") {
      const s = hit(x, y);
      if (!s) return;
      if (!connectFrom) { setConnectFrom(s.id); return; }
      if (s.id !== connectFrom) setShapes([...shapes, { id: newId(), kind: "connector", x: 0, y: 0, w: 0, h: 0, fill: "none", stroke: style.stroke, strokeW: style.strokeW, dash: style.dash, from: connectFrom, to: s.id }]);
      setConnectFrom(null);
      return;
    }
    if (tool === "path") { setDraftPen([[x, y]]); gesture.current = { kind: "pen", start: [x, y], orig: shapes }; return; }
    const id = newId();
    const sx = snap(x, grid), sy = snap(y, grid);
    const s: Shape = { id, kind: tool as ShapeKind, x: sx, y: sy, w: 0, h: 0, fill: tool === "line" || tool === "arrow" || tool === "text" ? "none" : style.fill, stroke: style.stroke, strokeW: style.strokeW, dash: style.dash, ...(tool === "text" ? { text: "Text", fontSize: 18, textColor: style.stroke } : {}) };
    history.current.undo.push(f.data);
    f.update((d) => ({ ...d, shapes: [...d.shapes, s] }));
    setSel([id]);
    gesture.current = { kind: "create", start: [sx, sy], orig: shapes, id };
  };

  const moveP = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    const [x, y] = toWorld(e);
    if (g.kind === "pan") { const dx = (e.clientX - g.start[0]) / view.z, dy = (e.clientY - g.start[1]) / view.z; g.start = [e.clientX, e.clientY]; setView((v) => ({ ...v, x: v.x - dx, y: v.y - dy })); return; }
    if (g.kind === "pen") { setDraftPen((p) => (p ? [...p, [x, y]] : p)); return; }
    if (g.kind === "move") {
      const dx = snap(x - g.start[0], grid), dy = snap(y - g.start[1], grid);
      setShapes(g.orig.map((s) => (sel.includes(s.id) && s.kind !== "connector" ? { ...s, x: s.x + dx, y: s.y + dy } : s)), false);
      return;
    }
    if (g.kind === "create" && g.id) {
      const w = snap(x, grid) - g.start[0], h = snap(y, grid) - g.start[1];
      const line = byId.get(g.id)?.kind === "line" || byId.get(g.id)?.kind === "arrow";
      // Functional: pointer events can outrun renders, and a stale list would drop the new shape.
      f.update((d) => ({ ...d, shapes: d.shapes.map((s) => (s.id === g.id ? { ...s, w: line ? w : Math.abs(w), h: line ? h : Math.abs(h), x: line ? s.x : Math.min(g.start[0], g.start[0] + w), y: line ? s.y : Math.min(g.start[1], g.start[1] + h) } : s)) }));
      return;
    }
    if (g.kind === "resize" && g.id) {
      const o = g.orig.find((s) => s.id === g.id)!;
      const dx = snap(x - g.start[0], grid), dy = snap(y - g.start[1], grid);
      const h = g.handle!;
      let nx = o.x, ny = o.y, nw = o.w, nh = o.h;
      if (h.includes("e")) nw = Math.max(8, o.w + dx);
      if (h.includes("s")) nh = Math.max(8, o.h + dy);
      if (h.includes("w")) { nw = Math.max(8, o.w - dx); nx = o.x + o.w - nw; }
      if (h.includes("n")) { nh = Math.max(8, o.h - dy); ny = o.y + o.h - nh; }
      setShapes(g.orig.map((s) => (s.id === g.id ? { ...s, x: nx, y: ny, w: nw, h: nh } : s)), false);
    }
  };

  const up = () => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    if (g.kind === "pen" && draftPen && draftPen.length > 1) {
      const xs = draftPen.map((p) => p[0]), ys = draftPen.map((p) => p[1]);
      const x0 = Math.min(...xs), y0 = Math.min(...ys);
      setShapes([...shapes, { id: newId(), kind: "path", x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0, fill: "none", stroke: style.stroke, strokeW: style.strokeW, points: draftPen.map(([px, py]) => [px - x0, py - y0]) }]);
    }
    setDraftPen(null);
    if (g.kind === "create" && g.id) {
      const s = byId.get(g.id);
      // A click without a drag makes a default-sized shape.
      f.update((d) => ({ ...d, shapes: d.shapes.map((x) => (x.id === g.id && x.kind !== "line" && x.kind !== "arrow" && x.w < 6 && x.h < 6 ? { ...x, w: x.kind === "text" ? 160 : 140, h: x.kind === "text" ? 32 : 80 } : x)) }));
      if (s?.kind === "text") setEditingText(g.id);
      setTool("select");
    }
    if (g.kind === "move" || g.kind === "resize") { history.current.undo.push({ ...f.data, shapes: g.orig }); history.current.redo = []; }
  };

  const del = () => { if (!sel.length) return; setShapes(shapes.filter((s) => !sel.includes(s.id) && !(s.kind === "connector" && (sel.includes(s.from ?? "") || sel.includes(s.to ?? ""))))); setSel([]); };
  const dup = () => {
    const copies = shapes.filter((s) => sel.includes(s.id) && s.kind !== "connector").map((s) => ({ ...s, id: newId(), x: s.x + 20, y: s.y + 20 }));
    setShapes([...shapes, ...copies]);
    setSel(copies.map((c) => c.id));
  };
  const order = (front: boolean) => {
    const picked = shapes.filter((s) => sel.includes(s.id)), rest = shapes.filter((s) => !sel.includes(s.id));
    setShapes(front ? [...rest, ...picked] : [...picked, ...rest]);
  };
  const applyStyle = (patch: Partial<Shape>) => {
    if (patch.fill !== undefined || patch.stroke !== undefined || patch.strokeW !== undefined || patch.dash !== undefined) setStyle((st) => ({ ...st, ...(patch as typeof st) }));
    if (sel.length) setShapes(shapes.map((s) => (sel.includes(s.id) ? { ...s, ...patch } : s)));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
      if (!svg.current?.closest("[data-office='draw']")?.contains(document.activeElement) && document.activeElement !== document.body) return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); del(); }
      else if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); dup(); }
      else if (mod && e.key.toLowerCase() === "a") { e.preventDefault(); setSel(shapes.filter((s) => s.kind !== "connector").map((s) => s.id)); }
      else if (e.key === "Escape") { setSel([]); setTool("select"); setConnectFrom(null); }
      else if (e.key.startsWith("Arrow") && sel.length) {
        e.preventDefault();
        const d = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -d : e.key === "ArrowRight" ? d : 0, dy = e.key === "ArrowUp" ? -d : e.key === "ArrowDown" ? d : 0;
        setShapes(shapes.map((s) => (sel.includes(s.id) ? { ...s, x: s.x + dx, y: s.y + dy } : s)));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const fit = () => {
    const b = bounds(shapes);
    const r = svg.current?.getBoundingClientRect();
    if (!r) return;
    const z = Math.max(0.1, Math.min(4, Math.min(r.width / (b.w + 80), r.height / (b.h + 80))));
    setView({ x: b.x - 40, y: b.y - 40, z });
  };

  /* ── AI ── */
  const diagram = async (description: string) => {
    const reply = await ai.run(DIAGRAM_SYSTEM, description, { name: "draw.diagram", maxTokens: 3000 });
    if (reply === null) return;
    const p = parseDiagram(extractJson(reply));
    if (!p.ok) { ai.setError(`The diagram could not be used: ${p.reason}.`); return; }
    const laid = layoutGraph(p.spec).map((s) => ({ ...s, id: `${s.id}-${Date.now().toString(36)}` }));
    // Rename connector endpoints to the new ids.
    const suffix = laid[0]?.id.slice(laid[0].id.lastIndexOf("-")) ?? "";
    const fixed = laid.map((s) => (s.kind === "connector" ? { ...s, from: `${s.from}${suffix}`, to: `${s.to}${suffix}` } : s));
    const b = bounds(shapes);
    const dy = shapes.length ? b.y + b.h + 60 : 0;
    setShapes([...shapes, ...fixed.map((s) => (s.kind === "connector" ? s : { ...s, y: s.y + dy }))]);
    setTimeout(fit, 50);
  };

  const exportPng = async () => {
    const text = toSvg(shapes, { bg: f.data.bg });
    const img = new Image();
    const url = URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error("Could not render the drawing.")); img.src = url; });
    const c = document.createElement("canvas");
    c.width = img.width * 2; c.height = img.height * 2;
    const g = c.getContext("2d")!;
    g.scale(2, 2);
    g.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/png"));
    if (blob) downloadBytes(`${f.name}.png`, new Uint8Array(await blob.arrayBuffer()), "image/png");
  };

  const base = f.name.replace(/[^\w .-]/g, "_") || "drawing";
  const exportsMenu = [
    { id: "svg", label: "SVG image (.svg)", run: () => downloadBytes(`${base}.svg`, toSvg(shapes, { bg: f.data.bg }), "image/svg+xml") },
    { id: "png", label: "PNG image (.png)", run: () => exportPng() },
    { id: "odg", label: "OpenDocument drawing (.odg)", run: () => downloadPackage(`${base}.odg`, toOdg(shapes, { title: f.name, when: new Date().toISOString() }), MIME.odg) },
  ];

  const one = sel.length === 1 ? byId.get(sel[0]) : undefined;
  const W = 2000, H = 1400;

  return (
    <div className="flex h-full flex-col" data-office="draw">
      <FileBar icon="drawapp" name={f.name} savedAt={f.savedAt} onRename={f.rename} files={f.files} current={f.path}
        onOpen={(p) => { f.open(p); setSel([]); }} onNew={() => { f.createNew(); setSel([]); }} exports={exportsMenu}
        extra={<TB label="AI assistant" icon="sparkles" active={showAi} onClick={() => setShowAi((v) => !v)} />}
      />
      <div className="os-office-toolbar flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--border)] px-2 py-1" role="toolbar" aria-label="Drawing tools">
        {TOOLS.map(([t, l]) => <TB key={t} label={l} text={l} active={tool === t} onClick={() => { setTool(t); setConnectFrom(null); }} />)}
        <span className="mx-1 h-4 w-px bg-[var(--border)]" />
        <span className="text-[11px] text-[var(--muted)]">Fill</span>
        {PALETTE.map((c) => <button key={`f${c}`} className="h-4 w-4 rounded-sm border border-white/30" style={{ background: c === "none" ? "repeating-linear-gradient(45deg,#fff,#fff 3px,#f55 3px,#f55 4px)" : c }} onClick={() => applyStyle({ fill: c })} aria-label={`Fill ${c}`} title={c} />)}
        <span className="text-[11px] text-[var(--muted)]">Line</span>
        {["#1f2937", "#3b82f6", "#10b981", "#ef4444", "#ffffff"].map((c) => <button key={`s${c}`} className="h-4 w-4 rounded-full border border-white/30" style={{ background: c }} onClick={() => applyStyle({ stroke: c })} aria-label={`Line colour ${c}`} />)}
        <select className="os-input !w-auto !py-0.5 text-[11px]" value={style.strokeW} onChange={(e) => applyStyle({ strokeW: Number(e.target.value) })} aria-label="Line width">{[1, 2, 3, 5, 8].map((w) => <option key={w} value={w}>{w}px</option>)}</select>
        <TB label="Dashed" text="Dash" active={style.dash} onClick={() => applyStyle({ dash: !style.dash })} />
        <span className="mx-1 h-4 w-px bg-[var(--border)]" />
        <TB label="Undo" text="Undo" onClick={undo} />
        <TB label="Redo" text="Redo" onClick={redo} />
        <TB label="Duplicate" icon="copy" onClick={dup} disabled={!sel.length} />
        <TB label="Delete" icon="trash" onClick={del} disabled={!sel.length} />
        <TB label="Bring to front" text="Front" onClick={() => order(true)} disabled={!sel.length} />
        <TB label="Send to back" text="Back" onClick={() => order(false)} disabled={!sel.length} />
        {sel.length > 1 && <>
          <TB label="Align left" text="Align L" onClick={() => setShapes(align(shapes, sel, "left"))} />
          <TB label="Align centre" text="Align C" onClick={() => setShapes(align(shapes, sel, "center"))} />
          <TB label="Align top" text="Align T" onClick={() => setShapes(align(shapes, sel, "top"))} />
          <TB label="Align middle" text="Align M" onClick={() => setShapes(align(shapes, sel, "middle"))} />
          <TB label="Distribute horizontally" text="Space H" onClick={() => setShapes(distribute(shapes, sel, "x"))} />
          <TB label="Distribute vertically" text="Space V" onClick={() => setShapes(distribute(shapes, sel, "y"))} />
        </>}
        <select className="os-input !w-auto !py-0.5 text-[11px]" value={grid} onChange={(e) => setGrid(Number(e.target.value))} aria-label="Snap grid">{[0, 5, 10, 20].map((g) => <option key={g} value={g}>{g ? `Snap ${g}` : "No snap"}</option>)}</select>
        <TB label="Zoom in" text="+" onClick={() => setView((v) => ({ ...v, z: Math.min(4, v.z * 1.2) }))} />
        <TB label="Zoom out" text="-" onClick={() => setView((v) => ({ ...v, z: Math.max(0.1, v.z / 1.2) }))} />
        <TB label="Fit to drawing" text="Fit" onClick={fit} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <div className="relative min-h-0 flex-1 overflow-hidden" style={{ background: "#9aa3b2" }}>
          <svg
            ref={svg}
            className={cn("h-full w-full touch-none select-none", tool === "select" ? "cursor-default" : "cursor-crosshair")}
            viewBox={`${view.x} ${view.y} ${size.w / view.z} ${size.h / view.z}`}
            onPointerDown={down} onPointerMove={moveP} onPointerUp={up}
            onWheel={(e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); const k = e.deltaY < 0 ? 1.1 : 1 / 1.1; setView((v) => ({ ...v, z: Math.max(0.1, Math.min(4, v.z * k)) })); } else setView((v) => ({ ...v, x: v.x + e.deltaX / v.z, y: v.y + e.deltaY / v.z })); }}
            onDoubleClick={(e) => { const s = hit(...toWorld(e)); if (s) setEditingText(s.id); }}
            role="application"
            aria-label={`Drawing canvas, ${shapes.length} shapes`}
            data-draw-canvas
          >
            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="context-stroke" /></marker>
              <pattern id="grid" width={grid || 10} height={grid || 10} patternUnits="userSpaceOnUse"><path d={`M ${grid || 10} 0 L 0 0 0 ${grid || 10}`} fill="none" stroke="#000" strokeOpacity="0.06" strokeWidth="1" /></pattern>
            </defs>
            <rect x={0} y={0} width={W} height={H} fill={f.data.bg} />
            {grid > 0 && <rect x={0} y={0} width={W} height={H} fill="url(#grid)" />}
            <g dangerouslySetInnerHTML={{ __html: shapes.map((s) => shapeSvg(s, byId)).join("") }} />
            {draftPen && <polyline points={draftPen.map((p) => p.join(",")).join(" ")} fill="none" stroke={style.stroke} strokeWidth={style.strokeW} strokeLinecap="round" />}
            {sel.map((id) => { const s = byId.get(id); if (!s || s.kind === "connector") return null; const x = Math.min(s.x, s.x + s.w), y = Math.min(s.y, s.y + s.h); return <rect key={id} x={x - 3} y={y - 3} width={Math.abs(s.w) + 6} height={Math.abs(s.h) + 6} fill="none" stroke="#3b82f6" strokeDasharray="4 3" strokeWidth={1 / view.z} pointerEvents="none" />; })}
            {one && one.kind !== "connector" && one.kind !== "line" && one.kind !== "arrow" && one.kind !== "path" && ["nw", "n", "ne", "e", "se", "s", "sw", "w"].map((h) => {
              const hx = one.x + (h.includes("w") ? 0 : h.includes("e") ? one.w : one.w / 2), hy = one.y + (h.includes("n") ? 0 : h.includes("s") ? one.h : one.h / 2);
              const r = 5 / view.z;
              return <rect key={h} data-handle={h} x={hx - r} y={hy - r} width={r * 2} height={r * 2} fill="#fff" stroke="#3b82f6" strokeWidth={1 / view.z} style={{ cursor: `${h}-resize` }} />;
            })}
            {connectFrom && byId.get(connectFrom) && (() => { const s = byId.get(connectFrom)!; return <rect x={s.x - 4} y={s.y - 4} width={s.w + 8} height={s.h + 8} fill="none" stroke="#10b981" strokeWidth={2 / view.z} pointerEvents="none" />; })()}
          </svg>
          {tool === "connector" && <div className="pointer-events-none absolute left-2 top-2 rounded bg-black/60 px-2 py-0.5 text-[11px] text-white">{connectFrom ? "Now click the shape to connect to" : "Click the first shape"}</div>}
          {!shapes.length && <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[13px] text-black/50">Pick a tool and drag on the canvas, or ask the assistant for a diagram.</div>}
          {editingText && byId.get(editingText) && (
            <div className="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 gap-1 rounded border border-[var(--border)] p-1 shadow-xl" style={{ background: "var(--panel-solid)" }}>
              <textarea autoFocus className="os-input w-64 text-[12px]" defaultValue={byId.get(editingText)!.text ?? ""} aria-label="Shape text"
                onBlur={(e) => { setShapes(shapes.map((s) => (s.id === editingText ? { ...s, text: e.target.value } : s))); setEditingText(null); }}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); } if (e.key === "Escape") setEditingText(null); }} />
            </div>
          )}
        </div>
        {showAi && (
          <AiPanel
            title="Diagram assistant" busy={ai.busy} error={ai.error} partial={ai.partial} provider={ai.provider} model={ai.model} onStop={ai.stop}
            placeholder="Describe a diagram: 'the checkout flow with a payment-failed branch'"
            onFree={(t) => void diagram(t)}
            actions={[
              { id: "flow", label: "Flowchart of a process", run: () => void diagram("A clear flowchart of a typical user sign-up process, with a decision for 'email verified?'") },
              { id: "org", label: "Org chart", run: () => void diagram("An org chart for a small startup: CEO, CTO, head of design, two engineers, one designer") },
              { id: "mind", label: "Mind map", run: () => void diagram("A mind map for planning a product launch, direction right") },
            ]}
          >
            <p className="text-[10.5px] leading-snug text-[var(--muted)]">Diagrams are laid out automatically and land below what is already here; every box stays editable. Double-click a shape to edit its text; Alt-drag pans.</p>
          </AiPanel>
        )}
      </div>
    </div>
  );
}
