/* ────────────────────────────────────────────────────────────────────────────
   Writer's document model, and its trips in and out of real formats.

   One small block model sits between the editor and every format, so each
   format is written once and every pair converts through it:

     editor HTML  -> Doc  (in the app, with the browser's DOM)
     Markdown     <-> Doc
     .docx        <-> Doc (Office Open XML, WordprocessingML)
     .odt          <-> Doc (OpenDocument text, LibreOffice's own format)
     HTML          <-  Doc (clean, standalone, for export and print)

   Kept deliberately to what a person writes -- headings, paragraphs with
   alignment, bold/italic/underline/strike/code/links/colour, lists (nested by
   level), quotes, code blocks, tables, images, rules and page breaks -- so
   every construct round-trips instead of half the features being lossy.

   PURE. Zip entries are returned for lib/zip.ts; importers take the unzipped
   parts, so tests run without a browser.
   ──────────────────────────────────────────────────────────────────────────── */

import { escapeXml, parseXml, all, kids, child, attr, textOf, local, type XNode } from "./xml";
import type { ZipEntry } from "../zip";

export interface Run {
  text: string;
  b?: boolean;
  i?: boolean;
  u?: boolean;
  s?: boolean;
  code?: boolean;
  href?: string;
  /** #rrggbb */
  color?: string;
}

export type Align = "left" | "center" | "right" | "justify";
export interface ListItem { runs: Run[]; level: number }

export type Block =
  | { t: "h"; level: 1 | 2 | 3 | 4; runs: Run[]; align?: Align }
  | { t: "p"; runs: Run[]; align?: Align }
  | { t: "quote"; runs: Run[] }
  | { t: "code"; text: string }
  | { t: "list"; ordered: boolean; items: ListItem[] }
  | { t: "table"; rows: Run[][][] }
  | { t: "img"; src: string; alt: string; w?: number; h?: number }
  | { t: "hr" }
  | { t: "pagebreak" };

export interface Doc {
  title: string;
  blocks: Block[];
}

export const plain = (runs: Run[]): string => runs.map((r) => r.text).join("");

export function docText(doc: Doc): string {
  return doc.blocks
    .map((b) => {
      switch (b.t) {
        case "h": case "p": case "quote": return plain(b.runs);
        case "code": return b.text;
        case "list": return b.items.map((it) => plain(it.runs)).join("\n");
        case "table": return b.rows.map((r) => r.map(plain).join("\t")).join("\n");
        case "img": return b.alt;
        default: return "";
      }
    })
    .filter(Boolean)
    .join("\n\n");
}

export function wordCount(doc: Doc): { words: number; chars: number } {
  const t = docText(doc);
  const words = t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  return { words, chars: t.replace(/\s/g, "").length };
}

/* ── base64 (images travel as data: URLs) ────────────────────────────────── */

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=") + (i + 2 < bytes.length ? B64[n & 63] : "=");
  }
  return s;
}

export function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = (B64.indexOf(clean[i]) << 18) | (B64.indexOf(clean[i + 1]) << 12) | ((B64.indexOf(clean[i + 2]) & 63) << 6) | (B64.indexOf(clean[i + 3]) & 63);
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length && clean[i + 2] !== undefined) out[o++] = (n >> 8) & 255;
    if (o < out.length && clean[i + 3] !== undefined) out[o++] = n & 255;
  }
  return out;
}

