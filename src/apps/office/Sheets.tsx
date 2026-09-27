"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { AppProps } from "@/kernel/types";
import { evaluateWorkbook, evaluateOne, displayValue, formatWithPattern, addr, indexToCol, parseAddr, isErr, FUNCTION_NAMES, type Workbook, type Scalar } from "@/lib/office/formula";
import { parseSheetFile, type SheetFile, type CellFormat } from "@/lib/office/files";
import { toXlsx, fromXlsx, toOds, fromOds, parseCsv, toCsv, cellsToGrid, gridToCells } from "@/lib/office/sheetio";
import { shiftStructure, shiftKeyed, sortRange, fill, pasteBlock, autoSumRange, type Rect } from "@/lib/office/sheetops";
import { FORMULA_SYSTEM, TABLE_SYSTEM, formulaPrompt, extractFormula, extractCsv, cleanReply } from "@/lib/office/ai";
import { parsePanel } from "@/lib/aios-agent";
import { PanelView } from "@/shell/PanelView";
import { useOfficeFile, FileBar, AiPanel, TB, useAiCall, pickFile, unzipPackage, downloadPackage, downloadBytes, MIME } from "./common";
import { cn } from "@/lib/cn";

/* Sheets: the spreadsheet (LibreOffice's Calc; "Calc" here is already the
   calculator). The engine, formats and structural edits are all pure and
   tested in lib/office; this file is the grid, the keyboard, the clipboard
   and the AI buttons. */

const blank = (): SheetFile => ({ wb: { sheets: [{ name: "Sheet1", cells: {} }] }, formats: {}, colWidths: {} });
const ROW_H = 22;
const HEAD_W = 44;
const DEF_W = 96;
const NUMBER_FORMATS: Array<[string, string]> = [["", "General"], ["0", "0"], ["0.00", "0.00"], ["#,##0", "1,000"], ["#,##0.00", "1,000.00"], ["0%", "0%"], ["0.0%", "0.0%"], ["$#,##0.00", "$1,000.00"]];
const FILLS = ["", "#fff3bf", "#d3f9d8", "#d0ebff", "#ffe3e3", "#f3d9fa", "#e9ecef"];

type Pos = { c: number; r: number };
const rectOf = (a: Pos, b: Pos): Rect => ({ c1: Math.min(a.c, b.c), r1: Math.min(a.r, b.r), c2: Math.max(a.c, b.c), r2: Math.max(a.r, b.r) });
const inRect = (p: Pos, r: Rect) => p.c >= r.c1 && p.c <= r.c2 && p.r >= r.r1 && p.r <= r.r2;

