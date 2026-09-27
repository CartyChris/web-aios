/* ────────────────────────────────────────────────────────────────────────────
   Draw: shapes, connectors, a layered auto-layout, and SVG / .odg out.

   Connectors attach to shapes by id and are drawn from boundary to boundary,
   so moving a box keeps its arrows attached. For "draw me a diagram of ..."
   the model returns nodes and edges only (parseDiagram validates them against
   an allowlist, like the chat panels), and layoutGraph places them in layers,
   so a model never has to invent coordinates.

   PURE.
   ──────────────────────────────────────────────────────────────────────────── */

import { escapeXml } from "./xml";
import { odfManifest, odfMeta, ODF_NS } from "./doc";
import type { ZipEntry } from "../zip";

export type ShapeKind = "rect" | "round" | "ellipse" | "diamond" | "text" | "line" | "arrow" | "path" | "connector";
export interface Shape {
  id: string;
  kind: ShapeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
  stroke: string;
  strokeW: number;
  text?: string;
  fontSize?: number;
  textColor?: string;
  /** Freehand points, relative to x/y. */
  points?: Array<[number, number]>;
  /** For connectors: shape ids. */
  from?: string;
  to?: string;
  /** Dashed stroke. */
  dash?: boolean;
}

export const HEXC = /^#[0-9a-f]{6}$/i;
const col = (c: string | undefined, d: string) => (c && (HEXC.test(c) || c === "none") ? c : d);

export function center(s: Shape): [number, number] { return [s.x + s.w / 2, s.y + s.h / 2]; }

/** Where the ray from a shape's centre towards (tx, ty) leaves its outline. */
export function boundaryPoint(s: Shape, tx: number, ty: number): [number, number] {
  const [cx, cy] = center(s);
  const dx = tx - cx, dy = ty - cy;
  if (!dx && !dy) return [cx, cy];
  const hw = s.w / 2, hh = s.h / 2;
  if (s.kind === "ellipse") {
    const t = 1 / Math.sqrt((dx * dx) / (hw * hw || 1) + (dy * dy) / (hh * hh || 1));
    return [cx + dx * t, cy + dy * t];
  }
  if (s.kind === "diamond") {
    const t = 1 / (Math.abs(dx) / (hw || 1) + Math.abs(dy) / (hh || 1));
    return [cx + dx * t, cy + dy * t];
  }
  const t = Math.min(hw / (Math.abs(dx) || 1e-9), hh / (Math.abs(dy) || 1e-9));
  return [cx + dx * t, cy + dy * t];
}

export function connectorEnds(c: Shape, byId: Map<string, Shape>): [[number, number], [number, number]] | null {
  const a = c.from ? byId.get(c.from) : undefined, b = c.to ? byId.get(c.to) : undefined;
  if (!a || !b) return null;
  const [bx, by] = center(b), [ax, ay] = center(a);
  return [boundaryPoint(a, bx, by), boundaryPoint(b, ax, ay)];
}

/* ── SVG ─────────────────────────────────────────────────────────────────── */

const e = (s: string) => escapeXml(s);