export function parseDataUrl(src: string): { mime: string; bytes: Uint8Array } | null {
  const m = /^data:(image\/(?:png|jpeg|gif|webp|svg\+xml));base64,(.*)$/s.exec(src);
  return m ? { mime: m[1], bytes: fromBase64(m[2]) } : null;
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpeg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg" };

/* ── Markdown ────────────────────────────────────────────────────────────── */

function mdInline(runs: Run[]): string {
  return runs
    .map((r) => {
      let t = r.code ? `\`${r.text}\`` : r.text.replace(/([\\*_`[\]~])/g, "\\$1");
      if (!r.code) {
        if (r.b) t = `**${t}**`;
        if (r.i) t = `*${t}*`;
        if (r.s) t = `~~${t}~~`;
      }
      if (r.href) t = `[${t}](${r.href})`;
      return t;
    })
    .join("");
}

export function toMarkdown(doc: Doc): string {
  const out: string[] = [];
  for (const b of doc.blocks) {
    switch (b.t) {
      case "h": out.push(`${"#".repeat(b.level)} ${mdInline(b.runs)}`); break;
      case "p": out.push(mdInline(b.runs)); break;
      case "quote": out.push(`> ${mdInline(b.runs)}`); break;
      case "code": out.push("```\n" + b.text + "\n```"); break;
      case "list": out.push(b.items.map((it, i) => `${"  ".repeat(it.level)}${b.ordered ? `${i + 1}.` : "-"} ${mdInline(it.runs)}`).join("\n")); break;
      case "table": {
        if (!b.rows.length) break;
        const w = Math.max(...b.rows.map((r) => r.length));
        const row = (r: Run[][]) => `| ${Array.from({ length: w }, (_, j) => mdInline(r[j] ?? []).replace(/\|/g, "\\|")).join(" | ")} |`;
        out.push([row(b.rows[0]), `|${" --- |".repeat(w)}`, ...b.rows.slice(1).map(row)].join("\n"));
        break;
      }
      case "img": out.push(`![${b.alt}](${b.src.startsWith("data:") ? "embedded-image" : b.src})`); break;
      case "hr": out.push("---"); break;
      case "pagebreak": out.push("<div style=\"page-break-after: always\"></div>"); break;
    }
  }
  return out.join("\n\n") + "\n";
}

/** Inline Markdown: **bold**, *italic* or _italic_, ~~strike~~, `code`, [text](url), backslash escapes. */
export function parseInline(src: string): Run[] {
  const runs: Run[] = [];
  const push = (text: string, fmt: Omit<Run, "text">) => {
    if (!text) return;
    const last = runs[runs.length - 1];
    if (last && JSON.stringify({ ...last, text: "" }) === JSON.stringify({ ...fmt, text: "" })) last.text += text;
    else runs.push({ text, ...fmt });
  };
  const walk = (s: string, fmt: Omit<Run, "text">) => {
    let i = 0, buf = "";
    const flush = () => { push(buf, fmt); buf = ""; };
    while (i < s.length) {
      const rest = s.slice(i);
      if (s[i] === "\\" && i + 1 < s.length) { buf += s[i + 1]; i += 2; continue; }
      let m: RegExpExecArray | null;
      if ((m = /^`([^`]+)`/.exec(rest))) { flush(); push(m[1], { ...fmt, code: true }); i += m[0].length; continue; }
      if ((m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest))) { flush(); walk(m[1], { ...fmt, href: m[2] }); i += m[0].length; continue; }
      if (rest.startsWith("**") && (m = closeStrong(rest))) { flush(); walk(m[1], { ...fmt, b: true }); i += m[0].length; continue; }
      if ((m = /^__(.+?)__/.exec(rest))) { flush(); walk(m[1], { ...fmt, b: true }); i += m[0].length; continue; }
      if ((m = /^~~(.+?)~~/.exec(rest))) { flush(); walk(m[1], { ...fmt, s: true }); i += m[0].length; continue; }
      if ((m = /^\*(?!\s)(.+?)\*/.exec(rest)) || (m = /^_(?!\s)(.+?)_(?![A-Za-z0-9])/.exec(rest))) { flush(); walk(m[1], { ...fmt, i: true }); i += m[0].length; continue; }
      buf += s[i++];
    }
    flush();
  };
  walk(src, {});
  return runs;
}

/** "**...**" whose inside has balanced single asterisks, so "**a *b***" is
 *  bold around an italic rather than bold stopping at the first "**". */
function closeStrong(rest: string): RegExpExecArray | null {
  for (let k = rest.indexOf("**", 3); k > 0; k = rest.indexOf("**", k + 1)) {
    const inner = rest.slice(2, k);
    if (!inner.trim()) continue;
    const stars = (inner.replace(/\\\*/g, "").match(/\*/g) ?? []).length;
    if (stars % 2 === 0) {
      const m = [rest.slice(0, k + 2), inner] as unknown as RegExpExecArray;
      return m;
    }
  }
  return null;
}

export function fromMarkdown(md: string, title = "Untitled"): Doc {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flushPara = () => { if (para.length) { blocks.push({ t: "p", runs: parseInline(para.join(" ")) }); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    if (/^```/.test(line)) {
      flushPara();
      const body: string[] = [];
      while (++i < lines.length && !/^```/.test(lines[i])) body.push(lines[i]);
      blocks.push({ t: "code", text: body.join("\n") });
      continue;
    }
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) { flushPara(); blocks.push({ t: "h", level: Math.min(4, m[1].length) as 1 | 2 | 3 | 4, runs: parseInline(m[2].trim()) }); continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushPara(); blocks.push({ t: "hr" }); continue; }
    if ((m = /^>\s?(.*)$/.exec(line))) { flushPara(); blocks.push({ t: "quote", runs: parseInline(m[1]) }); continue; }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flushPara();
      const ordered = /^\s*\d+[.)]/.test(line);
      const items: ListItem[] = [];
      while (i < lines.length && (m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]))) {
        items.push({ level: Math.min(4, Math.floor(m[1].replace(/\t/g, "  ").length / 2)), runs: parseInline(m[3]) });
        i++;
      }
      i--;
      blocks.push({ t: "list", ordered, items });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? "")) {
      flushPara();
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => parseInline(c.trim().replace(/\\\|/g, "|")));
      const rows = [cells(line)];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      i--;
      blocks.push({ t: "table", rows });
      continue;
    }
    if (!line.trim()) { flushPara(); continue; }
    para.push(line.trim());
  }
  flushPara();
  return { title, blocks };
}