export default function Sheets({ args }: AppProps) {
  const f = useOfficeFile("sheets", args, parseSheetFile, blank);
  const ai = useAiCall();
  const [active, setActive] = useState(0);
  const sheet = f.data.wb.sheets[Math.min(active, f.data.wb.sheets.length - 1)];
  const [anchor, setAnchor] = useState<Pos>({ c: 0, r: 0 });
  const [focus, setFocus] = useState<Pos>({ c: 0, r: 0 });
  const [editing, setEditing] = useState<null | { text: string; fromBar: boolean }>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  const [chart, setChart] = useState<null | ReturnType<typeof chartFromSelection>>(null);
  // Open by default where there is room; on a phone the document comes first.
  const [showAi, setShowAi] = useState(() => typeof window === "undefined" || window.innerWidth >= 700);
  const [aiMode, setAiMode] = useState<"formula" | "table" | "answer">("formula");
  const [answer, setAnswer] = useState("");
  const [renaming, setRenaming] = useState<number | null>(null);
  const history = useRef<{ undo: SheetFile[]; redo: SheetFile[] }>({ undo: [], redo: [] });
  const clip = useRef<{ block: string[][]; from: Pos } | null>(null);
  const grid = useRef<HTMLDivElement>(null);

  const [now] = useState(() => Date.now());
  const values = useMemo(() => evaluateWorkbook(f.data.wb, { now, tzOffsetMin: new Date(now).getTimezoneOffset() }).values, [f.data.wb, now]);
  const vals = useMemo(() => values[sheet.name] ?? {}, [values, sheet.name]);
  const formats = f.data.formats[sheet.name] ?? {};
  const widths = f.data.colWidths[sheet.name] ?? {};
  const sel = rectOf(anchor, focus);

  // Size the grid to what is used, with room to grow.
  let maxR = 0, maxC = 0;
  for (const a of Object.keys(sheet.cells)) { const p = parseAddr(a); if (p) { maxR = Math.max(maxR, p.r); maxC = Math.max(maxC, p.c); } }
  const rows = Math.max(100, maxR + 50, focus.r + 20);
  const cols = Math.max(26, maxC + 5, focus.c + 3);
  const colW = (c: number) => widths[indexToCol(c)] ?? DEF_W;
  const firstRow = Math.max(0, Math.floor(scrollTop / ROW_H) - 5);
  const lastRow = Math.min(rows - 1, firstRow + Math.ceil(viewH / ROW_H) + 10);

  const commit = useCallback((next: SheetFile) => {
    history.current.undo.push(f.data);
    if (history.current.undo.length > 100) history.current.undo.shift();
    history.current.redo = [];
    f.update(next);
  }, [f]);

  const setSheet = (s: typeof sheet, extra?: Partial<SheetFile>) =>
    commit({ ...f.data, ...extra, wb: { sheets: f.data.wb.sheets.map((x) => (x.name === sheet.name ? s : x)) } });

  const setCell = (p: Pos, raw: string) => {
    const cells = { ...sheet.cells };
    if (raw === "") delete cells[addr(p.c, p.r)];
    else cells[addr(p.c, p.r)] = raw;
    setSheet({ ...sheet, cells });
  };

  const setFormat = (patch: Partial<CellFormat>) => {
    const next = { ...formats };
    for (let r = sel.r1; r <= sel.r2; r++) for (let c = sel.c1; c <= sel.c2; c++) {
      const a = addr(c, r);
      const merged = { ...(next[a] ?? {}), ...patch };
      for (const k of Object.keys(merged) as Array<keyof CellFormat>) if (merged[k] === undefined || merged[k] === "" || merged[k] === false) delete merged[k];
      if (Object.keys(merged).length) next[a] = merged; else delete next[a];
    }
    commit({ ...f.data, formats: { ...f.data.formats, [sheet.name]: next } });
  };

  const undo = () => { const u = history.current.undo.pop(); if (u) { history.current.redo.push(f.data); f.update(u); } };
  const redo = () => { const r = history.current.redo.pop(); if (r) { history.current.undo.push(f.data); f.update(r); } };

  const move = (dc: number, dr: number, extend = false) => {
    const next = { c: Math.max(0, focus.c + dc), r: Math.max(0, focus.r + dr) };
    setFocus(next);
    if (!extend) setAnchor(next);
    // Keep the moved-to cell visible.
    const el = grid.current;
    if (el) {
      const top = next.r * ROW_H, bottom = top + ROW_H + ROW_H;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
    }
  };

  const startEdit = (initial?: string) => setEditing({ text: initial ?? sheet.cells[addr(anchor.c, anchor.r)] ?? "", fromBar: false });
  const finishEdit = (dc = 0, dr = 1) => {
    if (!editing) return;
    setCell(anchor, editing.text);
    setEditing(null);
    const next = { c: Math.max(0, anchor.c + dc), r: Math.max(0, anchor.r + dr) };
    setAnchor(next);
    setFocus(next);
    grid.current?.focus();
  };

  const selectionBlock = (): string[][] => {
    const out: string[][] = [];
    for (let r = sel.r1; r <= sel.r2; r++) { const row: string[] = []; for (let c = sel.c1; c <= sel.c2; c++) row.push(sheet.cells[addr(c, r)] ?? ""); out.push(row); }
    return out;
  };
  const selectionValues = (): string[][] => {
    const out: string[][] = [];
    for (let r = sel.r1; r <= sel.r2; r++) { const row: string[] = []; for (let c = sel.c1; c <= sel.c2; c++) row.push(displayValue(vals[addr(c, r)] ?? null)); out.push(row); }
    return out;
  };
  const clearSelection = () => {
    const cells = { ...sheet.cells };
    for (let r = sel.r1; r <= sel.r2; r++) for (let c = sel.c1; c <= sel.c2; c++) delete cells[addr(c, r)];
    setSheet({ ...sheet, cells });
  };

  const copy = async (cut: boolean) => {
    const block = selectionBlock();
    clip.current = { block, from: { c: sel.c1, r: sel.r1 } };
    try { await navigator.clipboard.writeText(selectionValues().map((r) => r.join("\t")).join("\n")); } catch { /* the internal clipboard still works */ }
    if (cut) clearSelection();
  };
  const paste = async () => {
    let text = "";
    try { text = await navigator.clipboard.readText(); } catch { /* fall back to our own */ }
    const own = clip.current;
    // Our own copy, unchanged since: paste formulas (shifted). Anything else: values.
    const ownText = own ? own.block.map((r) => r.join("\t")).join("\n") : null;
    if (own && (!text || text === ownText || text === selectionValuesFrom(own))) {
      setSheet(pasteBlock(sheet, own.block, { c: sel.c1, r: sel.r1 }, own.from));
      return;
    }
    if (!text) return;
    const block = parseCsv(text.replace(/\r?\n$/, ""), text.includes("\t") ? "\t" : undefined);
    setSheet(pasteBlock(sheet, block, { c: sel.c1, r: sel.r1 }));
  };
  const selectionValuesFrom = (own: { block: string[][]; from: Pos }) =>
    own.block.map((row, i) => row.map((_, j) => displayValue(vals[addr(own.from.c + j, own.from.r + i)] ?? null)).join("\t")).join("\n");

  const onKey = (e: React.KeyboardEvent) => {
    if (editing) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key;
    if (mod && k.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && k.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
    if (mod && k.toLowerCase() === "c") { e.preventDefault(); void copy(false); return; }
    if (mod && k.toLowerCase() === "x") { e.preventDefault(); void copy(true); return; }
    if (mod && k.toLowerCase() === "v") { e.preventDefault(); void paste(); return; }
    if (mod && k.toLowerCase() === "b") { e.preventDefault(); setFormat({ b: !formats[addr(anchor.c, anchor.r)]?.b }); return; }
    if (mod && k.toLowerCase() === "i") { e.preventDefault(); setFormat({ i: !formats[addr(anchor.c, anchor.r)]?.i }); return; }
    if (mod && k.toLowerCase() === "d") { e.preventDefault(); setSheet(fill(sheet, sel, "down")); return; }
    if (mod && k.toLowerCase() === "r") { e.preventDefault(); setSheet(fill(sheet, sel, "right")); return; }
    if (mod && k.toLowerCase() === "a") { e.preventDefault(); setAnchor({ c: 0, r: 0 }); setFocus({ c: cols - 1, r: rows - 1 }); return; }
    if (k === "ArrowUp") { e.preventDefault(); move(0, -1, e.shiftKey); return; }
    if (k === "ArrowDown") { e.preventDefault(); move(0, 1, e.shiftKey); return; }
    if (k === "ArrowLeft") { e.preventDefault(); move(-1, 0, e.shiftKey); return; }
    if (k === "ArrowRight") { e.preventDefault(); move(1, 0, e.shiftKey); return; }
    if (k === "Tab") { e.preventDefault(); move(e.shiftKey ? -1 : 1, 0); return; }
    if (k === "Enter") { e.preventDefault(); if (e.shiftKey) move(0, -1); else startEdit(); return; }
    if (k === "F2") { e.preventDefault(); startEdit(); return; }
    if (k === "Delete" || k === "Backspace") { e.preventDefault(); clearSelection(); return; }
    if (k.length === 1 && !mod && !e.altKey) { e.preventDefault(); setEditing({ text: k, fromBar: false }); }
  };

  const drag = useRef(false);
  const cellDown = (p: Pos, e: React.PointerEvent) => {
    if (editing) finishEdit(0, 0);
    if (e.shiftKey) setFocus(p);
    else { setAnchor(p); setFocus(p); }
    drag.current = true;
    grid.current?.focus();
  };

  /* ── structure ── */
  // Cells, every formula that points at them, and their formats all move together.
  const structural = (axis: "row" | "col", at: number, count: number) => commit({
    ...f.data,
    wb: shiftStructure(f.data.wb, sheet.name, axis, at, count),
    formats: { ...f.data.formats, [sheet.name]: shiftKeyed(formats, axis, at, count) },
  });
  const insertRow = () => structural("row", sel.r1, sel.r2 - sel.r1 + 1);
  const deleteRow = () => structural("row", sel.r1, -(sel.r2 - sel.r1 + 1));
  const insertCol = () => structural("col", sel.c1, sel.c2 - sel.c1 + 1);
  const deleteCol = () => structural("col", sel.c1, -(sel.c2 - sel.c1 + 1));
  const sort = (desc: boolean) => {
    // With a header row selected, keep it in place.
    const hasHeader = sel.r2 > sel.r1 && typeof vals[addr(anchor.c, sel.r1)] === "string" && typeof vals[addr(anchor.c, sel.r1 + 1)] === "number";
    setSheet(sortRange(sheet, { ...sel, r1: hasHeader ? sel.r1 + 1 : sel.r1 }, anchor.c, desc, vals as Record<string, unknown>));
  };
  const autoSum = () => {
    const f2 = autoSumRange(sheet, vals as Record<string, unknown>, anchor.c, anchor.r);
    if (f2) setCell(anchor, f2);
  };

  /* ── sheets ── */
  const addSheet = () => {
    const names = new Set(f.data.wb.sheets.map((s) => s.name.toLowerCase()));
    let n = f.data.wb.sheets.length + 1;
    while (names.has(`sheet${n}`)) n++;
    commit({ ...f.data, wb: { sheets: [...f.data.wb.sheets, { name: `Sheet${n}`, cells: {} }] } });
    setActive(f.data.wb.sheets.length);
  };
  const renameSheet = (i: number, name: string) => {
    const clean = name.replace(/[!'[\]]/g, "").trim().slice(0, 64);
    if (!clean || f.data.wb.sheets.some((s, k) => k !== i && s.name.toLowerCase() === clean.toLowerCase())) return;
    const old = f.data.wb.sheets[i].name;
    // Formulas elsewhere that name the old sheet follow the rename.
    const re = new RegExp(`(^|[^A-Za-z0-9_'])('?)${old.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\2!`, "g");
    const q = /^[A-Za-z_][\w.]*$/.test(clean) ? clean : `'${clean}'`;
    commit({
      ...f.data,
      wb: { sheets: f.data.wb.sheets.map((s, k) => ({ name: k === i ? clean : s.name, cells: Object.fromEntries(Object.entries(s.cells).map(([a, v]) => [a, v.startsWith("=") ? v.replace(re, (_m, pre: string) => `${pre}${q}!`) : v])) })) },
      formats: Object.fromEntries(Object.entries(f.data.formats).map(([k, v]) => [k === old ? clean : k, v])),
      colWidths: Object.fromEntries(Object.entries(f.data.colWidths).map(([k, v]) => [k === old ? clean : k, v])),
    });
  };
  const deleteSheet = (i: number) => {
    if (f.data.wb.sheets.length < 2) return;
    commit({ ...f.data, wb: { sheets: f.data.wb.sheets.filter((_, k) => k !== i) } });
    setActive(0);
  };

  /* ── display ── */
  const shown = (a: string): string => {
    const v = vals[a];
    const nf = formats[a]?.nf;
    if (typeof v === "number" && nf) return formatWithPattern(v, nf);
    return displayValue(v ?? null);
  };

  /* ── AI ── */
  const contextText = () => {
    const g = cellsToGrid(sheet.cells).slice(0, 40).map((r) => r.slice(0, 12));
    return g.map((row, r) => row.map((raw, c) => (raw ? `${addr(c, r)}=${raw.slice(0, 40)}` : "")).filter(Boolean).join("  ")).filter(Boolean).join("\n") || "(the sheet is empty)";
  };
  const aiFormula = async (request: string) => {
    const reply = await ai.run(FORMULA_SYSTEM, `${formulaPrompt(request, contextText())}\n\nThe formula goes in ${addr(anchor.c, anchor.r)}.`, { name: "sheets.formula", maxTokens: 800 });
    if (reply === null) return;
    const formula = extractFormula(reply);
    if (!formula) { ai.setError(`No formula in the reply: "${cleanReply(reply).slice(0, 120)}"`); return; }
    // Check it before it lands: a formula the engine cannot read is reported, not inserted.
    const probe = evaluateOne(f.data.wb, sheet.name, formula);
    if (isErr(probe) && (probe.error === "#NAME?" || probe.error === "#ERROR!")) { ai.setError(`The model wrote ${formula}, which this sheet cannot run (${probe.error}${probe.detail ? `: ${probe.detail}` : ""}).`); return; }
    setCell(anchor, formula);
    setAnswer(`Wrote ${formula} in ${addr(anchor.c, anchor.r)}.`);
  };
  const aiTable = async (request: string) => {
    const reply = await ai.run(TABLE_SYSTEM, request, { name: "sheets.table", maxTokens: 4000 });
    if (reply === null) return;
    const csv = extractCsv(reply);
    if (!csv) { ai.setError("The reply had no table in it."); return; }
    const block = parseCsv(csv, ",");
    setSheet(pasteBlock(sheet, block, anchor));
    setAnswer(`Inserted ${block.length} rows at ${addr(anchor.c, anchor.r)}.`);
  };
  const aiAnswer = async (question: string) => {
    const data = selectionValues();
    const body = sel.r2 > sel.r1 || sel.c2 > sel.c1 ? data.map((r) => r.join("\t")).join("\n") : cellsToGrid(Object.fromEntries(Object.keys(vals).map((a) => [a, displayValue(vals[a])]))).slice(0, 200).map((r) => r.join("\t")).join("\n");
    const reply = await ai.run("You analyse spreadsheet data. Answer plainly and briefly; quote the numbers you rely on.", `${question}\n\nData (tab-separated):\n${body.slice(0, 20_000)}`, { name: "sheets.answer", maxTokens: 1500 });
    if (reply !== null) setAnswer(cleanReply(reply));
  };
  const explain = async () => {
    const raw = sheet.cells[addr(anchor.c, anchor.r)];
    if (!raw?.startsWith("=")) { ai.setError("Select a cell with a formula."); return; }
    const reply = await ai.run("Explain spreadsheet formulas in plain language, in 2-4 sentences.", `Explain ${raw} (in ${addr(anchor.c, anchor.r)}). Nearby cells:\n${contextText()}`, { name: "sheets.explain", maxTokens: 600 });
    if (reply !== null) setAnswer(cleanReply(reply));
  };

  /* ── import / export ── */
  const importFile = async (kind: "xlsx" | "ods" | "csv") => {
    const file = await pickFile({ xlsx: ".xlsx", ods: ".ods", csv: ".csv,.tsv,.txt" }[kind]);
    if (!file) return;
    let wb: Workbook;
    if (kind === "xlsx") wb = fromXlsx(await unzipPackage(file));
    else if (kind === "ods") wb = fromOds(await unzipPackage(file));
    else wb = { sheets: [{ name: "Sheet1", cells: gridToCells(parseCsv(await file.text())) }] };
    f.createNew(parseSheetFile({ wb, formats: {}, colWidths: {} }), file.name.replace(/\.[^.]+$/, ""));
    setActive(0);
  };
  const base = f.name.replace(/[^\w .-]/g, "_") || "spreadsheet";
  const exportsMenu = [
    { id: "xlsx", label: "Excel workbook (.xlsx)", run: () => downloadPackage(`${base}.xlsx`, toXlsx(f.data.wb, values, { when: new Date().toISOString() }), MIME.xlsx) },
    { id: "ods", label: "OpenDocument spreadsheet (.ods)", run: () => downloadPackage(`${base}.ods`, toOds(f.data.wb, values, { title: f.name, when: new Date().toISOString() }), MIME.ods) },
    { id: "csv", label: `This sheet as CSV (${sheet.name})`, run: () => downloadBytes(`${base} - ${sheet.name}.csv`, toCsv(cellsToGrid(Object.fromEntries(Object.keys(sheet.cells).map((a) => [a, displayValue(vals[a] ?? null)])))), "text/csv") },
  ];
  const importsMenu = [
    { id: "xlsx", label: "Excel workbook (.xlsx)", run: () => importFile("xlsx") },
    { id: "ods", label: "OpenDocument spreadsheet (.ods)", run: () => importFile("ods") },
    { id: "csv", label: "CSV or tab-separated", run: () => importFile("csv") },
  ];

  const cur = addr(anchor.c, anchor.r);
  const barText = editing ? editing.text : sheet.cells[cur] ?? "";
  const fnHint = editing && /^=.*?([A-Z]{2,})$/i.exec(editing.text);
  const suggestions = fnHint ? FUNCTION_NAMES.filter((n) => n.startsWith(fnHint[1].toUpperCase())).slice(0, 6) : [];
  const selStats = useMemo(() => {
    let sum = 0, count = 0, n = 0;
    for (let r = sel.r1; r <= sel.r2; r++) for (let c = sel.c1; c <= sel.c2; c++) { const v = vals[addr(c, r)]; if (v !== null && v !== undefined && v !== "") count++; if (typeof v === "number") { sum += v; n++; } }
    return { sum, count, n };
  }, [sel.r1, sel.r2, sel.c1, sel.c2, vals]);

  const colLeft: number[] = [];
  { let x = HEAD_W; for (let c = 0; c < cols; c++) { colLeft.push(x); x += colW(c); } colLeft.push(x); }
  const totalW = colLeft[cols];

  return (
    <div className="flex h-full flex-col" data-office="sheets">
      <FileBar icon="sheets" name={f.name} savedAt={f.savedAt} onRename={f.rename} files={f.files} current={f.path}
        onOpen={(p) => { f.open(p); setActive(0); history.current = { undo: [], redo: [] }; }}
        onNew={() => { f.createNew(); setActive(0); history.current = { undo: [], redo: [] }; }}
        imports={importsMenu} exports={exportsMenu}
        extra={<TB label="AI assistant" icon="sparkles" active={showAi} onClick={() => setShowAi((v) => !v)} />}
      />
      <div className="os-office-toolbar flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--border)] px-2 py-1" role="toolbar" aria-label="Sheet tools">
        <TB label="Undo" text="Undo" onClick={undo} />
        <TB label="Redo" text="Redo" onClick={redo} />
        <TB label="Bold" text="B" className="font-bold" active={!!formats[cur]?.b} onClick={() => setFormat({ b: !formats[cur]?.b })} />
        <TB label="Italic" text="I" className="italic" active={!!formats[cur]?.i} onClick={() => setFormat({ i: !formats[cur]?.i })} />
        <TB label="Align left" text="Left" active={formats[cur]?.align === "left"} onClick={() => setFormat({ align: "left" })} />
        <TB label="Centre" text="Centre" active={formats[cur]?.align === "center"} onClick={() => setFormat({ align: "center" })} />
        <TB label="Align right" text="Right" active={formats[cur]?.align === "right"} onClick={() => setFormat({ align: "right" })} />
        <select className="os-input !w-auto !py-0.5 text-[11.5px]" value={formats[cur]?.nf ?? ""} onChange={(e) => setFormat({ nf: e.target.value || undefined })} aria-label="Number format">
          {NUMBER_FORMATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <span className="flex items-center gap-0.5" aria-label="Cell fill">
          {FILLS.map((c) => <button key={c || "none"} className="h-4 w-4 rounded-sm border border-white/20" style={{ background: c || "transparent" }} onClick={() => setFormat({ bg: c || undefined })} aria-label={c ? `Fill ${c}` : "No fill"} title={c || "No fill"} />)}
        </span>
        <TB label="AutoSum" text="Sum" onClick={autoSum} />
        <TB label="Sort ascending" text="Sort A-Z" onClick={() => sort(false)} />
        <TB label="Sort descending" text="Sort Z-A" onClick={() => sort(true)} />
        <TB label="Fill down" text="Fill down" onClick={() => setSheet(fill(sheet, sel, "down"))} />
        <TB label="Insert rows" text="+Row" onClick={insertRow} />
        <TB label="Delete rows" text="-Row" onClick={deleteRow} />
        <TB label="Insert columns" text="+Col" onClick={insertCol} />
        <TB label="Delete columns" text="-Col" onClick={deleteCol} />
        <TB label="Chart from selection" text="Chart" onClick={() => setChart(chartFromSelection(sel, vals))} />
      </div>
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--border)] px-2 py-1">
        <span className="w-14 shrink-0 font-mono text-[11.5px] text-[var(--muted)]" aria-label="Active cell">{cur}</span>
        <div className="relative flex-1">
          <input
            className="os-input w-full !py-0.5 font-mono text-[12px]"
            value={barText}
            aria-label="Formula bar"
            onFocus={() => { if (!editing) setEditing({ text: sheet.cells[cur] ?? "", fromBar: true }); }}
            onChange={(e) => setEditing({ text: e.target.value, fromBar: true })}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); finishEdit(0, 1); } if (e.key === "Escape") { setEditing(null); grid.current?.focus(); } }}
          />
          {suggestions.length > 0 && (
            <div className="absolute left-0 top-full z-20 mt-0.5 flex gap-1 rounded border border-[var(--border)] p-1 text-[11px]" style={{ background: "var(--panel-solid)" }}>
              {suggestions.map((s) => <button key={s} className="rounded px-1 hover:bg-[var(--hover)]" onMouseDown={(e) => e.preventDefault()} onClick={() => setEditing({ text: `${editing!.text.slice(0, editing!.text.length - fnHint![1].length)}${s}(`, fromBar: editing!.fromBar })}>{s}</button>)}
            </div>
          )}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <div className="relative min-h-0 min-w-0 flex-1">
          <div
            ref={grid}
            tabIndex={0}
            className="absolute inset-0 overflow-auto outline-none"
            onScroll={(e) => { setScrollTop(e.currentTarget.scrollTop); setViewH(e.currentTarget.clientHeight); }}
            onKeyDown={onKey}
            onPointerUp={() => { drag.current = false; }}
            role="grid"
            aria-label={`${sheet.name}, ${rows} rows`}
            aria-rowcount={rows}
            data-sheet-grid
          >
            <div style={{ width: totalW, height: (rows + 1) * ROW_H, position: "relative" }}>
              {/* column headers */}
              <div className="sticky top-0 z-10 flex" style={{ height: ROW_H, background: "var(--panel-solid)" }}>
                <div className="sticky left-0 z-10 shrink-0 border-b border-r border-[var(--border)]" style={{ width: HEAD_W, background: "var(--panel-solid)" }} />
                {Array.from({ length: cols }, (_, c) => (
                  <div key={c} className={cn("relative shrink-0 border-b border-r border-[var(--border)] text-center text-[10.5px] leading-[22px] text-[var(--muted)]", c >= sel.c1 && c <= sel.c2 && "bg-[var(--accent)]/15 text-[var(--text)]")} style={{ width: colW(c) }}
                    onPointerDown={() => { setAnchor({ c, r: 0 }); setFocus({ c, r: rows - 1 }); }}>
                    {indexToCol(c)}
                    <span
                      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        const startX = e.clientX, startW = colW(c);
                        const onMove = (ev: PointerEvent) => {
                          const w = Math.max(30, Math.min(800, startW + ev.clientX - startX));
                          f.update((d) => ({ ...d, colWidths: { ...d.colWidths, [sheet.name]: { ...(d.colWidths[sheet.name] ?? {}), [indexToCol(c)]: w } } }));
                        };
                        const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
                        window.addEventListener("pointermove", onMove);
                        window.addEventListener("pointerup", onUp);
                      }}
                      aria-hidden
                    />
                  </div>
                ))}
              </div>
              {Array.from({ length: lastRow - firstRow + 1 }, (_, k) => {
                const r = firstRow + k;
                return (
                  <div key={r} className="absolute left-0 flex" style={{ top: (r + 1) * ROW_H, height: ROW_H }} role="row" aria-rowindex={r + 1}>
                    <div className={cn("sticky left-0 z-[1] shrink-0 border-b border-r border-[var(--border)] text-center text-[10.5px] leading-[22px] text-[var(--muted)]", r >= sel.r1 && r <= sel.r2 && "bg-[var(--accent)]/15 text-[var(--text)]")} style={{ width: HEAD_W, background: "var(--panel-solid)" }}
                      onPointerDown={() => { setAnchor({ c: 0, r }); setFocus({ c: cols - 1, r }); }}>{r + 1}</div>
                    {Array.from({ length: cols }, (_, c) => {
                      const a = addr(c, r);
                      const v: Scalar | undefined = vals[a];
                      const fm = formats[a];
                      const isAnchor = c === anchor.c && r === anchor.r;
                      const inSel = inRect({ c, r }, sel);
                      const right = fm?.align ? fm.align === "right" : typeof v === "number";
                      return (
                        <div
                          key={c}
                          role="gridcell"
                          aria-selected={inSel}
                          data-cell={a}
                          className={cn("relative shrink-0 overflow-hidden whitespace-nowrap border-b border-r border-[var(--border)]/60 px-1 text-[12px] leading-[21px]", inSel && !isAnchor && "bg-[var(--accent)]/12", isAnchor && "outline outline-2 -outline-offset-2 outline-[var(--accent)]", isErr(v) && "text-[var(--danger)]")}
                          style={{ width: colW(c), textAlign: fm?.align ?? (right ? "right" : "left"), fontWeight: fm?.b ? 700 : undefined, fontStyle: fm?.i ? "italic" : undefined, background: fm?.bg, color: fm?.bg ? "#111" : fm?.color }}
                          onPointerDown={(e) => cellDown({ c, r }, e)}
                          onPointerEnter={() => { if (drag.current) setFocus({ c, r }); }}
                          onDoubleClick={() => { setAnchor({ c, r }); setFocus({ c, r }); setEditing({ text: sheet.cells[a] ?? "", fromBar: false }); }}
                          title={isErr(v) && v.detail ? v.detail : undefined}
                        >
                          {isAnchor && editing && !editing.fromBar ? (
                            <input
                              autoFocus
                              className="absolute inset-0 z-[2] w-full bg-[var(--panel-solid)] px-1 font-mono text-[12px] outline-none"
                              value={editing.text}
                              onChange={(e) => setEditing({ text: e.target.value, fromBar: false })}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") { e.preventDefault(); finishEdit(0, e.shiftKey ? -1 : 1); }
                                else if (e.key === "Tab") { e.preventDefault(); finishEdit(e.shiftKey ? -1 : 1, 0); }
                                else if (e.key === "Escape") { setEditing(null); grid.current?.focus(); }
                              }}
                              onBlur={() => finishEdit(0, 0)}
                              aria-label={`Edit ${a}`}
                            />
                          ) : shown(a)}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
          {chart && (
            <div className="absolute bottom-3 right-3 z-20 w-[min(460px,90%)] rounded-lg border border-[var(--border)] p-2 shadow-2xl" style={{ background: "var(--panel-solid)" }} data-sheet-chart>
              <div className="mb-1 flex items-center gap-1 text-[11px]">
                <span className="font-medium">Chart of {addr(sel.c1, sel.r1)}:{addr(sel.c2, sel.r2)}</span>
                <button className="os-btn ml-auto !py-0 text-[10px]" onClick={() => chart && setChart({ ...chart, kind: chart.kind === "bar" ? "line" : "bar" })}>{chart.kind === "bar" ? "Line" : "Bars"}</button>
                <button className="os-btn !py-0 text-[10px]" onClick={() => setChart(null)} aria-label="Close chart">Close</button>
              </div>
              {(() => { const p = parsePanel({ type: "chart", ...chart }); return p.ok ? <PanelView panel={p.panel} /> : <p className="text-[11px] text-[var(--muted)]">{p.reason}. Select a column of labels and one to three columns of numbers.</p>; })()}
            </div>
          )}
        </div>
        {showAi && (
          <AiPanel
            title="Sheet assistant" busy={ai.busy} error={ai.error} partial={ai.partial} provider={ai.provider} model={ai.model} onStop={ai.stop}
            placeholder={aiMode === "formula" ? `Describe the formula for ${cur}...` : aiMode === "table" ? "Describe a table to create..." : "Ask a question about the data..."}
            onFree={(t) => void (aiMode === "formula" ? aiFormula(t) : aiMode === "table" ? aiTable(t) : aiAnswer(t))}
            actions={[
              { id: "explain", label: "Explain this formula", run: () => void explain() },
              { id: "analyze", label: "Summarize the selection", run: () => void aiAnswer("Summarize what this data shows: totals, trends, outliers.") },
            ]}
          >
            <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="What the request makes">
              {([["formula", "Formula"], ["table", "Table"], ["answer", "Answer"]] as const).map(([id, l]) => (
                <button key={id} role="radio" aria-checked={aiMode === id} className="os-btn !py-0.5 text-[10.5px]" data-variant={aiMode === id ? "primary" : undefined} onClick={() => setAiMode(id)}>{l}</button>
              ))}
            </div>
            {answer && <div className="whitespace-pre-wrap rounded bg-white/5 p-1.5 text-[11.5px]" data-sheet-answer>{answer}</div>}
            <p className="text-[10.5px] leading-snug text-[var(--muted)]">Formulas are checked by the sheet before they are inserted. Tables go in at the selected cell.</p>
          </AiPanel>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-[var(--border)] px-2 py-0.5 text-[11px]">
        {f.data.wb.sheets.map((s, i) => renaming === i ? (
          <input key={i} autoFocus defaultValue={s.name} className="os-input !w-28 !py-0 text-[11px]" aria-label="Sheet name"
            onBlur={(e) => { renameSheet(i, e.target.value); setRenaming(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setRenaming(null); }} />
        ) : (
          <button key={i} className={cn("rounded px-2 py-0.5", i === active ? "bg-[var(--accent)]/20 font-medium" : "hover:bg-[var(--hover)]")} onClick={() => setActive(i)} onDoubleClick={() => setRenaming(i)} title="Double-click to rename">{s.name}</button>
        ))}
        <TB label="Add sheet" icon="plus" onClick={addSheet} />
        {f.data.wb.sheets.length > 1 && <TB label={`Delete ${sheet.name}`} icon="trash" onClick={() => deleteSheet(active)} />}
        <span className="ml-auto shrink-0 text-[var(--muted)]" data-sheet-stats>{selStats.n ? `Sum ${stat(selStats.sum)}  Average ${stat(selStats.sum / selStats.n)}  ` : ""}Count {selStats.count}</span>
      </div>
    </div>
  );
}

const stat = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

/** A chart panel spec from the selection: first column labels, the rest series (header row names them). */
function chartFromSelection(sel: Rect, vals: Record<string, Scalar>) {
  const header = sel.r2 > sel.r1 && sel.c2 > sel.c1 && typeof vals[addr(sel.c1 + 1, sel.r1)] === "string";
  const r0 = header ? sel.r1 + 1 : sel.r1;
  const labels: string[] = [];
  for (let r = r0; r <= sel.r2 && labels.length < 24; r++) labels.push(displayValue(vals[addr(sel.c1, r)] ?? null) || String(r + 1));
  const series = [];
  for (let c = sel.c1 + (sel.c2 > sel.c1 ? 1 : 0); c <= sel.c2 && series.length < 3; c++) {
    series.push({ name: header ? displayValue(vals[addr(c, sel.r1)] ?? null) : indexToCol(c), values: labels.map((_, i) => { const v = vals[addr(c, r0 + i)]; return typeof v === "number" ? v : null; }) });
  }
  return { kind: "bar" as "bar" | "line", title: "", unit: "", labels, series };
}
