/* ────────────────────────────────────────────────────────────────────────────
   Office files in the OS filesystem: which app opens what, and reading a
   stored document defensively.

   Native documents are JSON in the VFS (the VFS stores text), under one
   extension per app. Everything is re-validated on open, the way stored
   panels are: a file edited by hand, written by an older version, or made by
   a model must open as something sensible or fail with a reason -- never
   crash the app or carry unexpected fields into it.

   PURE.
   ──────────────────────────────────────────────────────────────────────────── */

import type { Doc, Block } from "./doc";
import type { Workbook } from "./formula";
import { normaliseTheme, type Deck, type Slide, type Layout } from "./slides";
import type { Shape, ShapeKind } from "./draw";
import type { Table, ColType } from "./basedb";

export type OfficeApp = "writer" | "sheets" | "impress" | "draw" | "math" | "base";

export const NATIVE_EXT: Record<OfficeApp, string> = {
  writer: "wdoc", sheets: "wsheet", impress: "wslides", draw: "wdraw", math: "wmath", base: "wbase",
};
export const FOLDER: Record<OfficeApp, string> = {
  writer: "/documents", sheets: "/documents", impress: "/documents", draw: "/documents", math: "/documents", base: "/documents",
};

/** Formats each app can import from a file the person picks. */
export const IMPORTS: Record<OfficeApp, string[]> = {
  writer: ["docx", "odt", "md", "markdown", "txt", "html", "htm"],
  sheets: ["xlsx", "ods", "csv", "tsv"],
  impress: ["pptx", "odp", "md"],
  draw: ["svg"],
  math: ["tex", "txt"],
  base: ["csv", "tsv", "json"],
};

export function extOf(path: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return m ? m[1].toLowerCase() : "";
}

/** The office app that opens a path, or null for anything else. */
export function appForPath(path: string): OfficeApp | null {
  const e = extOf(path);
  for (const [app, ext] of Object.entries(NATIVE_EXT) as Array<[OfficeApp, string]>) if (e === ext) return app;
  return null;
}

export function newName(app: OfficeApp, existing: Set<string>, base = "Untitled"): string {
  const ext = NATIVE_EXT[app];
  for (let n = 1; n < 10_000; n++) {
    const p = `${FOLDER[app]}/${base}${n === 1 ? "" : ` ${n}`}.${ext}`;
    if (!existing.has(p)) return p;
  }
  return `${FOLDER[app]}/${base} ${Date.now()}.${ext}`;
}

/* ── validation ──────────────────────────────────────────────────────────── */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 100_000) => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);

