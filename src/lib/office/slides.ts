/* ────────────────────────────────────────────────────────────────────────────
   Impress's decks: an outline in, .pptx / .odp / a self-contained HTML
   presentation out, and .pptx / .odp back in.

   The model is what a talk actually needs -- a title and bullets (with
   levels), an optional second column, an optional image, and speaker notes --
   laid out by a small set of layouts. An AI "outline -> deck" asks the model
   for Markdown, which fromOutline() reads deterministically, rather than
   trusting a model to emit valid slide XML.

   PURE.
   ──────────────────────────────────────────────────────────────────────────── */

import { escapeXml, parseXml, all, kids, attr, textOf, local, type XNode } from "./xml";
import { parseDataUrl, odfManifest, odfMeta, ODF_NS, toBase64 } from "./doc";
import type { ZipEntry } from "../zip";

export type Layout = "title" | "content" | "two" | "section" | "quote" | "image";
export interface Bullet { text: string; level: number }
export interface Slide {
  layout: Layout;
  title: string;
  subtitle?: string;
  bullets: Bullet[];
  /** Second column for the "two" layout. */
  right?: Bullet[];
  /** data: URL */
  image?: string;
  notes?: string;
}
export interface DeckTheme { bg: string; fg: string; accent: string; font: string }
export interface Deck { title: string; theme: DeckTheme; slides: Slide[] }

export const THEMES: Record<string, DeckTheme> = {
  midnight: { bg: "#0b1020", fg: "#e8eefc", accent: "#7c9cff", font: "Inter, system-ui, sans-serif" },
  paper: { bg: "#fbfaf7", fg: "#1d1d1f", accent: "#c2410c", font: "Georgia, serif" },
  aurora: { bg: "#06141b", fg: "#e0fbfc", accent: "#2ee6a6", font: "system-ui, sans-serif" },
  mono: { bg: "#ffffff", fg: "#111111", accent: "#111111", font: "'IBM Plex Mono', monospace" },
  sunset: { bg: "#2b1320", fg: "#fff1e6", accent: "#ff8a5b", font: "system-ui, sans-serif" },
};

const HEX = /^#[0-9a-f]{6}$/i;
export function normaliseTheme(t: Partial<DeckTheme> | undefined): DeckTheme {
  const base = THEMES.midnight;
  return {
    bg: t?.bg && HEX.test(t.bg) ? t.bg : base.bg,
    fg: t?.fg && HEX.test(t.fg) ? t.fg : base.fg,
    accent: t?.accent && HEX.test(t.accent) ? t.accent : base.accent,
    font: typeof t?.font === "string" && t.font.length < 80 && !/[<>{};]/.test(t.font) ? t.font : base.font,
  };
}

/* ── outline in ──────────────────────────────────────────────────────────── */

/**
 * Markdown outline -> deck.
 *   # Deck title        (first H1 becomes the title slide; a "> " line under it the subtitle)
 *   ## Slide title      (each H2 starts a slide; "### " starts a section divider)
 *   - bullet / "  - " nested
 *   > quote             (a slide with only a quote uses the quote layout)
 *   Notes: ...          (speaker notes, to the end of the slide)
 *   ||                  (a line with only || splits bullets into two columns)
 */