/* ── HTML (export) ───────────────────────────────────────────────────────── */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const safeHref = (h: string) => (/^(https?:|mailto:|#)/i.test(h) ? h : "#");

function htmlRuns(runs: Run[]): string {
  return runs
    .map((r) => {
      let t = esc(r.text).replace(/\n/g, "<br>");
      if (r.code) t = `<code>${t}</code>`;
      if (r.b) t = `<strong>${t}</strong>`;
      if (r.i) t = `<em>${t}</em>`;
      if (r.u) t = `<u>${t}</u>`;
      if (r.s) t = `<s>${t}</s>`;
      if (r.color && /^#[0-9a-f]{6}$/i.test(r.color)) t = `<span style="color:${r.color}">${t}</span>`;
      if (r.href) t = `<a href="${esc(safeHref(r.href))}">${t}</a>`;
      return t;
    })
    .join("");
}

export function toHtml(doc: Doc, opts: { standalone?: boolean } = {}): string {
  const al = (a?: Align) => (a && a !== "left" ? ` style="text-align:${a}"` : "");
  const body = doc.blocks
    .map((b) => {
      switch (b.t) {
        case "h": return `<h${b.level}${al(b.align)}>${htmlRuns(b.runs)}</h${b.level}>`;
        case "p": return `<p${al(b.align)}>${htmlRuns(b.runs) || "<br>"}</p>`;
        case "quote": return `<blockquote>${htmlRuns(b.runs)}</blockquote>`;
        case "code": return `<pre><code>${esc(b.text)}</code></pre>`;
        case "list": {
          const tag = b.ordered ? "ol" : "ul";
          return `<${tag}>${b.items.map((it) => `<li style="margin-left:${it.level * 1.5}em">${htmlRuns(it.runs)}</li>`).join("")}</${tag}>`;
        }
        case "table": return `<table>${b.rows.map((r, i) => `<tr>${r.map((c) => `<${i ? "td" : "th"}>${htmlRuns(c)}</${i ? "td" : "th"}>`).join("")}</tr>`).join("")}</table>`;
        case "img": return /^data:image\/(png|jpeg|gif|webp);base64,/.test(b.src) || /^https?:/.test(b.src) ? `<p><img src="${esc(b.src)}" alt="${esc(b.alt)}"${b.w ? ` width="${b.w}"` : ""}></p>` : "";
        case "hr": return "<hr>";
        case "pagebreak": return `<div style="page-break-after:always"></div>`;
      }
    })
    .join("\n");
  if (!opts.standalone) return body;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(doc.title)}</title><style>body{font:16px/1.6 Georgia,serif;max-width:46em;margin:3em auto;padding:0 1em;color:#1a1a1a}h1,h2,h3,h4{font-family:system-ui,sans-serif;line-height:1.25}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:.3em .6em}blockquote{border-left:3px solid #ccc;margin-left:0;padding-left:1em;color:#555}pre{background:#f4f4f4;padding:1em;overflow:auto}img{max-width:100%}</style></head><body>\n${body}\n</body></html>`;
}

/* ── .docx (WordprocessingML) ────────────────────────────────────────────── */

const W_NS = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"`;

export function toDocx(doc: Doc, opts: { when?: string } = {}): ZipEntry[] {
  const rels: string[] = [
    `<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
    `<Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>`,
  ];
  const media: ZipEntry[] = [];
  const mediaTypes = new Set<string>();
  let relN = 0;

  const runXml = (r: Run) => {
    const pr = [
      r.b ? "<w:b/>" : "", r.i ? "<w:i/>" : "", r.u || r.href ? `<w:u w:val="single"/>` : "", r.s ? "<w:strike/>" : "",
      r.code ? `<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>` : "",
      r.href ? `<w:color w:val="0563C1"/>` : r.color && /^#[0-9a-f]{6}$/i.test(r.color) ? `<w:color w:val="${r.color.slice(1).toUpperCase()}"/>` : "",
    ].join("");
    const parts = r.text.split("\n").map((t) => `<w:t xml:space="preserve">${escapeXml(t)}</w:t>`).join("<w:br/>");
    const run = `<w:r>${pr ? `<w:rPr>${pr}</w:rPr>` : ""}${parts}</w:r>`;
    if (!r.href) return run;
    const id = `rIdL${++relN}`;
    rels.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXml(r.href)}" TargetMode="External"/>`);
    return `<w:hyperlink r:id="${id}">${run}</w:hyperlink>`;
  };
  const jc = (a?: Align) => (a && a !== "left" ? `<w:jc w:val="${a === "justify" ? "both" : a}"/>` : "");
  const para = (style: string | null, runs: Run[], extra = "") =>
    `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${extra}</w:pPr>${runs.map(runXml).join("")}</w:p>`;

  const body: string[] = [];
  let imgN = 0;
  for (const b of doc.blocks) {
    switch (b.t) {
      case "h": body.push(para(`Heading${b.level}`, b.runs, jc(b.align))); break;
      case "p": body.push(para(null, b.runs, jc(b.align))); break;
      case "quote": body.push(para("Quote", b.runs)); break;
      case "code": body.push(...b.text.split("\n").map((l) => para("Code", [{ text: l, code: true }]))); break;
      case "list": for (const it of b.items) body.push(para("ListParagraph", it.runs, `<w:numPr><w:ilvl w:val="${Math.min(8, it.level)}"/><w:numId w:val="${b.ordered ? 2 : 1}"/></w:numPr>`)); break;
      case "table": {
        const w = Math.max(1, ...b.rows.map((r) => r.length));
        body.push(`<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map((e) => `<w:${e} w:val="single" w:sz="4" w:space="0" w:color="999999"/>`).join("")}</w:tblBorders></w:tblPr><w:tblGrid>${`<w:gridCol w:w="${Math.floor(9000 / w)}"/>`.repeat(w)}</w:tblGrid>${b.rows
          .map((r, ri) => `<w:tr>${Array.from({ length: w }, (_, j) => `<w:tc><w:tcPr><w:tcW w:w="${Math.floor(9000 / w)}" w:type="dxa"/></w:tcPr>${para(null, (r[j] ?? []).map((x) => (ri === 0 ? { ...x, b: true } : x)))}</w:tc>`).join("")}</w:tr>`)
          .join("")}</w:tbl>`);
        break;
      }
      case "img": {
        const d = parseDataUrl(b.src);
        if (!d || d.mime === "image/svg+xml" || d.mime === "image/webp") { body.push(para(null, [{ text: `[image: ${b.alt}]`, i: true }])); break; }
        const n = ++imgN, ext = EXT[d.mime], id = `rIdImg${n}`;
        media.push({ path: `word/media/image${n}.${ext}`, content: d.bytes });
        mediaTypes.add(ext);
        rels.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${n}.${ext}"/>`);
        const wPx = Math.min(600, b.w ?? 480), hPx = b.h ?? Math.round(wPx * 0.66);
        const cx = wPx * 9525, cy = hPx * 9525;
        body.push(`<w:p><w:r><w:drawing><wp:inline><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="Image ${n}" descr="${escapeXml(b.alt)}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${n}" name="image${n}.${ext}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`);
        break;
      }
      case "hr": body.push(`<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="999999"/></w:pBdr></w:pPr></w:p>`); break;
      case "pagebreak": body.push(`<w:p><w:r><w:br w:type="page"/></w:r></w:p>`); break;
    }
  }

  const heading = (lvl: number, size: number) => `<w:style w:type="paragraph" w:styleId="Heading${lvl}"><w:name w:val="heading ${lvl}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="${lvl - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W_NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>${heading(1, 36)}${heading(2, 30)}${heading(3, 26)}${heading(4, 24)}<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/></w:pPr><w:rPr><w:i/><w:color w:val="555555"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="40"/></w:pPr></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/></w:style></w:styles>`;
  const lvls = (ordered: boolean) =>
    Array.from({ length: 9 }, (_, l) => `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="${ordered ? (l % 3 === 1 ? "lowerLetter" : l % 3 === 2 ? "lowerRoman" : "decimal") : "bullet"}"/><w:lvlText w:val="${ordered ? `%${l + 1}.` : l % 2 ? "◦" : "•"}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (l + 1)}" w:hanging="360"/></w:pPr></w:lvl>`).join("");
  const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${W_NS}><w:abstractNum w:abstractNumId="0">${lvls(false)}</w:abstractNum><w:abstractNum w:abstractNumId="1">${lvls(true)}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
  const when = opts.when ?? "2026-01-01T00:00:00Z";

  return [
    { path: "[Content_Types].xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${[...mediaTypes].map((e) => `<Default Extension="${e}" ContentType="image/${e}"/>`).join("")}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>` },
    { path: "_rels/.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>` },
    { path: "docProps/core.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(doc.title)}</dc:title><dc:creator>Web-AIOS Writer</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${when}</dcterms:created></cp:coreProperties>` },
    { path: "word/document.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W_NS}><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>` },
    { path: "word/styles.xml", content: styles },
    { path: "word/numbering.xml", content: numbering },
    { path: "word/_rels/document.xml.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>` },
    ...media,
  ];
}

/** Read the parts of an unzipped .docx. */
export function fromDocx(files: Map<string, string | Uint8Array>, title = "Imported document"): Doc {
  const text = (p: string) => { const v = files.get(p); return v === undefined ? "" : typeof v === "string" ? v : new TextDecoder().decode(v); };
  const docXml = text("word/document.xml");
  if (!docXml) throw new Error("This .docx has no word/document.xml.");
  const relMap = new Map<string, string>();
  for (const r of all(parseXml(text("word/_rels/document.xml.rels")), "Relationship")) relMap.set(attr(r, "Id") ?? "", attr(r, "Target") ?? "");

  // Which numIds are ordered, from numbering.xml (level 0's format decides).
  const orderedNum = new Set<string>();
  const numXml = parseXml(text("word/numbering.xml"));
  const absOrdered = new Map<string, boolean>();
  for (const an of all(numXml, "abstractNum")) {
    const lvl0 = kids(an, "lvl").find((l) => attr(l, "ilvl") === "0") ?? kids(an, "lvl")[0];
    const fmt = lvl0 ? attr(child(lvl0, "numFmt") ?? { name: "", attrs: {}, children: [] }, "val") : undefined;
    absOrdered.set(attr(an, "abstractNumId") ?? "", !!fmt && fmt !== "bullet" && fmt !== "none");
  }
  for (const n of all(numXml, "num")) {
    const abs = attr(child(n, "abstractNumId") ?? { name: "", attrs: {}, children: [] }, "val") ?? "";
    if (absOrdered.get(abs)) orderedNum.add(attr(n, "numId") ?? "");
  }

  const runsOf = (p: XNode): Run[] => {
    const out: Run[] = [];
    const visit = (n: XNode, href?: string) => {
      for (const c of kids(n)) {
        const ln = local(c.name);
        if (ln === "hyperlink") { const id = attr(c, "id"); visit(c, id ? relMap.get(id) : href); continue; }
        if (ln === "ins" || ln === "smartTag" || ln === "sdt" || ln === "sdtContent" || ln === "fldSimple") { visit(c, href); continue; }
        if (ln !== "r") continue;
        const pr = child(c, "rPr");
        const on = (name: string) => { const e = pr && child(pr, name); return !!e && !["0", "false"].includes(attr(e, "val") ?? ""); };
        const u = pr && child(pr, "u");
        const color = pr && child(pr, "color") && attr(child(pr, "color")!, "val");
        const font = pr && child(pr, "rFonts") && attr(child(pr, "rFonts")!, "ascii");
        let t = "";
        for (const x of kids(c)) {
          const xn = local(x.name);
          if (xn === "t") t += textOf(x);
          else if (xn === "tab") t += "\t";
          else if (xn === "br" && attr(x, "type") !== "page") t += "\n";
        }
        if (!t) continue;
        const run: Run = { text: t };
        if (on("b")) run.b = true;
        if (on("i")) run.i = true;
        if (u && attr(u, "val") !== "none" && !href) run.u = true;
        if (on("strike")) run.s = true;
        if (font && /consolas|courier|mono/i.test(font)) run.code = true;
        if (href) run.href = href;
        if (color && /^[0-9A-F]{6}$/i.test(color) && color.toUpperCase() !== "000000" && !href) run.color = `#${color.toLowerCase()}`;
        out.push(run);
      }
    };
    visit(p);
    return out;
  };

  const blocks: Block[] = [];
  const body = all(parseXml(docXml), "body")[0];
  if (!body) return { title, blocks };
  for (const node of kids(body)) {
    const ln = local(node.name);
    if (ln === "tbl") {
      const rows = kids(node, "tr").map((tr) => kids(tr, "tc").map((tc) => kids(tc, "p").flatMap((p, k) => (k ? [{ text: "\n" }, ...runsOf(p)] : runsOf(p)))));
      blocks.push({ t: "table", rows });
      continue;
    }
    if (ln !== "p") continue;
    const pr = child(node, "pPr");
    const style = (pr && child(pr, "pStyle") && attr(child(pr, "pStyle")!, "val")) ?? "";
    const numPr = pr && child(pr, "numPr");
    const jcv = pr && child(pr, "jc") && attr(child(pr, "jc")!, "val");
    const align: Align | undefined = jcv === "center" ? "center" : jcv === "right" || jcv === "end" ? "right" : jcv === "both" ? "justify" : undefined;
    if (all(node, "br").some((b) => attr(b, "type") === "page") && !textOf(node).trim()) { blocks.push({ t: "pagebreak" }); continue; }
    const drawing = all(node, "blip")[0];
    if (drawing) {
      const target = relMap.get(attr(drawing, "embed") ?? "") ?? "";
      const bytes = files.get(`word/${target.replace(/^\/?word\//, "")}`);
      const ext = target.split(".").pop()?.toLowerCase() ?? "png";
      const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "gif" ? "image/gif" : "image/png";
      const alt = attr(all(node, "docPr")[0] ?? { name: "", attrs: {}, children: [] }, "descr") ?? "";
      if (bytes && typeof bytes !== "string") { blocks.push({ t: "img", src: `data:${mime};base64,${toBase64(bytes)}`, alt }); continue; }
    }
    const runs = runsOf(node);
    const h = /^heading\s?([1-6])$/i.exec(style) ?? /^Heading([1-6])$/.exec(style);
    if (h) { blocks.push({ t: "h", level: Math.min(4, Number(h[1])) as 1 | 2 | 3 | 4, runs, ...(align ? { align } : {}) }); continue; }
    if (/^title$/i.test(style)) { blocks.push({ t: "h", level: 1, runs, ...(align ? { align } : {}) }); continue; }
    if (numPr) {
      const numId = attr(child(numPr, "numId") ?? { name: "", attrs: {}, children: [] }, "val") ?? "";
      const level = Number(attr(child(numPr, "ilvl") ?? { name: "", attrs: {}, children: [] }, "val") ?? 0) || 0;
      const ordered = orderedNum.has(numId);
      const last = blocks[blocks.length - 1];
      if (last?.t === "list" && last.ordered === ordered) last.items.push({ runs, level });
      else blocks.push({ t: "list", ordered, items: [{ runs, level }] });
      continue;
    }
    if (/quote/i.test(style)) { blocks.push({ t: "quote", runs }); continue; }
    if (/^code$/i.test(style)) {
      const last = blocks[blocks.length - 1];
      const line = plain(runs);
      if (last?.t === "code") last.text += `\n${line}`;
      else blocks.push({ t: "code", text: line });
      continue;
    }
    if (!runs.length && all(node, "pBdr").length) { blocks.push({ t: "hr" }); continue; }
    blocks.push({ t: "p", runs, ...(align ? { align } : {}) });
  }
  return { title, blocks };
}

/* ── .odt (OpenDocument text) ───────────────────────────────────────────── */

const ODF_NS = `xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:loext="urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0" office:version="1.3"`;

export function odfManifest(mime: string, parts: Array<{ path: string; type: string }>): string {
  return `<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="${mime}"/>${parts.map((p) => `<manifest:file-entry manifest:full-path="${p.path}" manifest:media-type="${p.type}"/>`).join("")}</manifest:manifest>`;
}

export function odfMeta(title: string, when: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><office:document-meta ${ODF_NS}><office:meta><dc:title>${escapeXml(title)}</dc:title><meta:generator>Web-AIOS</meta:generator><meta:creation-date>${when.replace(/Z$/, "")}</meta:creation-date></office:meta></office:document-meta>`;
}

export { ODF_NS };

export function toOdt(doc: Doc, opts: { when?: string } = {}): ZipEntry[] {
  // Automatic text styles: one per distinct combination of run formatting.
  const spanStyles = new Map<string, string>();
  const spanName = (r: Run) => {
    const key = [r.b, r.i, r.u, r.s, r.code, r.color].map((x) => (x ? String(x) : "")).join("|");
    if (key === "|||||") return null;
    if (!spanStyles.has(key)) spanStyles.set(key, `T${spanStyles.size + 1}`);
    return spanStyles.get(key)!;
  };
  const spanProps = (key: string) => {
    const [b, i, u, s, code, color] = key.split("|");
    return [b && `fo:font-weight="bold"`, i && `fo:font-style="italic"`, u && `style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"`, s && `style:text-line-through-style="solid"`, code && `style:font-name="Liberation Mono" fo:font-family="'Liberation Mono'"`, color && `fo:color="${color}"`].filter(Boolean).join(" ");
  };
  const runsXml = (runs: Run[]) =>
    runs
      .map((r) => {
        const inner = r.text.split("\n").map((t) => escapeXml(t).replace(/ {2,}/g, (m) => ` <text:s text:c="${m.length - 1}"/>`).replace(/\t/g, "<text:tab/>")).join("<text:line-break/>");
        const st = spanName(r);
        const span = st ? `<text:span text:style-name="${st}">${inner}</text:span>` : inner;
        return r.href ? `<text:a xlink:type="simple" xlink:href="${escapeXml(r.href)}">${span}</text:a>` : span;
      })
      .join("");
  const paraStyle = (a?: Align) => (a && a !== "left" ? `P_${a}` : "Standard");
  const media: ZipEntry[] = [];
  const mediaParts: Array<{ path: string; type: string }> = [];
  let imgN = 0;
  const body: string[] = [];
  for (const b of doc.blocks) {
    switch (b.t) {
      case "h": body.push(`<text:h text:style-name="Heading_20_${b.level}" text:outline-level="${b.level}">${runsXml(b.runs)}</text:h>`); break;
      case "p": body.push(`<text:p text:style-name="${paraStyle(b.align)}">${runsXml(b.runs)}</text:p>`); break;
      case "quote": body.push(`<text:p text:style-name="Quotations">${runsXml(b.runs)}</text:p>`); break;
      case "code": body.push(...b.text.split("\n").map((l) => `<text:p text:style-name="Preformatted_20_Text">${runsXml([{ text: l }])}</text:p>`)); break;
      case "list": {
        // Nesting in ODF is structural: a deeper item lives in a list inside the previous item.
        const style = b.ordered ? "L_num" : "L_bullet";
        let xml = `<text:list text:style-name="${style}">`;
        let depth = 0;
        b.items.forEach((it, idx) => {
          const lvl = Math.min(it.level, depth + (idx === 0 ? 0 : 1));
          while (depth < lvl) { xml = xml.replace(/<\/text:list-item>$/, ""); xml += `<text:list>`; depth++; }
          while (depth > lvl) { xml += `</text:list></text:list-item>`; depth--; }
          xml += `<text:list-item><text:p text:style-name="Standard">${runsXml(it.runs)}</text:p></text:list-item>`;
        });
        while (depth > 0) { xml += `</text:list></text:list-item>`; depth--; }
        body.push(xml + `</text:list>`);
        break;
      }
      case "table": {
        const w = Math.max(1, ...b.rows.map((r) => r.length));
        body.push(`<table:table table:name="Table${body.length + 1}"><table:table-column table:number-columns-repeated="${w}"/>${b.rows.map((r) => `<table:table-row>${Array.from({ length: w }, (_, j) => `<table:table-cell table:style-name="Cell" office:value-type="string"><text:p>${runsXml(r[j] ?? [])}</text:p></table:table-cell>`).join("")}</table:table-row>`).join("")}</table:table>`);
        break;
      }
      case "img": {
        const d = parseDataUrl(b.src);
        if (!d) break;
        const n = ++imgN, path = `Pictures/image${n}.${EXT[d.mime]}`;
        media.push({ path, content: d.bytes });
        mediaParts.push({ path, type: d.mime });
        const wIn = (Math.min(600, b.w ?? 480) / 96).toFixed(2), hIn = ((b.h ?? Math.round(Math.min(600, b.w ?? 480) * 0.66)) / 96).toFixed(2);
        body.push(`<text:p text:style-name="Standard"><draw:frame draw:name="Image${n}" text:anchor-type="as-char" svg:width="${wIn}in" svg:height="${hIn}in"><draw:image xlink:href="${path}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/><svg:desc>${escapeXml(b.alt)}</svg:desc></draw:frame></text:p>`);
        break;
      }
      case "hr": body.push(`<text:p text:style-name="Horizontal_20_Line"/>`); break;
      case "pagebreak": body.push(`<text:p text:style-name="PageBreak"/>`); break;
    }
  }
  const auto = [...spanStyles.entries()].map(([k, n]) => `<style:style style:name="${n}" style:family="text"><style:text-properties ${spanProps(k)}/></style:style>`).join("")
    + (["center", "right", "justify"] as const).map((a) => `<style:style style:name="P_${a}" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:text-align="${a === "right" ? "end" : a}"/></style:style>`).join("")
    + `<style:style style:name="PageBreak" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:break-after="page"/></style:style>`
    + `<style:style style:name="Cell" style:family="table-cell"><style:table-cell-properties fo:padding="0.04in" fo:border="0.5pt solid #999999"/></style:style>`
    + `<text:list-style style:name="L_bullet">${Array.from({ length: 5 }, (_, l) => `<text:list-level-style-bullet text:level="${l + 1}" text:bullet-char="${l % 2 ? "◦" : "•"}"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" fo:text-indent="-0.25in" fo:margin-left="${(0.5 * (l + 1)).toFixed(2)}in"/></style:list-level-properties></text:list-level-style-bullet>`).join("")}</text:list-style>`
    + `<text:list-style style:name="L_num">${Array.from({ length: 5 }, (_, l) => `<text:list-level-style-number text:level="${l + 1}" style:num-suffix="." style:num-format="${l % 3 === 1 ? "a" : l % 3 === 2 ? "i" : "1"}"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" fo:text-indent="-0.25in" fo:margin-left="${(0.5 * (l + 1)).toFixed(2)}in"/></style:list-level-properties></text:list-level-style-number>`).join("")}</text:list-style>`;
  const content = `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${ODF_NS}><office:font-face-decls><style:font-face style:name="Liberation Mono" svg:font-family="'Liberation Mono'" style:font-pitch="fixed"/></office:font-face-decls><office:automatic-styles>${auto}</office:automatic-styles><office:body><office:text>${body.join("")}</office:text></office:body></office:document-content>`;
  const hStyle = (l: number, size: string) => `<style:style style:name="Heading_20_${l}" style:display-name="Heading ${l}" style:family="paragraph" style:parent-style-name="Standard" style:default-outline-level="${l}"><style:paragraph-properties fo:margin-top="0.17in" fo:margin-bottom="0.08in" fo:keep-with-next="always"/><style:text-properties fo:font-size="${size}" fo:font-weight="bold"/></style:style>`;
  const styles = `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${ODF_NS}><office:styles><style:default-style style:family="paragraph"><style:text-properties fo:font-size="11pt"/></style:default-style><style:style style:name="Standard" style:family="paragraph"><style:paragraph-properties fo:margin-bottom="0.08in"/></style:style>${hStyle(1, "20pt")}${hStyle(2, "16pt")}${hStyle(3, "13pt")}${hStyle(4, "12pt")}<style:style style:name="Quotations" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:margin-left="0.4in"/><style:text-properties fo:font-style="italic" fo:color="#555555"/></style:style><style:style style:name="Preformatted_20_Text" style:display-name="Preformatted Text" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:margin-bottom="0in"/><style:text-properties style:font-name="Liberation Mono" fo:font-size="10pt"/></style:style><style:style style:name="Horizontal_20_Line" style:display-name="Horizontal Line" style:family="paragraph"><style:paragraph-properties fo:border-bottom="0.5pt solid #999999"/></style:style></office:styles></office:document-styles>`;
  return [
    { path: "mimetype", content: "application/vnd.oasis.opendocument.text" },
    { path: "META-INF/manifest.xml", content: odfManifest("application/vnd.oasis.opendocument.text", [{ path: "content.xml", type: "text/xml" }, { path: "styles.xml", type: "text/xml" }, { path: "meta.xml", type: "text/xml" }, ...mediaParts]) },
    { path: "content.xml", content },
    { path: "styles.xml", content: styles },
    { path: "meta.xml", content: odfMeta(doc.title, opts.when ?? "2026-01-01T00:00:00Z") },
    ...media,
  ];
}

/** Read an unzipped .odt's content.xml (styles resolved from its automatic styles). */
export function fromOdt(files: Map<string, string | Uint8Array>, title = "Imported document"): Doc {
  const get = (p: string) => { const v = files.get(p); return v === undefined ? "" : typeof v === "string" ? v : new TextDecoder().decode(v); };
  const content = parseXml(get("content.xml"));
  const fmt = new Map<string, Omit<Run, "text">>();
  for (const st of all(content, "style")) {
    const tp = child(st, "text-properties");
    if (!tp) continue;
    const f: Omit<Run, "text"> = {};
    if (attr(tp, "font-weight") === "bold") f.b = true;
    if (attr(tp, "font-style") === "italic") f.i = true;
    const ul = attr(tp, "text-underline-style");
    if (ul && ul !== "none") f.u = true;
    const lt = attr(tp, "text-line-through-style");
    if (lt && lt !== "none") f.s = true;
    if (/mono|courier/i.test(attr(tp, "font-name") ?? "")) f.code = true;
    const c = attr(tp, "color");
    if (c && /^#[0-9a-f]{6}$/i.test(c) && c.toLowerCase() !== "#000000") f.color = c.toLowerCase();
    fmt.set(attr(st, "name") ?? "", f);
  }
  const runsOf = (n: XNode, base: Omit<Run, "text"> = {}): Run[] => {
    const out: Run[] = [];
    for (const c of n.children) {
      if (typeof c === "string") { if (c) out.push({ text: c, ...base }); continue; }
      const ln = local(c.name);
      if (ln === "span") out.push(...runsOf(c, { ...base, ...(fmt.get(attr(c, "style-name") ?? "") ?? {}) }));
      else if (ln === "a") out.push(...runsOf(c, { ...base, href: attr(c, "href") }));
      else if (ln === "s") out.push({ text: " ".repeat(Number(attr(c, "c") ?? 1)), ...base });
      else if (ln === "tab") out.push({ text: "\t", ...base });
      else if (ln === "line-break") out.push({ text: "\n", ...base });
    }
    return out;
  };
  const blocks: Block[] = [];
  const textRoot = all(content, "text").find((n) => n.name === "office:text") ?? all(content, "text")[0];
  if (!textRoot) return { title, blocks };
  const listItems = (list: XNode, level: number, items: ListItem[]) => {
    for (const li of kids(list, "list-item")) {
      for (const c of kids(li)) {
        if (local(c.name) === "p" || local(c.name) === "h") items.push({ runs: runsOf(c), level });
        else if (local(c.name) === "list") listItems(c, level + 1, items);
      }
    }
  };
  for (const n of kids(textRoot)) {
    const ln = local(n.name);
    if (ln === "h") blocks.push({ t: "h", level: Math.min(4, Math.max(1, Number(attr(n, "outline-level") ?? 1))) as 1 | 2 | 3 | 4, runs: runsOf(n) });
    else if (ln === "p") {
      const st = attr(n, "style-name") ?? "";
      const frame = all(n, "image")[0];
      if (frame) {
        const href = attr(frame, "href") ?? "";
        const bytes = files.get(href);
        const ext = href.split(".").pop()?.toLowerCase();
        if (bytes && typeof bytes !== "string") { blocks.push({ t: "img", src: `data:${ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png"};base64,${toBase64(bytes)}`, alt: textOf(all(n, "desc")[0] ?? { name: "", attrs: {}, children: [] }) }); continue; }
      }
      if (/quotation/i.test(st)) blocks.push({ t: "quote", runs: runsOf(n) });
      else if (/preformatted/i.test(st)) {
        const last = blocks[blocks.length - 1];
        // runsOf, not textOf: repeated spaces are <text:s> elements, not text.
        const line = plain(runsOf(n));
        if (last?.t === "code") last.text += `\n${line}`;
        else blocks.push({ t: "code", text: line });
      } else if (/horizontal/i.test(st)) blocks.push({ t: "hr" });
      else if (/^PageBreak$/.test(st)) blocks.push({ t: "pagebreak" });
      else {
        const align = /center/.test(st) ? "center" : /right/.test(st) ? "right" : /justify/.test(st) ? "justify" : undefined;
        blocks.push({ t: "p", runs: runsOf(n), ...(align ? { align: align as Align } : {}) });
      }
    } else if (ln === "list") {
      const items: ListItem[] = [];
      listItems(n, 0, items);
      blocks.push({ t: "list", ordered: /num/i.test(attr(n, "style-name") ?? ""), items });
    } else if (ln === "table") {
      blocks.push({ t: "table", rows: kids(n, "table-row").map((tr) => kids(tr, "table-cell").map((tc) => kids(tc, "p").flatMap((p) => runsOf(p)))) });
    }
  }
  return { title, blocks };
}