function runs(v: unknown) {
  return (Array.isArray(v) ? v : []).filter(isObj).slice(0, 5000).map((r) => {
    const out: { text: string; b?: boolean; i?: boolean; u?: boolean; s?: boolean; code?: boolean; href?: string; color?: string } = { text: str(r.text) };
    for (const k of ["b", "i", "u", "s", "code"] as const) if (r[k] === true) out[k] = true;
    if (typeof r.href === "string" && /^(https?:|mailto:|#)/i.test(r.href)) out.href = r.href.slice(0, 2000);
    if (typeof r.color === "string" && /^#[0-9a-f]{6}$/i.test(r.color)) out.color = r.color;
    return out;
  });
}

export function parseDoc(v: unknown): Doc {
  const o = isObj(v) ? v : {};
  const blocks: Block[] = [];
  for (const b of (Array.isArray(o.blocks) ? o.blocks : []).filter(isObj).slice(0, 20_000)) {
    const align = b.align === "center" || b.align === "right" || b.align === "justify" ? b.align : undefined;
    switch (b.t) {
      case "h": blocks.push({ t: "h", level: ([1, 2, 3, 4].includes(b.level as number) ? b.level : 1) as 1 | 2 | 3 | 4, runs: runs(b.runs), ...(align ? { align } : {}) }); break;
      case "p": blocks.push({ t: "p", runs: runs(b.runs), ...(align ? { align } : {}) }); break;
      case "quote": blocks.push({ t: "quote", runs: runs(b.runs) }); break;
      case "code": blocks.push({ t: "code", text: str(b.text) }); break;
      case "list": blocks.push({ t: "list", ordered: b.ordered === true, items: (Array.isArray(b.items) ? b.items : []).filter(isObj).map((it) => ({ runs: runs(it.runs), level: Math.max(0, Math.min(4, Math.floor(num(it.level)))) })) }); break;
      case "table": blocks.push({ t: "table", rows: (Array.isArray(b.rows) ? b.rows : []).slice(0, 1000).map((r) => (Array.isArray(r) ? r : []).slice(0, 64).map(runs)) }); break;
      case "img": if (typeof b.src === "string" && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(b.src)) blocks.push({ t: "img", src: b.src, alt: str(b.alt, 500), ...(num(b.w) > 0 ? { w: Math.min(2000, num(b.w)) } : {}), ...(num(b.h) > 0 ? { h: Math.min(4000, num(b.h)) } : {}) }); break;
      case "hr": blocks.push({ t: "hr" }); break;
      case "pagebreak": blocks.push({ t: "pagebreak" }); break;
    }
  }
  return { title: str(o.title, 200) || "Untitled", blocks };
}

export interface CellFormat { b?: boolean; i?: boolean; align?: "left" | "center" | "right"; nf?: string; bg?: string; color?: string }
export interface SheetFile { wb: Workbook; formats: Record<string, Record<string, CellFormat>>; colWidths: Record<string, Record<string, number>> }

export function parseSheetFile(v: unknown): SheetFile {
  const o = isObj(v) ? v : {};
  const wbIn = isObj(o.wb) ? o.wb : {};
  const seen = new Set<string>();
  const sheets = (Array.isArray(wbIn.sheets) ? wbIn.sheets : []).filter(isObj).slice(0, 64).map((s, i) => {
    let name = str(s.name, 64).replace(/[!'[\]]/g, "") || `Sheet${i + 1}`;
    while (seen.has(name.toLowerCase())) name = `${name} 2`;
    seen.add(name.toLowerCase());
    const cells: Record<string, string> = {};
    if (isObj(s.cells)) for (const [a, val] of Object.entries(s.cells)) if (/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(a) && typeof val === "string" && val !== "") cells[a] = val.slice(0, 32_000);
    return { name, cells };
  });
  const formats: SheetFile["formats"] = {};
  if (isObj(o.formats)) for (const [sheet, fm] of Object.entries(o.formats)) {
    if (!isObj(fm)) continue;
    formats[sheet] = {};
    for (const [a, f] of Object.entries(fm)) {
      if (!isObj(f) || !/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(a)) continue;
      const c: CellFormat = {};
      if (f.b === true) c.b = true;
      if (f.i === true) c.i = true;
      if (f.align === "left" || f.align === "center" || f.align === "right") c.align = f.align;
      if (typeof f.nf === "string" && f.nf.length < 40) c.nf = f.nf;
      if (typeof f.bg === "string" && /^#[0-9a-f]{6}$/i.test(f.bg)) c.bg = f.bg;
      if (typeof f.color === "string" && /^#[0-9a-f]{6}$/i.test(f.color)) c.color = f.color;
      formats[sheet][a] = c;
    }
  }
  const colWidths: SheetFile["colWidths"] = {};
  if (isObj(o.colWidths)) for (const [sheet, cw] of Object.entries(o.colWidths)) {
    if (!isObj(cw)) continue;
    colWidths[sheet] = {};
    for (const [c, w] of Object.entries(cw)) if (/^[A-Z]{1,3}$/.test(c) && typeof w === "number" && w >= 30 && w <= 800) colWidths[sheet][c] = w;
  }
  return { wb: { sheets: sheets.length ? sheets : [{ name: "Sheet1", cells: {} }] }, formats, colWidths };
}

const LAYOUTS: Layout[] = ["title", "content", "two", "section", "quote", "image"];
export function parseDeck(v: unknown): Deck {
  const o = isObj(v) ? v : {};
  const bullets = (x: unknown) => (Array.isArray(x) ? x : []).filter(isObj).slice(0, 60).map((b) => ({ text: str(b.text, 1000), level: Math.max(0, Math.min(3, Math.floor(num(b.level)))) }));
  const slides: Slide[] = (Array.isArray(o.slides) ? o.slides : []).filter(isObj).slice(0, 500).map((s) => {
    const slide: Slide = { layout: LAYOUTS.includes(s.layout as Layout) ? (s.layout as Layout) : "content", title: str(s.title, 500), bullets: bullets(s.bullets) };
    if (typeof s.subtitle === "string") slide.subtitle = s.subtitle.slice(0, 1000);
    if (Array.isArray(s.right)) slide.right = bullets(s.right);
    if (typeof s.image === "string" && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(s.image)) slide.image = s.image;
    if (typeof s.notes === "string") slide.notes = s.notes.slice(0, 20_000);
    return slide;
  });
  return { title: str(o.title, 200) || "Untitled deck", theme: normaliseTheme(isObj(o.theme) ? (o.theme as Partial<Deck["theme"]>) : undefined), slides: slides.length ? slides : [{ layout: "title", title: str(o.title, 200) || "Untitled deck", bullets: [] }] };
}

const KINDS: ShapeKind[] = ["rect", "round", "ellipse", "diamond", "text", "line", "arrow", "path", "connector"];
const hexOr = (v: unknown, d: string) => (typeof v === "string" && (/^#[0-9a-f]{6}$/i.test(v) || v === "none") ? v : d);
export function parseDrawing(v: unknown): { shapes: Shape[]; bg: string } {
  const o = isObj(v) ? v : {};
  const ids = new Set<string>();
  const shapes: Shape[] = [];
  for (const s of (Array.isArray(o.shapes) ? o.shapes : []).filter(isObj).slice(0, 5000)) {
    const id = str(s.id, 60);
    if (!id || ids.has(id) || !KINDS.includes(s.kind as ShapeKind)) continue;
    ids.add(id);
    const shape: Shape = { id, kind: s.kind as ShapeKind, x: num(s.x), y: num(s.y), w: num(s.w), h: num(s.h), fill: hexOr(s.fill, "none"), stroke: hexOr(s.stroke, "#333333"), strokeW: Math.max(0, Math.min(40, num(s.strokeW, 1))) };
    if (typeof s.text === "string") shape.text = s.text.slice(0, 2000);
    if (num(s.fontSize) > 0) shape.fontSize = Math.min(200, num(s.fontSize));
    if (typeof s.textColor === "string" && /^#[0-9a-f]{6}$/i.test(s.textColor)) shape.textColor = s.textColor;
    if (Array.isArray(s.points)) shape.points = s.points.slice(0, 5000).filter((p): p is [number, number] => Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === "number" && Number.isFinite(x)));
    if (typeof s.from === "string") shape.from = s.from;
    if (typeof s.to === "string") shape.to = s.to;
    if (s.dash === true) shape.dash = true;
    shapes.push(shape);
  }
  return { shapes, bg: hexOr(o.bg, "#ffffff") === "none" ? "#ffffff" : hexOr(o.bg, "#ffffff") };
}

export interface MathFile { formulas: Array<{ id: string; latex: string; label: string }>; size: number }
export function parseMath(v: unknown): MathFile {
  const o = isObj(v) ? v : {};
  const formulas = (Array.isArray(o.formulas) ? o.formulas : []).filter(isObj).slice(0, 500).map((f, i) => ({ id: str(f.id, 40) || `f${i + 1}`, latex: str(f.latex, 5000), label: str(f.label, 200) }));
  return { formulas: formulas.length ? formulas : [{ id: "f1", latex: "e^{i\\pi} + 1 = 0", label: "Euler's identity" }], size: Math.max(12, Math.min(96, num(o.size, 28))) };
}

const TYPES: ColType[] = ["text", "number", "date", "bool"];
export interface BaseFile { tables: Table[]; queries: Array<{ name: string; sql: string }> }
export function parseBase(v: unknown): BaseFile {
  const o = isObj(v) ? v : {};
  const names = new Set<string>();
  const tables: Table[] = [];
  for (const t of (Array.isArray(o.tables) ? o.tables : []).filter(isObj).slice(0, 100)) {
    const name = str(t.name, 60).replace(/[^A-Za-z0-9_]/g, "_") || `table${tables.length + 1}`;
    if (names.has(name.toLowerCase())) continue;
    names.add(name.toLowerCase());
    const columns = (Array.isArray(t.columns) ? t.columns : []).filter(isObj).slice(0, 64).map((c, i) => ({ name: str(c.name, 60).replace(/[^A-Za-z0-9_]/g, "_") || `col${i + 1}`, type: TYPES.includes(c.type as ColType) ? (c.type as ColType) : "text" }));
    const rows = (Array.isArray(t.rows) ? t.rows : []).slice(0, 100_000).map((r) => columns.map((_, j) => { const x = Array.isArray(r) ? r[j] : null; return typeof x === "string" || typeof x === "number" || typeof x === "boolean" ? x : null; }));
    tables.push({ name, columns, rows });
  }
  const queries = (Array.isArray(o.queries) ? o.queries : []).filter(isObj).slice(0, 200).map((q) => ({ name: str(q.name, 80), sql: str(q.sql, 10_000) })).filter((q) => q.name && q.sql);
  return { tables, queries };
}
