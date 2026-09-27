/* ────────────────────────────────────────────────────────────────────────────
   Calc's files: .xlsx, .ods and .csv, in and out, formulas kept.

   A workbook's cells hold what the person typed ("=SUM(A1:A3)", "12%", text);
   the evaluated values travel alongside as the cached results every
   spreadsheet stores, so a file opened in Excel or LibreOffice shows numbers
   before it recalculates.

   Formulas are translated, not re-typed: OpenDocument writes references as
   [.A1] and [$Sheet2.A1:.B3] with ";" between arguments, which is converted
   through the same tokenizer the engine uses (lib/office/formula.ts), so text
   inside quotes is never touched.

   PURE.
   ──────────────────────────────────────────────────────────────────────────── */

import { escapeXml, parseXml, all, kids, child, attr, textOf, local } from "./xml";
import { tokenize, parseAddr, addr, isErr, shiftFormula, type Workbook, type Scalar } from "./formula";
import { odfManifest, odfMeta, ODF_NS } from "./doc";
import type { ZipEntry } from "../zip";

type Files = Map<string, string | Uint8Array>;
const str = (files: Files, p: string) => { const v = files.get(p); return v === undefined ? "" : typeof v === "string" ? v : new TextDecoder().decode(v); };

/* ── CSV ─────────────────────────────────────────────────────────────────── */

export function detectDelimiter(text: string): string {
  const first = text.split(/\r?\n/).slice(0, 5).join("\n");
  const count = (d: string) => first.split("\n").map((l) => l.split(d).length - 1);
  let best = ",", bestScore = -1;
  for (const d of [",", ";", "\t", "|"]) {
    const c = count(d);
    // Consistent across lines beats merely frequent.
    const score = c[0] > 0 && c.every((x) => x === c[0]) ? 1000 + c[0] : Math.max(...c);
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}

export function parseCsv(text: string, delimiter = detectDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", q = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
      continue;
    }
    if (c === '"' && field === "") q = true;
    else if (c === delimiter) { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function toCsv(grid: string[][], delimiter = ","): string {
  const cell = (v: string) => (/[",\n\r]/.test(v) || v.includes(delimiter) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return grid.map((r) => r.map(cell).join(delimiter)).join("\r\n") + "\r\n";
}

/** Cells as a dense grid of raw input, trimmed to the used area. */
export function cellsToGrid(cells: Record<string, string>): string[][] {
  let maxR = -1, maxC = -1;
  for (const a of Object.keys(cells)) { const p = parseAddr(a); if (p && cells[a] !== "") { maxR = Math.max(maxR, p.r); maxC = Math.max(maxC, p.c); } }
  const grid = Array.from({ length: maxR + 1 }, () => Array.from({ length: maxC + 1 }, () => ""));
  for (const [a, v] of Object.entries(cells)) { const p = parseAddr(a); if (p && p.r <= maxR && p.c <= maxC) grid[p.r][p.c] = v; }
  return grid;
}

export function gridToCells(grid: string[][]): Record<string, string> {
  const out: Record<string, string> = {};
  grid.forEach((row, r) => row.forEach((v, c) => { if (v !== "") out[addr(c, r)] = v; }));
  return out;
}

/* ── formula dialects ────────────────────────────────────────────────────── */

/** "=SUM(A1:B2, Data!C3)" -> "of:=SUM([.A1:.B2]; [$Data.C3])" */
export function toOdfFormula(f: string): string {
  const body = f.replace(/^=/, "");
  let toks;
  try { toks = tokenize(body); } catch { return `of:=${body}`; }
  let out = "", last = 0;
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.t === "," ) { out += body.slice(last, t.s) + ";"; last = t.e; continue; }
    if (t.t !== "ref") continue;
    const sheet = t.sheet ? `$${/^[A-Za-z_][\w.]*$/.test(t.sheet) ? t.sheet : `'${t.sheet.replace(/'/g, "''")}'`}` : "";
    const nx = toks[k + 1], nr = toks[k + 2];
    if (nx?.t === ":" && nr?.t === "ref") {
      out += body.slice(last, t.s) + `[${sheet}.${t.ref}:.${nr.ref}]`;
      last = nr.e;
      k += 2;
      continue;
    }
    out += body.slice(last, t.s) + `[${sheet}.${t.ref}]`;
    last = t.e;
  }
  return `of:=${out}${body.slice(last)}`;
}

/** The inverse, for .ods import: "of:=SUM([.A1:.B2];[$Data.C3])" -> "=SUM(A1:B2,Data!C3)" */
export function fromOdfFormula(f: string): string {
  let s = f.replace(/^(of:|oooc:)?=?/, "");
  // Outside quoted strings only.
  s = s.split(/("(?:[^"]|"")*")/).map((part, i) => {
    if (i % 2) return part;
    return part
      .replace(/\[\$?('(?:[^']|'')+'|[^.\]:]*)?\.(\$?[A-Z]+\$?\d+)(?::\$?('(?:[^']|'')+'|[^.\]]*)?\.(\$?[A-Z]+\$?\d+))?\]/g, (_m, sh: string | undefined, a: string, _sh2: string | undefined, b: string | undefined) => {
        const sheet = sh ? `${sh.startsWith("'") ? sh : /^[A-Za-z_][\w.]*$/.test(sh) ? sh : `'${sh}'`}!` : "";
        return b ? `${sheet}${a}:${b}` : `${sheet}${a}`;
      })
      .replace(/;/g, ",");
  }).join("");
  return `=${s}`;
}