export function fromOutline(md: string, theme: DeckTheme = THEMES.midnight): Deck {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const slides: Slide[] = [];
  let title = "Untitled deck";
  let cur: Slide | null = null;
  let inNotes = false, second = false;
  const start = (s: Slide) => { cur = s; slides.push(s); inNotes = false; second = false; };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    let m: RegExpExecArray | null;
    if ((m = /^#\s+(.+)/.exec(line))) { title = m[1].trim(); start({ layout: "title", title, bullets: [] }); continue; }
    if ((m = /^##\s+(.+)/.exec(line))) { start({ layout: "content", title: m[1].trim(), bullets: [] }); continue; }
    if ((m = /^###\s+(.+)/.exec(line))) { start({ layout: "section", title: m[1].trim(), bullets: [] }); continue; }
    const c = cur as Slide | null;
    if (!c) continue;
    if ((m = /^notes?:\s*(.*)$/i.exec(line))) { inNotes = true; c.notes = m[1]; continue; }
    if (inNotes) { c.notes = `${c.notes ? `${c.notes}\n` : ""}${line}`.trim(); continue; }
    if (line.trim() === "||") { second = true; c.layout = "two"; c.right = c.right ?? []; continue; }
    if ((m = /^(\s*)[-*+]\s+(.+)$/.exec(line))) {
      const b = { text: m[2].trim(), level: Math.min(3, Math.floor(m[1].length / 2)) };
      (second ? c.right! : c.bullets).push(b);
      continue;
    }
    if ((m = /^>\s*(.+)$/.exec(line))) {
      if (c.layout === "title") c.subtitle = m[1].trim();
      else { c.subtitle = m[1].trim(); if (!c.bullets.length) c.layout = "quote"; }
      continue;
    }
    if (line.trim() && c.layout !== "title") c.bullets.push({ text: line.trim(), level: 0 });
  }
  if (!slides.length) slides.push({ layout: "title", title, bullets: [] });
  // A quote slide that later gained bullets is a content slide.
  for (const s of slides) if (s.layout === "quote" && s.bullets.length) s.layout = "content";
  return { title, theme, slides };
}

export function toOutline(deck: Deck): string {
  const out: string[] = [];
  for (const s of deck.slides) {
    out.push(s.layout === "title" ? `# ${s.title}` : s.layout === "section" ? `### ${s.title}` : `## ${s.title}`);
    if (s.subtitle) out.push(`> ${s.subtitle}`);
    for (const b of s.bullets) out.push(`${"  ".repeat(b.level)}- ${b.text}`);
    if (s.right?.length) { out.push("||"); for (const b of s.right) out.push(`${"  ".repeat(b.level)}- ${b.text}`); }
    if (s.notes) out.push(`Notes: ${s.notes}`);
    out.push("");
  }
  return out.join("\n");
}

/* ── geometry shared by the exporters (16:9, in EMU: 914400 per inch) ──── */

const W = 12192000, H = 6858000;
interface Box { x: number; y: number; w: number; h: number }
function boxes(s: Slide): { title: Box; body?: Box; right?: Box; sub?: Box; image?: Box } {
  const m = 609600; // 2/3 inch margin
  switch (s.layout) {
    case "title": return { title: { x: m, y: 2130000, w: W - 2 * m, h: 1470000 }, sub: { x: m, y: 3700000, w: W - 2 * m, h: 900000 } };
    case "section": return { title: { x: m, y: 2700000, w: W - 2 * m, h: 1300000 }, sub: { x: m, y: 4000000, w: W - 2 * m, h: 700000 } };
    case "quote": return { title: { x: m, y: 600000, w: W - 2 * m, h: 900000 }, sub: { x: m * 2, y: 2000000, w: W - 4 * m, h: 3000000 } };
    case "two": return { title: { x: m, y: 400000, w: W - 2 * m, h: 1000000 }, body: { x: m, y: 1600000, w: (W - 3 * m) / 2, h: H - 2200000 }, right: { x: m * 2 + (W - 3 * m) / 2, y: 1600000, w: (W - 3 * m) / 2, h: H - 2200000 } };
    case "image": return { title: { x: m, y: 400000, w: W - 2 * m, h: 1000000 }, body: { x: m, y: 1600000, w: (W - 3 * m) * 0.4, h: H - 2200000 }, image: { x: m * 2 + (W - 3 * m) * 0.4, y: 1600000, w: (W - 3 * m) * 0.6, h: H - 2200000 } };
    default: return { title: { x: m, y: 400000, w: W - 2 * m, h: 1000000 }, body: { x: m, y: 1600000, w: W - 2 * m, h: H - 2200000 }, ...(s.image ? { image: { x: W - m - 3600000, y: 1600000, w: 3600000, h: 2700000 } } : {}) };
  }
}

const hex = (c: string) => c.replace("#", "").toUpperCase();

/* ── .pptx ───────────────────────────────────────────────────────────────── */

const P_NS = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`;

export function toPptx(deck: Deck, opts: { when?: string } = {}): ZipEntry[] {
  const th = normaliseTheme(deck.theme);
  const font = escapeXml(th.font.split(",")[0].replace(/['"]/g, "").trim() || "Calibri");
  let spId = 1;
  const textBox = (b: Box, paras: string, name: string) =>
    `<p:sp><p:nvSpPr><p:cNvPr id="${++spId}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${Math.round(b.x)}" y="${Math.round(b.y)}"/><a:ext cx="${Math.round(b.w)}" cy="${Math.round(b.h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" anchor="t"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paras}</p:txBody></p:sp>`;
  const run = (text: string, size: number, color: string, bold = false, italic = false) =>
    `<a:r><a:rPr lang="en-US" sz="${size}"${bold ? ` b="1"` : ""}${italic ? ` i="1"` : ""} dirty="0"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="${font}"/></a:rPr><a:t>${escapeXml(text)}</a:t></a:r>`;
  const para = (text: string, size: number, color: string, o: { bold?: boolean; italic?: boolean; align?: "l" | "ctr"; level?: number; bullet?: boolean } = {}) =>
    `<a:p><a:pPr algn="${o.align ?? "l"}"${o.bullet ? ` marL="${342900 + (o.level ?? 0) * 457200}" indent="-342900" lvl="${o.level ?? 0}"` : ""}>${o.bullet ? `<a:buFont typeface="Arial"/><a:buChar char="${(o.level ?? 0) % 2 ? "–" : "•"}"/>` : "<a:buNone/>"}</a:pPr>${run(text, size, color, o.bold, o.italic)}</a:p>`;

  const media: ZipEntry[] = [];
  const mediaExt = new Set<string>();
  const slideParts: ZipEntry[] = [];
  deck.slides.forEach((s, i) => {
    spId = 1;
    const bx = boxes(s);
    const center = s.layout === "title" || s.layout === "section";
    const shapes: string[] = [];
    shapes.push(textBox(bx.title, para(s.title, s.layout === "title" ? 4400 : s.layout === "section" ? 4000 : 3200, hex(center ? th.fg : th.accent), { bold: true, align: center ? "ctr" : "l" }), "Title"));
    if (bx.sub && s.subtitle) shapes.push(textBox(bx.sub, para(s.layout === "quote" ? `“${s.subtitle}”` : s.subtitle, s.layout === "quote" ? 3200 : 2000, hex(th.fg), { italic: s.layout === "quote", align: center ? "ctr" : "l" }), "Subtitle"));
    const list = (bs: Bullet[]) => bs.map((b) => para(b.text, b.level ? 1800 : 2200, hex(th.fg), { bullet: true, level: b.level })).join("");
    if (bx.body && s.bullets.length) shapes.push(textBox(bx.body, list(s.bullets), "Body"));
    if (bx.right && s.right?.length) shapes.push(textBox(bx.right, list(s.right), "Body 2"));
    let rels = `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`;
    const img = s.image ? parseDataUrl(s.image) : null;
    if (img && bx.image && (img.mime === "image/png" || img.mime === "image/jpeg" || img.mime === "image/gif")) {
      const ext = img.mime.split("/")[1];
      const name = `image${i + 1}.${ext}`;
      media.push({ path: `ppt/media/${name}`, content: img.bytes });
      mediaExt.add(ext);
      rels += `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${name}"/>`;
      const b = bx.image;
      shapes.push(`<p:pic><p:nvPicPr><p:cNvPr id="${++spId}" name="Picture"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${Math.round(b.x)}" y="${Math.round(b.y)}"/><a:ext cx="${Math.round(b.w)}" cy="${Math.round(b.h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`);
    }
    slideParts.push({ path: `ppt/slides/slide${i + 1}.xml`, content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${P_NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${hex(th.bg)}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes.join("")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>` });
    slideParts.push({ path: `ppt/slides/_rels/slide${i + 1}.xml.rels`, content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>` });
  });

  const n = deck.slides.length;
  const theme = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Web-AIOS"><a:themeElements><a:clrScheme name="Web-AIOS"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="${hex(th.bg)}"/></a:dk2><a:lt2><a:srgbClr val="${hex(th.fg)}"/></a:lt2><a:accent1><a:srgbClr val="${hex(th.accent)}"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Web-AIOS"><a:majorFont><a:latin typeface="${font}"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="${font}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Web-AIOS"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
  const emptyTree = `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree>`;
  return [
    { path: "[Content_Types].xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${[...mediaExt].map((e) => `<Default Extension="${e}" ContentType="image/${e}"/>`).join("")}<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${Array.from({ length: n }, (_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("")}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>` },
    { path: "_rels/.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>` },
    { path: "docProps/core.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(deck.title)}</dc:title><dc:creator>Web-AIOS Impress</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${opts.when ?? "2026-01-01T00:00:00Z"}</dcterms:created></cp:coreProperties>` },
    { path: "ppt/presentation.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation ${P_NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdM"/></p:sldMasterIdLst><p:sldIdLst>${Array.from({ length: n }, (_, i) => `<p:sldId id="${256 + i}" r:id="rIdS${i + 1}"/>`).join("")}</p:sldIdLst><p:sldSz cx="${W}" cy="${H}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>` },
    { path: "ppt/_rels/presentation.xml.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdM" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rIdT" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>${Array.from({ length: n }, (_, i) => `<Relationship Id="rIdS${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join("")}</Relationships>` },
    { path: "ppt/slideMasters/slideMaster1.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster ${P_NS}><p:cSld>${emptyTree}</p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>` },
    { path: "ppt/slideMasters/_rels/slideMaster1.xml.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>` },
    { path: "ppt/slideLayouts/slideLayout1.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout ${P_NS} type="blank" preserve="1"><p:cSld name="Blank">${emptyTree}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>` },
    { path: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>` },
    { path: "ppt/theme/theme1.xml", content: theme },
    ...slideParts,
    ...media,
  ];
}

/** Text out of an unzipped .pptx: titles, bullets with levels, and notes when present. */
export function fromPptx(files: Map<string, string | Uint8Array>, theme: DeckTheme = THEMES.midnight): Deck {
  const text = (p: string) => { const v = files.get(p); return v === undefined ? "" : typeof v === "string" ? v : new TextDecoder().decode(v); };
  const pres = parseXml(text("ppt/presentation.xml"));
  const rels = new Map(all(parseXml(text("ppt/_rels/presentation.xml.rels")), "Relationship").map((r) => [attr(r, "Id") ?? "", attr(r, "Target") ?? ""]));
  const order = all(pres, "sldId").map((s) => rels.get(attr(s, "id") ?? "") ?? "").filter(Boolean);
  const paths = order.length ? order.map((t) => `ppt/${t.replace(/^\/?ppt\//, "")}`) : [...files.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort((a, b) => Number(/(\d+)\.xml/.exec(a)![1]) - Number(/(\d+)\.xml/.exec(b)![1]));
  const paraText = (p: XNode) => all(p, "t").map(textOf).join("");
  const slides: Slide[] = paths.map((path, i) => {
    const x = parseXml(text(path));
    const shapes = all(x, "sp");
    const nameOf = (sp: XNode) => attr(all(sp, "cNvPr")[0] ?? sp, "name") ?? "";
    const phType = (sp: XNode) => attr(all(sp, "ph")[0] ?? { name: "", attrs: {}, children: [] }, "type") ?? "";
    const isSub = (sp: XNode) => /^subtitle$/i.test(nameOf(sp)) || phType(sp) === "subTitle";
    const isTitle = (sp: XNode) => !isSub(sp) && (/^(title|ctrTitle)$/.test(phType(sp)) || /^title/i.test(nameOf(sp)));
    const titleSp = shapes.find(isTitle) ?? shapes.find((sp) => !isSub(sp));
    const titleText = titleSp ? all(titleSp, "p").map(paraText).filter(Boolean).join(" ") : "";
    const subSp = shapes.find(isSub);
    const subtitle = subSp ? all(subSp, "p").map(paraText).join(" ").replace(/^\u201c|\u201d$/g, "") : undefined;
    const bodies = shapes.filter((s) => s !== titleSp && s !== subSp);
    const bulletsOf = (sp: XNode) => all(sp, "p").map((p) => ({ text: paraText(p), level: Number(attr(all(p, "pPr")[0] ?? p, "lvl") ?? 0) || 0 })).filter((b) => b.text.trim());
    const cols = bodies.map(bulletsOf).filter((b) => b.length);
    const relsPath = path.replace(/slides\/(slide\d+\.xml)$/, "slides/_rels/$1.rels");
    const notesTarget = all(parseXml(text(relsPath)), "Relationship").find((r) => /notesSlide/.test(attr(r, "Type") ?? ""));
    const notesPath = notesTarget ? `ppt/${(attr(notesTarget, "Target") ?? "").replace(/^\.\.\//, "")}` : "";
    const notes = notesPath ? all(parseXml(text(notesPath)), "sp").filter((sp) => /body/i.test(phType(sp))).map((sp) => all(sp, "p").map(paraText).join("\n")).join("\n").trim() : "";
    const layout: Layout = cols.length > 1 ? "two" : cols.length ? "content" : i === 0 ? "title" : subtitle ? "quote" : "section";
    const slide: Slide = { layout, title: titleText, bullets: cols[0] ?? [] };
    if (subtitle) slide.subtitle = subtitle;
    if (cols.length > 1) slide.right = cols.slice(1).flat();
    if (notes) slide.notes = notes;
    return slide;
  });
  return { title: slides[0]?.title || "Imported deck", theme, slides };
}

/* ── .odp ────────────────────────────────────────────────────────────────── */

const cm = (emu: number) => `${(emu / 360000).toFixed(3)}cm`;

export function toOdp(deck: Deck, opts: { when?: string } = {}): ZipEntry[] {
  const th = normaliseTheme(deck.theme);
  const media: ZipEntry[] = [];
  const mediaParts: Array<{ path: string; type: string }> = [];
  const frame = (b: Box, inner: string, style: string) => `<draw:frame draw:style-name="gr1" draw:text-style-name="${style}" svg:x="${cm(b.x)}" svg:y="${cm(b.y)}" svg:width="${cm(b.w)}" svg:height="${cm(b.h)}"><draw:text-box>${inner}</draw:text-box></draw:frame>`;
  const list = (bs: Bullet[]) => {
    // Levels are structural in ODF, as in Writer.
    let xml = "<text:list>", depth = 0;
    bs.forEach((b, k) => {
      const lvl = Math.min(b.level, depth + (k === 0 ? 0 : 1));
      while (depth < lvl) { xml = xml.replace(/<\/text:list-item>$/, ""); xml += "<text:list>"; depth++; }
      while (depth > lvl) { xml += "</text:list></text:list-item>"; depth--; }
      xml += `<text:list-item><text:p text:style-name="Pbody">${escapeXml(b.text)}</text:p></text:list-item>`;
    });
    while (depth > 0) { xml += "</text:list></text:list-item>"; depth--; }
    return xml + "</text:list>";
  };
  const pages = deck.slides.map((s, i) => {
    const bx = boxes(s);
    const center = s.layout === "title" || s.layout === "section";
    const parts = [frame(bx.title, `<text:p text:style-name="${center ? "PtitleC" : "Ptitle"}">${escapeXml(s.title)}</text:p>`, "Ptitle")];
    if (bx.sub && s.subtitle) parts.push(frame(bx.sub, `<text:p text:style-name="${center ? "PsubC" : "Psub"}">${escapeXml(s.layout === "quote" ? `“${s.subtitle}”` : s.subtitle)}</text:p>`, "Psub"));
    if (bx.body && s.bullets.length) parts.push(frame(bx.body, list(s.bullets), "Pbody"));
    if (bx.right && s.right?.length) parts.push(frame(bx.right, list(s.right), "Pbody"));
    const img = s.image ? parseDataUrl(s.image) : null;
    if (img && bx.image) {
      const path = `Pictures/slide${i + 1}.${img.mime.split("/")[1].replace("+xml", "")}`;
      media.push({ path, content: img.bytes });
      mediaParts.push({ path, type: img.mime });
      const b = bx.image;
      parts.push(`<draw:frame svg:x="${cm(b.x)}" svg:y="${cm(b.y)}" svg:width="${cm(b.w)}" svg:height="${cm(b.h)}"><draw:image xlink:href="${path}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame>`);
    }
    const notes = s.notes ? `<presentation:notes><draw:frame svg:x="2cm" svg:y="14cm" svg:width="17cm" svg:height="10cm"><draw:text-box>${s.notes.split("\n").map((l) => `<text:p>${escapeXml(l)}</text:p>`).join("")}</draw:text-box></draw:frame></presentation:notes>` : "";
    return `<draw:page draw:name="${escapeXml(s.title || `Slide ${i + 1}`)}" draw:style-name="dp1" draw:master-page-name="Default" presentation:presentation-page-layout-name="AL0T0">${parts.join("")}${notes}</draw:page>`;
  });
  const ns = `${ODF_NS} xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"`;
  const content = `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${ns}><office:automatic-styles><style:style style:name="dp1" style:family="drawing-page"><style:drawing-page-properties draw:fill="solid" draw:fill-color="${th.bg}"/></style:style><style:style style:name="gr1" style:family="graphic"><style:graphic-properties draw:stroke="none" draw:fill="none"/></style:style><style:style style:name="Ptitle" style:family="paragraph"><style:text-properties fo:font-size="32pt" fo:font-weight="bold" fo:color="${th.accent}"/></style:style><style:style style:name="PtitleC" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/><style:text-properties fo:font-size="44pt" fo:font-weight="bold" fo:color="${th.fg}"/></style:style><style:style style:name="Psub" style:family="paragraph"><style:text-properties fo:font-size="24pt" fo:font-style="italic" fo:color="${th.fg}"/></style:style><style:style style:name="PsubC" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/><style:text-properties fo:font-size="20pt" fo:color="${th.fg}"/></style:style><style:style style:name="Pbody" style:family="paragraph"><style:text-properties fo:font-size="22pt" fo:color="${th.fg}"/></style:style></office:automatic-styles><office:body><office:presentation>${pages.join("")}</office:presentation></office:body></office:document-content>`;
  const styles = `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${ns}><office:automatic-styles><style:page-layout style:name="PM1"><style:page-layout-properties fo:page-width="33.867cm" fo:page-height="19.05cm" style:print-orientation="landscape"/></style:page-layout></office:automatic-styles><office:master-styles><style:master-page style:name="Default" style:page-layout-name="PM1"/></office:master-styles></office:document-styles>`;
  const mime = "application/vnd.oasis.opendocument.presentation";
  return [
    { path: "mimetype", content: mime },
    { path: "META-INF/manifest.xml", content: odfManifest(mime, [{ path: "content.xml", type: "text/xml" }, { path: "styles.xml", type: "text/xml" }, { path: "meta.xml", type: "text/xml" }, ...mediaParts]) },
    { path: "content.xml", content },
    { path: "styles.xml", content: styles },
    { path: "meta.xml", content: odfMeta(deck.title, opts.when ?? "2026-01-01T00:00:00Z") },
    ...media,
  ];
}

export function fromOdp(files: Map<string, string | Uint8Array>, theme: DeckTheme = THEMES.midnight): Deck {
  const v = files.get("content.xml");
  const x = parseXml(v === undefined ? "" : typeof v === "string" ? v : new TextDecoder().decode(v));
  const slides: Slide[] = all(x, "page").filter((p) => local(p.name) === "page").map((page, i) => {
    const frames = kids(page, "frame");
    const texts = frames.map((f) => ({ f, box: all(f, "text-box")[0] })).filter((t) => t.box);
    const flatList = (list: XNode, level: number, out: Bullet[]) => {
      for (const li of kids(list, "list-item")) for (const c of kids(li)) {
        if (local(c.name) === "p") out.push({ text: textOf(c), level });
        else if (local(c.name) === "list") flatList(c, level + 1, out);
      }
      return out;
    };
    const title = texts[0] ? all(texts[0].box, "p").map(textOf).join(" ") : "";
    const cols: Bullet[][] = [];
    let subtitle: string | undefined;
    for (const t of texts.slice(1)) {
      const lists = kids(t.box, "list");
      if (lists.length) cols.push(lists.flatMap((l) => flatList(l, 0, [])));
      else subtitle = all(t.box, "p").map(textOf).join(" ").replace(/^“|”$/g, "");
    }
    const notesNode = kids(page, "notes")[0];
    const notes = notesNode ? all(notesNode, "p").map(textOf).join("\n").trim() : "";
    const img = all(page, "image")[0];
    const imgBytes = img ? files.get(attr(img, "href") ?? "") : undefined;
    const slide: Slide = { layout: cols.length > 1 ? "two" : i === 0 && !cols.length ? "title" : cols.length ? "content" : subtitle ? "quote" : "section", title, bullets: cols[0] ?? [] };
    if (subtitle) slide.subtitle = subtitle;
    if (cols.length > 1) slide.right = cols[1];
    if (notes) slide.notes = notes;
    if (imgBytes && typeof imgBytes !== "string") slide.image = `data:image/png;base64,${toBase64(imgBytes)}`;
    return slide;
  });
  return { title: slides[0]?.title || "Imported deck", theme, slides };
}

/* ── self-contained HTML presentation ───────────────────────────────────── */

export function toHtmlDeck(deck: Deck): string {
  const th = normaliseTheme(deck.theme);
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const list = (bs: Bullet[]) => `<ul>${bs.map((b) => `<li style="margin-left:${b.level * 1.4}em${b.level ? ";font-size:.85em" : ""}">${esc(b.text)}</li>`).join("")}</ul>`;
  const slides = deck.slides.map((s) => {
    const img = s.image && /^data:image\/(png|jpeg|gif|webp);base64,/.test(s.image) ? `<img src="${esc(s.image)}" alt="">` : "";
    const body =
      s.layout === "title" || s.layout === "section" ? `<div class="center"><h1>${esc(s.title)}</h1>${s.subtitle ? `<p class="sub">${esc(s.subtitle)}</p>` : ""}</div>`
      : s.layout === "quote" ? `<h2>${esc(s.title)}</h2><blockquote>“${esc(s.subtitle ?? "")}”</blockquote>`
      : s.layout === "two" ? `<h2>${esc(s.title)}</h2><div class="cols"><div>${list(s.bullets)}</div><div>${list(s.right ?? [])}</div></div>`
      : `<h2>${esc(s.title)}</h2><div class="cols${img ? "" : " one"}"><div>${list(s.bullets)}</div>${img ? `<div>${img}</div>` : ""}</div>`;
    return `<section data-notes="${esc(s.notes ?? "")}">${body}</section>`;
  });
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(deck.title)}</title><style>
html,body{margin:0;height:100%;background:#000;overflow:hidden;font-family:${th.font}}
section{position:absolute;inset:0;margin:auto;aspect-ratio:16/9;max-width:100vw;max-height:100vh;background:${th.bg};color:${th.fg};box-sizing:border-box;padding:5% 6%;display:none;font-size:min(3.2vw,5.6vh)}
section.on{display:block}h1{font-size:2.4em;margin:0}h2{color:${th.accent};font-size:1.6em;margin:0 0 .6em}
.center{height:100%;display:flex;flex-direction:column;justify-content:center;text-align:center}.sub{opacity:.8;font-size:1.1em}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:4%}.cols.one{grid-template-columns:1fr}ul{margin:0;padding-left:1.2em}li{margin:.35em 0}
img{max-width:100%;max-height:60vh;border-radius:.3em}blockquote{font-size:1.4em;font-style:italic;margin:1em 2em}
#n{position:fixed;right:1em;bottom:.6em;color:#888;font:12px system-ui}
</style></head><body>${slides.join("\n")}<div id="n"></div><script>
var s=document.querySelectorAll('section'),i=0,n=document.getElementById('n');
function go(k){i=Math.max(0,Math.min(s.length-1,k));s.forEach(function(x,j){x.classList.toggle('on',j===i)});n.textContent=(i+1)+' / '+s.length;}
addEventListener('keydown',function(e){if(['ArrowRight','PageDown',' '].indexOf(e.key)>=0)go(i+1);if(['ArrowLeft','PageUp'].indexOf(e.key)>=0)go(i-1);if(e.key==='Home')go(0);if(e.key==='End')go(s.length-1);});
addEventListener('click',function(e){go(e.clientX>innerWidth/3?i+1:i-1)});go(0);
</script></body></html>`;
}