export function shapeSvg(s: Shape, byId: Map<string, Shape>): string {
  const stroke = col(s.stroke, "#333333"), fill = col(s.fill, "none");
  const sw = Math.max(0, Math.min(40, s.strokeW || 0));
  const dash = s.dash ? ` stroke-dasharray="${sw * 3} ${sw * 2}"` : "";
  const common = `stroke="${stroke}" stroke-width="${sw}"${dash}`;
  const label = () => {
    if (!s.text) return "";
    const lines = s.text.split("\n");
    const fs = s.fontSize ?? 16;
    const [cx, cy] = center(s);
    return `<text x="${cx}" y="${cy - ((lines.length - 1) * fs * 1.2) / 2}" font-size="${fs}" font-family="system-ui, sans-serif" fill="${col(s.textColor, "#111111")}" text-anchor="middle" dominant-baseline="middle">${lines.map((l, i) => `<tspan x="${cx}" dy="${i ? fs * 1.2 : 0}">${e(l)}</tspan>`).join("")}</text>`;
  };
  switch (s.kind) {
    case "rect": return `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" fill="${fill}" ${common}/>${label()}`;
    case "round": return `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="${Math.min(16, s.h / 3)}" fill="${fill}" ${common}/>${label()}`;
    case "ellipse": return `<ellipse cx="${s.x + s.w / 2}" cy="${s.y + s.h / 2}" rx="${s.w / 2}" ry="${s.h / 2}" fill="${fill}" ${common}/>${label()}`;
    case "diamond": return `<polygon points="${s.x + s.w / 2},${s.y} ${s.x + s.w},${s.y + s.h / 2} ${s.x + s.w / 2},${s.y + s.h} ${s.x},${s.y + s.h / 2}" fill="${fill}" ${common}/>${label()}`;
    case "text": return label();
    case "line": case "arrow": return `<line x1="${s.x}" y1="${s.y}" x2="${s.x + s.w}" y2="${s.y + s.h}" ${common}${s.kind === "arrow" ? ` marker-end="url(#arrow)"` : ""}/>`;
    case "path": return s.points?.length ? `<polyline points="${s.points.map(([px, py]) => `${s.x + px},${s.y + py}`).join(" ")}" fill="none" stroke-linecap="round" stroke-linejoin="round" ${common}/>` : "";
    case "connector": {
      const ends = connectorEnds(s, byId);
      if (!ends) return "";
      const [[x1, y1], [x2, y2]] = ends;
      const mid = s.text ? `<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 6}" font-size="${s.fontSize ?? 13}" font-family="system-ui, sans-serif" fill="${col(s.textColor, "#333333")}" text-anchor="middle">${e(s.text)}</text>` : "";
      return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" ${common} marker-end="url(#arrow)"/>${mid}`;
    }
  }
}

export function bounds(shapes: Shape[]): { x: number; y: number; w: number; h: number } {
  const real = shapes.filter((s) => s.kind !== "connector");
  if (!real.length) return { x: 0, y: 0, w: 800, h: 600 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of real) {
    x0 = Math.min(x0, s.x, s.x + s.w); y0 = Math.min(y0, s.y, s.y + s.h);
    x1 = Math.max(x1, s.x, s.x + s.w); y1 = Math.max(y1, s.y, s.y + s.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function toSvg(shapes: Shape[], opts: { bg?: string; pad?: number } = {}): string {
  const byId = new Map(shapes.map((s) => [s.id, s]));
  const b = bounds(shapes), pad = opts.pad ?? 20;
  const vb = `${b.x - pad} ${b.y - pad} ${b.w + pad * 2} ${b.h + pad * 2}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${Math.round(b.w + pad * 2)}" height="${Math.round(b.h + pad * 2)}"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="context-stroke"/></marker></defs>${opts.bg && HEXC.test(opts.bg) ? `<rect x="${b.x - pad}" y="${b.y - pad}" width="${b.w + pad * 2}" height="${b.h + pad * 2}" fill="${opts.bg}"/>` : ""}${shapes.map((s) => shapeSvg(s, byId)).join("")}</svg>`;
}

/* ── arranging ───────────────────────────────────────────────────────────── */

export function align(shapes: Shape[], ids: string[], how: "left" | "center" | "right" | "top" | "middle" | "bottom"): Shape[] {
  const sel = shapes.filter((s) => ids.includes(s.id) && s.kind !== "connector");
  if (sel.length < 2) return shapes;
  const b = bounds(sel);
  return shapes.map((s) => {
    if (!ids.includes(s.id) || s.kind === "connector") return s;
    switch (how) {
      case "left": return { ...s, x: b.x };
      case "right": return { ...s, x: b.x + b.w - s.w };
      case "center": return { ...s, x: b.x + (b.w - s.w) / 2 };
      case "top": return { ...s, y: b.y };
      case "bottom": return { ...s, y: b.y + b.h - s.h };
      case "middle": return { ...s, y: b.y + (b.h - s.h) / 2 };
    }
  });
}

/** Equal gaps between the selected shapes along an axis (first and last stay put). */
export function distribute(shapes: Shape[], ids: string[], axis: "x" | "y"): Shape[] {
  const sel = shapes.filter((s) => ids.includes(s.id) && s.kind !== "connector").sort((a, b) => a[axis] - b[axis]);
  if (sel.length < 3) return shapes;
  const size = axis === "x" ? "w" : "h";
  const total = sel.reduce((t, s) => t + s[size], 0);
  const span = sel[sel.length - 1][axis] + sel[sel.length - 1][size] - sel[0][axis];
  const gap = (span - total) / (sel.length - 1);
  const pos = new Map<string, number>();
  let at = sel[0][axis];
  for (const s of sel) { pos.set(s.id, at); at += s[size] + gap; }
  return shapes.map((s) => (pos.has(s.id) ? { ...s, [axis]: pos.get(s.id)! } : s));
}

export function snap(v: number, grid: number): number { return grid > 0 ? Math.round(v / grid) * grid : v; }

/* ── diagrams from a model ───────────────────────────────────────────────── */

export interface DiagramSpec {
  nodes: Array<{ id: string; label: string; shape?: "rect" | "round" | "ellipse" | "diamond"; color?: string }>;
  edges: Array<{ from: string; to: string; label?: string }>;
  direction?: "down" | "right";
}

/** Validate a model's diagram reply: plain text, known shapes, edges between real nodes, capped. */
export function parseDiagram(v: unknown): { ok: true; spec: DiagramSpec } | { ok: false; reason: string } {
  if (typeof v !== "object" || v === null) return { ok: false, reason: "diagram must be an object" };
  const o = v as Record<string, unknown>;
  const nodesIn = Array.isArray(o.nodes) ? o.nodes : [];
  if (!nodesIn.length || nodesIn.length > 60) return { ok: false, reason: "diagram needs 1-60 nodes" };
  const nodes: DiagramSpec["nodes"] = [];
  const ids = new Set<string>();
  for (const n of nodesIn) {
    if (typeof n !== "object" || n === null) return { ok: false, reason: "each node must be an object" };
    const r = n as Record<string, unknown>;
    const id = typeof r.id === "string" || typeof r.id === "number" ? String(r.id).slice(0, 40) : "";
    const lbl = typeof r.label === "string" ? r.label.slice(0, 80) : id;
    if (!id || ids.has(id)) return { ok: false, reason: "every node needs a unique id" };
    ids.add(id);
    const shape = r.shape === "ellipse" || r.shape === "diamond" || r.shape === "round" ? r.shape : "rect";
    nodes.push({ id, label: lbl, shape, ...(typeof r.color === "string" && HEXC.test(r.color) ? { color: r.color } : {}) });
  }
  const edgesIn = Array.isArray(o.edges) ? o.edges : [];
  if (edgesIn.length > 200) return { ok: false, reason: "diagram is capped at 200 edges" };
  const edges: DiagramSpec["edges"] = [];
  for (const ed of edgesIn) {
    if (typeof ed !== "object" || ed === null) continue;
    const r = ed as Record<string, unknown>;
    const from = String(r.from ?? ""), to = String(r.to ?? "");
    if (!ids.has(from) || !ids.has(to)) return { ok: false, reason: `edge ${from} -> ${to} names a node that does not exist` };
    edges.push({ from, to, ...(typeof r.label === "string" && r.label ? { label: r.label.slice(0, 40) } : {}) });
  }
  return { ok: true, spec: { nodes, edges, direction: o.direction === "right" ? "right" : "down" } };
}

/**
 * Layered layout: each node's layer is its longest path from a source
 * (cycles are broken by ignoring back edges met during a DFS), nodes in a layer
 * are ordered by the mean position of their parents (one barycentre pass), and
 * layers are centred on each other.
 */
export function layoutGraph(spec: DiagramSpec, opts: { nodeW?: number; nodeH?: number; gapX?: number; gapY?: number } = {}): Shape[] {
  const nodeW = opts.nodeW ?? 160, nodeH = opts.nodeH ?? 60, gapX = opts.gapX ?? 40, gapY = opts.gapY ?? 70;
  const out = new Map<string, string[]>(spec.nodes.map((n) => [n.id, []]));
  // Drop back edges so the layering terminates on cyclic graphs.
  const state = new Map<string, number>();
  const forward: DiagramSpec["edges"] = [];
  const adj = new Map<string, DiagramSpec["edges"]>(spec.nodes.map((n) => [n.id, []]));
  for (const ed of spec.edges) adj.get(ed.from)!.push(ed);
  const dfs = (id: string) => {
    state.set(id, 1);
    for (const ed of adj.get(id)!) {
      const s = state.get(ed.to) ?? 0;
      if (s === 1) continue;
      forward.push(ed);
      if (s === 0) dfs(ed.to);
    }
    state.set(id, 2);
  };
  for (const n of spec.nodes) if (!state.get(n.id)) dfs(n.id);
  for (const ed of forward) out.get(ed.from)!.push(ed.to);

  const layer = new Map<string, number>();
  const indeg = new Map(spec.nodes.map((n) => [n.id, 0]));
  for (const ed of forward) indeg.set(ed.to, indeg.get(ed.to)! + 1);
  const queue = spec.nodes.filter((n) => !indeg.get(n.id)).map((n) => n.id);
  for (const id of queue) layer.set(id, 0);
  while (queue.length) {
    const id = queue.shift()!;
    for (const to of out.get(id)!) {
      layer.set(to, Math.max(layer.get(to) ?? 0, layer.get(id)! + 1));
      indeg.set(to, indeg.get(to)! - 1);
      if (!indeg.get(to)) queue.push(to);
    }
  }
  const layers: string[][] = [];
  for (const n of spec.nodes) { const l = layer.get(n.id) ?? 0; (layers[l] ??= []).push(n.id); }
  const posInLayer = new Map<string, number>();
  layers.forEach((ids, l) => {
    if (l > 0) {
      const parents = (id: string) => forward.filter((ed) => ed.to === id).map((ed) => posInLayer.get(ed.from) ?? 0);
      const score = (id: string) => { const p = parents(id); return p.length ? p.reduce((a, b) => a + b, 0) / p.length : 0; };
      ids.sort((a, b) => score(a) - score(b));
    }
    ids.forEach((id, i) => posInLayer.set(id, i));
  });
  const widest = Math.max(...layers.map((l) => l.length));
  const down = spec.direction !== "right";
  const shapes: Shape[] = [];
  layers.forEach((ids, l) => {
    const offset = ((widest - ids.length) * (down ? nodeW + gapX : nodeH + gapY)) / 2;
    ids.forEach((id, i) => {
      const n = spec.nodes.find((x) => x.id === id)!;
      const x = down ? offset + i * (nodeW + gapX) : l * (nodeW + gapX * 2);
      const y = down ? l * (nodeH + gapY) : offset + i * (nodeH + gapY);
      shapes.push({ id: `n-${id}`, kind: n.shape ?? "rect", x, y, w: nodeW, h: nodeH, fill: n.color ?? "#e8eefc", stroke: "#3b4a6b", strokeW: 1.5, text: n.label, fontSize: 14, textColor: "#111111" });
    });
  });
  spec.edges.forEach((ed, k) => shapes.push({ id: `e-${k}`, kind: "connector", x: 0, y: 0, w: 0, h: 0, fill: "none", stroke: "#3b4a6b", strokeW: 1.5, from: `n-${ed.from}`, to: `n-${ed.to}`, ...(ed.label ? { text: ed.label, fontSize: 12 } : {}) }));
  return shapes;
}

/* ── .odg (LibreOffice Draw) ─────────────────────────────────────────────── */

export function toOdg(shapes: Shape[], opts: { title?: string; when?: string } = {}): ZipEntry[] {
  const byId = new Map(shapes.map((s) => [s.id, s]));
  const b = bounds(shapes);
  const cm = (px: number) => `${(px * 0.02646).toFixed(3)}cm`;
  const X = (x: number) => cm(x - b.x + 20), Y = (y: number) => cm(y - b.y + 20);
  const styles = new Map<string, string>();
  const gstyle = (s: Shape) => {
    const key = `${col(s.fill, "none")}|${col(s.stroke, "#333333")}|${s.strokeW}|${s.dash ? 1 : 0}|${s.kind === "connector" || s.kind === "arrow" ? 1 : 0}`;
    if (!styles.has(key)) styles.set(key, `gr${styles.size + 1}`);
    return styles.get(key)!;
  };
  const text = (s: Shape) => (s.text ? s.text.split("\n").map((l) => `<text:p>${escapeXml(l)}</text:p>`).join("") : "");
  const items = shapes.map((s) => {
    const g = gstyle(s);
    const box = `svg:x="${X(s.x)}" svg:y="${Y(s.y)}" svg:width="${cm(s.w)}" svg:height="${cm(s.h)}"`;
    switch (s.kind) {
      case "rect": case "round": return `<draw:rect draw:style-name="${g}" ${box}${s.kind === "round" ? ` draw:corner-radius="${cm(Math.min(16, s.h / 3))}"` : ""}>${text(s)}</draw:rect>`;
      case "ellipse": return `<draw:ellipse draw:style-name="${g}" ${box}>${text(s)}</draw:ellipse>`;
      case "diamond": return `<draw:polygon draw:style-name="${g}" ${box} svg:viewBox="0 0 1000 1000" draw:points="500,0 1000,500 500,1000 0,500">${text(s)}</draw:polygon>`;
      case "text": return `<draw:frame ${box}><draw:text-box>${text(s)}</draw:text-box></draw:frame>`;
      case "line": case "arrow": return `<draw:line draw:style-name="${g}" svg:x1="${X(s.x)}" svg:y1="${Y(s.y)}" svg:x2="${X(s.x + s.w)}" svg:y2="${Y(s.y + s.h)}"/>`;
      case "path": return s.points?.length ? `<draw:polyline draw:style-name="${g}" ${box} svg:viewBox="0 0 ${Math.max(1, Math.round(s.w))} ${Math.max(1, Math.round(s.h))}" draw:points="${s.points.map(([px, py]) => `${Math.round(px)},${Math.round(py)}`).join(" ")}"/>` : "";
      case "connector": {
        const ends = connectorEnds(s, byId);
        if (!ends) return "";
        return `<draw:line draw:style-name="${g}" svg:x1="${X(ends[0][0])}" svg:y1="${Y(ends[0][1])}" svg:x2="${X(ends[1][0])}" svg:y2="${Y(ends[1][1])}">${text(s)}</draw:line>`;
      }
    }
  });
  const auto = [...styles.entries()].map(([k, n]) => {
    const [fill, stroke, sw, dash, arrow] = k.split("|");
    return `<style:style style:name="${n}" style:family="graphic"><style:graphic-properties draw:fill="${fill === "none" ? "none" : "solid"}"${fill !== "none" ? ` draw:fill-color="${fill}"` : ""} draw:stroke="${dash === "1" ? "dash" : "solid"}" svg:stroke-color="${stroke}" svg:stroke-width="${cm(Number(sw))}"${arrow === "1" ? ` draw:marker-end="Arrow" draw:marker-end-width="0.3cm"` : ""}/></style:style>`;
  }).join("");
  const w = b.w + 40, h = b.h + 40;
  const content = `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${ODF_NS}><office:automatic-styles>${auto}</office:automatic-styles><office:body><office:drawing><draw:page draw:name="Page1" draw:master-page-name="Default">${items.join("")}</draw:page></office:drawing></office:body></office:document-content>`;
  const styleXml = `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${ODF_NS}><office:styles><draw:marker draw:name="Arrow" svg:viewBox="0 0 20 30" svg:d="M10 0l-10 30h20z"/></office:styles><office:automatic-styles><style:page-layout style:name="PM1"><style:page-layout-properties fo:page-width="${cm(w)}" fo:page-height="${cm(h)}" fo:margin-top="0cm" fo:margin-bottom="0cm" fo:margin-left="0cm" fo:margin-right="0cm"/></style:page-layout></office:automatic-styles><office:master-styles><style:master-page style:name="Default" style:page-layout-name="PM1"/></office:master-styles></office:document-styles>`;
  const mime = "application/vnd.oasis.opendocument.graphics";
  return [
    { path: "mimetype", content: mime },
    { path: "META-INF/manifest.xml", content: odfManifest(mime, [{ path: "content.xml", type: "text/xml" }, { path: "styles.xml", type: "text/xml" }, { path: "meta.xml", type: "text/xml" }]) },
    { path: "content.xml", content },
    { path: "styles.xml", content: styleXml },
    { path: "meta.xml", content: odfMeta(opts.title ?? "Drawing", opts.when ?? "2026-01-01T00:00:00Z") },
  ];
}