/* ── .xlsx ───────────────────────────────────────────────────────────────── */

export function toXlsx(wb: Workbook, values: Record<string, Record<string, Scalar>>, opts: { when?: string } = {}): ZipEntry[] {
  const sheetXml = (cells: Record<string, string>, vals: Record<string, Scalar>) => {
    const rows = new Map<number, string[]>();
    const order = Object.keys(cells).map((a) => ({ a, p: parseAddr(a)! })).filter((x) => x.p && cells[x.a] !== "").sort((x, y) => x.p.r - y.p.r || x.p.c - y.p.c);
    for (const { a, p } of order) {
      const raw = cells[a];
      const v = vals[a];
      let xml: string;
      if (raw.startsWith("=")) {
        const f = `<f>${escapeXml(raw.slice(1))}</f>`;
        if (typeof v === "number") xml = `<c r="${a}">${f}<v>${v}</v></c>`;
        else if (typeof v === "boolean") xml = `<c r="${a}" t="b">${f}<v>${v ? 1 : 0}</v></c>`;
        else if (isErr(v)) xml = `<c r="${a}" t="e">${f}<v>${escapeXml(v.error === "#CYCLE!" ? "#REF!" : v.error)}</v></c>`;
        else xml = `<c r="${a}" t="str">${f}<v>${escapeXml(v === null ? "" : String(v))}</v></c>`;
      } else if (typeof v === "number") xml = `<c r="${a}"${/%$/.test(raw.trim()) ? ` s="1"` : ""}><v>${v}</v></c>`;
      else if (typeof v === "boolean") xml = `<c r="${a}" t="b"><v>${v ? 1 : 0}</v></c>`;
      else xml = `<c r="${a}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(raw)}</t></is></c>`;
      if (!rows.has(p.r)) rows.set(p.r, []);
      rows.get(p.r)!.push(xml);
    }
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData>${[...rows.entries()].map(([r, cs]) => `<row r="${r + 1}">${cs.join("")}</row>`).join("")}</sheetData></worksheet>`;
  };
  const sheets = wb.sheets.map((s, i) => ({ name: s.name.slice(0, 31).replace(/[\\/?*[\]:]/g, "_"), path: `xl/worksheets/sheet${i + 1}.xml`, xml: sheetXml(s.cells, values[s.name] ?? {}) }));
  return [
    { path: "[Content_Types].xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((s) => `<Override PartName="/${s.path}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>` },
    { path: "_rels/.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>` },
    { path: "docProps/core.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>Web-AIOS Calc</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${opts.when ?? "2026-01-01T00:00:00Z"}</dcterms:created></cp:coreProperties>` },
    { path: "xl/workbook.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets><calcPr fullCalcOnLoad="1"/></workbook>` },
    { path: "xl/_rels/workbook.xml.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { path: "xl/styles.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>` },
    ...sheets.map((s) => ({ path: s.path, content: s.xml })),
  ];
}

export function fromXlsx(files: Files): Workbook {
  const wbXml = parseXml(str(files, "xl/workbook.xml"));
  const rels = new Map(all(parseXml(str(files, "xl/_rels/workbook.xml.rels")), "Relationship").map((r) => [attr(r, "Id") ?? "", attr(r, "Target") ?? ""]));
  const shared = all(parseXml(str(files, "xl/sharedStrings.xml")), "si").map((si) => all(si, "t").map(textOf).join(""));
  const sheets = all(wbXml, "sheet").map((sh, i) => {
    const target = rels.get(attr(sh, "id") ?? "") ?? `worksheets/sheet${i + 1}.xml`;
    const path = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
    const doc = parseXml(str(files, path));
    const cells: Record<string, string> = {};
    const sharedF = new Map<string, { a: string; f: string }>();
    for (const c of all(doc, "c")) {
      const a = attr(c, "r");
      if (!a || !parseAddr(a)) continue;
      const t = attr(c, "t");
      const f = child(c, "f");
      if (f) {
        const si = attr(f, "si");
        const ftext = textOf(f);
        if (ftext) { cells[a] = `=${ftext}`; if (si !== undefined) sharedF.set(si, { a, f: `=${ftext}` }); }
        else if (si !== undefined && sharedF.has(si)) {
          // A shared formula: the master's formula, shifted to this cell.
          const m = sharedF.get(si)!, from = parseAddr(m.a)!, to = parseAddr(a)!;
          cells[a] = shiftFormula(m.f, to.r - from.r, to.c - from.c);
        }
        continue;
      }
      const v = child(c, "v");
      if (t === "s") cells[a] = shared[Number(v ? textOf(v) : -1)] ?? "";
      else if (t === "inlineStr") cells[a] = all(c, "t").map(textOf).join("");
      else if (t === "b") cells[a] = v && textOf(v) === "1" ? "TRUE" : "FALSE";
      else if (t === "str" || t === "e") cells[a] = v ? textOf(v) : "";
      else if (v) cells[a] = textOf(v);
    }
    return { name: attr(sh, "name") ?? `Sheet${i + 1}`, cells };
  });
  return { sheets: sheets.length ? sheets : [{ name: "Sheet1", cells: {} }] };
}

/* ── .ods ────────────────────────────────────────────────────────────────── */

export function toOds(wb: Workbook, values: Record<string, Record<string, Scalar>>, opts: { title?: string; when?: string } = {}): ZipEntry[] {
  const tables = wb.sheets.map((s) => {
    const grid = cellsToGrid(s.cells);
    const vals = values[s.name] ?? {};
    const rows = grid.map((row, r) => `<table:table-row>${row.map((raw, c) => {
      if (raw === "") return `<table:table-cell/>`;
      const v = vals[addr(c, r)];
      const f = raw.startsWith("=") ? ` table:formula="${escapeXml(toOdfFormula(raw))}"` : "";
      if (typeof v === "number") return `<table:table-cell${f} office:value-type="${/%$/.test(raw.trim()) ? "percentage" : "float"}" office:value="${v}"><text:p>${v}</text:p></table:table-cell>`;
      if (typeof v === "boolean") return `<table:table-cell${f} office:value-type="boolean" office:boolean-value="${v}"><text:p>${v ? "TRUE" : "FALSE"}</text:p></table:table-cell>`;
      const text = isErr(v) ? v.error : v === null ? "" : String(v);
      return `<table:table-cell${f} office:value-type="string"><text:p>${escapeXml(text)}</text:p></table:table-cell>`;
    }).join("")}</table:table-row>`).join("");
    const width = Math.max(1, grid[0]?.length ?? 1);
    return `<table:table table:name="${escapeXml(s.name)}"><table:table-column table:number-columns-repeated="${width}"/>${rows || "<table:table-row><table:table-cell/></table:table-row>"}</table:table>`;
  });
  const content = `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${ODF_NS}><office:body><office:spreadsheet>${tables.join("")}</office:spreadsheet></office:body></office:document-content>`;
  const mime = "application/vnd.oasis.opendocument.spreadsheet";
  return [
    { path: "mimetype", content: mime },
    { path: "META-INF/manifest.xml", content: odfManifest(mime, [{ path: "content.xml", type: "text/xml" }, { path: "styles.xml", type: "text/xml" }, { path: "meta.xml", type: "text/xml" }]) },
    { path: "content.xml", content },
    { path: "styles.xml", content: `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${ODF_NS}><office:styles/></office:document-styles>` },
    { path: "meta.xml", content: odfMeta(opts.title ?? "Spreadsheet", opts.when ?? "2026-01-01T00:00:00Z") },
  ];
}

const MAX_REPEAT = 1000;

export function fromOds(files: Files): Workbook {
  const content = parseXml(str(files, "content.xml"));
  const sheets = all(content, "table").filter((t) => t.name === "table:table" || local(t.name) === "table").map((tbl, i) => {
    const cells: Record<string, string> = {};
    let r = 0;
    for (const row of kids(tbl).filter((k) => local(k.name) === "table-row" || local(k.name) === "table-rows" || local(k.name) === "table-header-rows").flatMap((k) => (local(k.name) === "table-row" ? [k] : kids(k, "table-row")))) {
      const rowRep = Math.min(MAX_REPEAT, Number(attr(row, "number-rows-repeated") ?? 1));
      const rowCells: Array<[number, string]> = [];
      let c = 0;
      for (const cell of kids(row).filter((k) => /^(covered-)?table-cell$/.test(local(k.name)))) {
        const rep = Math.min(MAX_REPEAT, Number(attr(cell, "number-columns-repeated") ?? 1));
        const f = attr(cell, "formula");
        const type = attr(cell, "value-type");
        let raw = "";
        if (f) raw = fromOdfFormula(f);
        else if (type === "float" || type === "currency") raw = attr(cell, "value") ?? "";
        else if (type === "percentage") raw = `${Number((Number(attr(cell, "value") ?? 0) * 100).toPrecision(12))}%`;
        else if (type === "boolean") raw = attr(cell, "boolean-value") === "true" ? "TRUE" : "FALSE";
        else raw = kids(cell, "p").map(textOf).join("\n");
        if (raw !== "") for (let k = 0; k < rep; k++) rowCells.push([c + k, raw]);
        c += rep;
      }
      for (let k = 0; k < rowRep; k++) for (const [cc, raw] of rowCells) cells[addr(cc, r + k)] = raw;
      r += rowRep;
    }
    return { name: attr(tbl, "name") ?? `Sheet${i + 1}`, cells };
  });
  return { sheets: sheets.length ? sheets : [{ name: "Sheet1", cells: {} }] };
}
