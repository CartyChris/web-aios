/* ────────────────────────────────────────────────────────────────────────────
   Structural edits to a workbook: insert/delete rows and columns, sort, fill.

   Inserting a row must also rewrite every formula that points below it --
   on this sheet and on any other sheet that refers here -- or totals quietly
   start summing the wrong cells. References into a deleted row or column
   become #REF!, as in Excel and LibreOffice; a range that loses only its
   edge shrinks rather than breaking.

   PURE.
   ──────────────────────────────────────────────────────────────────────────── */

import { tokenize, parseAddr, addr, indexToCol, shiftFormula, literal, type Workbook, type Sheet } from "./formula";

type Axis = "row" | "col";

/** Rewrite the references in one formula for an insert (count > 0) or delete (count < 0) at `at` on `target`. */
export function adjustFormula(src: string, home: string, target: string, axis: Axis, at: number, count: number): string {
  if (!src.startsWith("=")) return src;
  const body = src.slice(1);
  let toks;
  try { toks = tokenize(body); } catch { return src; }
  let out = "", last = 0;
  const onTarget = (sheet?: string) => (sheet ?? home).toLowerCase() === target.toLowerCase();
  const move = (i: number): number | null => {
    if (count > 0) return i >= at ? i + count : i;
    const del = -count;
    if (i >= at && i < at + del) return null;
    return i >= at + del ? i - del : i;
  };
  const fmt = (ref: string, c: number, r: number) => {
    const a = parseAddr(ref)!;
    return `${a.absC ? "$" : ""}${indexToCol(c)}${a.absR ? "$" : ""}${r + 1}`;
  };
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.t !== "ref" || !onTarget(t.sheet)) continue;
    const prefix = body.slice(t.s, t.e).slice(0, body.slice(t.s, t.e).length - t.ref.length);
    const a = parseAddr(t.ref)!;
    const nx = toks[k + 1], nr = toks[k + 2];
    if (nx?.t === ":" && nr?.t === "ref") {
      const b = parseAddr(nr.ref)!;
      const lo = axis === "row" ? Math.min(a.r, b.r) : Math.min(a.c, b.c);
      const hi = axis === "row" ? Math.max(a.r, b.r) : Math.max(a.c, b.c);
      let nlo: number | null, nhi: number | null;
      if (count > 0) { nlo = move(lo); nhi = hi >= at ? hi + count : hi; }
      else {
        const del = -count;
        const survivors = [];
        for (let i = lo; i <= hi; i++) if (i < at || i >= at + del) survivors.push(i);
        nlo = survivors.length ? move(survivors[0]) : null;
        nhi = survivors.length ? move(survivors[survivors.length - 1]) : null;
      }
      const text = nlo === null || nhi === null ? "#REF!"
        : axis === "row" ? `${prefix}${fmt(t.ref, a.c, nlo)}:${fmt(nr.ref, b.c, nhi)}` : `${prefix}${fmt(t.ref, nlo, a.r)}:${fmt(nr.ref, nhi, b.r)}`;
      out += body.slice(last, t.s) + text;
      last = nr.e;
      k += 2;
      continue;
    }
    const n = move(axis === "row" ? a.r : a.c);
    out += body.slice(last, t.s) + (n === null ? "#REF!" : `${prefix}${axis === "row" ? fmt(t.ref, a.c, n) : fmt(t.ref, n, a.r)}`);
    last = t.e;
  }
  return `=${out}${body.slice(last)}`;
}

/** Insert (count > 0) or delete (count < 0) rows or columns on one sheet, fixing formulas everywhere. */
export function shiftStructure(wb: Workbook, sheetName: string, axis: Axis, at: number, count: number): Workbook {
  return {
    sheets: wb.sheets.map((s) => {
      const cells: Record<string, string> = {};
      for (const [a, raw] of Object.entries(s.cells)) {
        const fixed = adjustFormula(raw, s.name, sheetName, axis, at, count);
        if (s.name !== sheetName) { cells[a] = fixed; continue; }
        const p = parseAddr(a)!;
        const i = axis === "row" ? p.r : p.c;
        let ni: number;
        if (count > 0) ni = i >= at ? i + count : i;
        else { if (i >= at && i < at - count) continue; ni = i >= at - count ? i + count : i; }
        cells[axis === "row" ? addr(p.c, ni) : addr(ni, p.r)] = fixed;
      }
      return { ...s, cells };
    }),
  };
}

export interface Rect { c1: number; r1: number; c2: number; r2: number }

/** Sort the rows of a rectangle by one column; blanks last; numbers before text. */
export function sortRange(sheet: Sheet, rect: Rect, byCol: number, desc: boolean, values?: Record<string, unknown>): Sheet {
  const rows: Array<Record<number, string>> = [];
  for (let r = rect.r1; r <= rect.r2; r++) {
    const row: Record<number, string> = {};
    for (let c = rect.c1; c <= rect.c2; c++) { const v = sheet.cells[addr(c, r)]; if (v !== undefined) row[c] = v; }
    rows.push(row);
  }
  const keyOf = (row: Record<number, string>, i: number) => {
    const raw = row[byCol];
    if (raw === undefined || raw === "") return null;
    const v = values ? values[addr(byCol, rect.r1 + i)] : literal(raw);
    return typeof v === "number" || typeof v === "string" || typeof v === "boolean" ? v : raw;
  };
  const order = rows.map((row, i) => ({ row, k: keyOf(row, i), i }));
  order.sort((a, b) => {
    if (a.k === null && b.k === null) return a.i - b.i;
    if (a.k === null) return 1;
    if (b.k === null) return -1;
    let d: number;
    if (typeof a.k === "number" && typeof b.k === "number") d = a.k - b.k;
    else if (typeof a.k === "number") d = -1;
    else if (typeof b.k === "number") d = 1;
    else d = String(a.k).localeCompare(String(b.k), undefined, { numeric: true, sensitivity: "base" });
    return (desc ? -d : d) || a.i - b.i;
  });
  const cells = { ...sheet.cells };
  for (let r = rect.r1; r <= rect.r2; r++) for (let c = rect.c1; c <= rect.c2; c++) delete cells[addr(c, r)];
  order.forEach(({ row, i }, k) => {
    for (const [c, raw] of Object.entries(row)) cells[addr(Number(c), rect.r1 + k)] = shiftFormula(raw, k - i, 0);
  });
  return { ...sheet, cells };
}

/** Copy the first row (down) or column (right) of a rectangle across it, shifting formulas as fill does. */
export function fill(sheet: Sheet, rect: Rect, dir: "down" | "right"): Sheet {
  const cells = { ...sheet.cells };
  if (dir === "down") {
    for (let c = rect.c1; c <= rect.c2; c++) {
      const src = sheet.cells[addr(c, rect.r1)];
      for (let r = rect.r1 + 1; r <= rect.r2; r++) { if (src === undefined) delete cells[addr(c, r)]; else cells[addr(c, r)] = shiftFormula(src, r - rect.r1, 0); }
    }
  } else {
    for (let r = rect.r1; r <= rect.r2; r++) {
      const src = sheet.cells[addr(rect.c1, r)];
      for (let c = rect.c1 + 1; c <= rect.c2; c++) { if (src === undefined) delete cells[addr(c, r)]; else cells[addr(c, r)] = shiftFormula(src, 0, c - rect.c1); }
    }
  }
  return { ...sheet, cells };
}

/** Paste a block of raw cells at a new top-left, shifting formulas by the move (copy semantics). */
export function pasteBlock(sheet: Sheet, block: string[][], at: { c: number; r: number }, from?: { c: number; r: number }): Sheet {
  const cells = { ...sheet.cells };
  block.forEach((row, i) => row.forEach((raw, j) => {
    const a = addr(at.c + j, at.r + i);
    if (raw === "") delete cells[a];
    else cells[a] = from ? shiftFormula(raw, at.r - from.r, at.c - from.c) : raw;
  }));
  return { ...sheet, cells };
}

/** "SUM of the numbers directly above": the range AutoSum proposes for a cell. */
export function autoSumRange(sheet: Sheet, values: Record<string, unknown>, c: number, r: number): string | null {
  let top = r - 1;
  while (top >= 0 && typeof values[addr(c, top)] !== "number") top--;
  if (top < 0) return null;
  let start = top;
  while (start - 1 >= 0 && typeof values[addr(c, start - 1)] === "number") start--;
  return `=SUM(${addr(c, start)}:${addr(c, top)})`;
}

/** Move per-cell data keyed by address (formats) along with an insert or delete, so a
 *  currency total stays a currency total when a row is added above it. */
export function shiftKeyed<T>(map: Record<string, T>, axis: Axis, at: number, count: number): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [a, v] of Object.entries(map)) {
    const p = parseAddr(a);
    if (!p) continue;
    const i = axis === "row" ? p.r : p.c;
    let ni: number;
    if (count > 0) ni = i >= at ? i + count : i;
    else { if (i >= at && i < at - count) continue; ni = i >= at - count ? i + count : i; }
    out[axis === "row" ? addr(p.c, ni) : addr(ni, p.r)] = v;
  }
  return out;
}
