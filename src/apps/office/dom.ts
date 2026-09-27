/* The editor's DOM to Writer's block model (lib/office/doc.ts).

   Used on every save and on every paste: pasted HTML from a web page or
   another word processor is parsed into the model and rendered back out by
   toHtml(), so only what the model can hold -- and nothing executable --
   reaches the document. */

import type { Block, Doc, Run, Align, ListItem } from "@/lib/office/doc";

type Fmt = Omit<Run, "text">;

function rgbToHex(c: string): string | undefined {
  if (/^#[0-9a-f]{6}$/i.test(c)) return c.toLowerCase();
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
  if (!m) return undefined;
  const hex = `#${[m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, "0")).join("")}`;
  return hex === "#000000" ? undefined : hex;
}

function inlineFmt(el: HTMLElement, base: Fmt): Fmt {
  const f: Fmt = { ...base };
  const tag = el.tagName;
  if (tag === "B" || tag === "STRONG") f.b = true;
  if (tag === "I" || tag === "EM") f.i = true;
  if (tag === "U" || tag === "INS") f.u = true;
  if (tag === "S" || tag === "STRIKE" || tag === "DEL") f.s = true;
  if (tag === "CODE" || tag === "KBD" || tag === "SAMP") f.code = true;
  if (tag === "A") { const h = el.getAttribute("href") ?? ""; if (/^(https?:|mailto:|#)/i.test(h)) f.href = h; }
  const st = el.style;
  if (st) {
    if (st.fontWeight === "bold" || Number(st.fontWeight) >= 600) f.b = true;
    if (st.fontStyle === "italic") f.i = true;
    if (st.textDecoration.includes("underline") || st.textDecorationLine?.includes("underline")) f.u = true;
    if (st.textDecoration.includes("line-through") || st.textDecorationLine?.includes("line-through")) f.s = true;
    const c = st.color ? rgbToHex(st.color) : undefined;
    if (c) f.color = c;
  }
  if (tag === "FONT") { const c = el.getAttribute("color"); if (c && /^#[0-9a-f]{6}$/i.test(c)) f.color = c.toLowerCase(); }
  return f;
}

export function runsOf(node: Node, base: Fmt = {}): Run[] {
  const out: Run[] = [];
  const push = (text: string, f: Fmt) => {
    if (!text) return;
    const last = out[out.length - 1];
    const same = last && JSON.stringify({ ...last, text: "" }) === JSON.stringify({ ...f, text: "" });
    if (same) last.text += text;
    else out.push({ text, ...f });
  };
  const walk = (n: Node, f: Fmt) => {
    for (const c of Array.from(n.childNodes)) {
      if (c.nodeType === 3) push((c.textContent ?? "").replace(/\s+/g, " "), f);
      else if (c.nodeType === 1) {
        const el = c as HTMLElement;
        if (el.tagName === "BR") push("\n", f);
        else if (el.tagName === "IMG" || el.tagName === "SCRIPT" || el.tagName === "STYLE") continue;
        else walk(el, inlineFmt(el, f));
      }
    }
  };
  walk(node, base);
  // Trim the whitespace HTML indentation leaves at the edges of a block.
  if (out.length) { out[0].text = out[0].text.replace(/^\s+/, ""); out[out.length - 1].text = out[out.length - 1].text.replace(/\s+$/, ""); }
  return out.filter((r) => r.text);
}

const alignOf = (el: HTMLElement): Align | undefined => {
  const a = el.style?.textAlign || el.getAttribute("align") || "";
  return a === "center" ? "center" : a === "right" || a === "end" ? "right" : a === "justify" ? "justify" : undefined;
};

const BLOCK = /^(P|DIV|H[1-6]|UL|OL|LI|BLOCKQUOTE|PRE|TABLE|HR|SECTION|ARTICLE|HEADER|FOOTER|MAIN|FIGURE|IMG)$/;

export function domToDoc(root: HTMLElement, title: string): Doc {
  const blocks: Block[] = [];
  let loose: Node[] = [];
  const flushLoose = () => {
    if (!loose.length) return;
    const holder = document.createElement("div");
    for (const n of loose) holder.appendChild(n.cloneNode(true));
    const r = runsOf(holder);
    if (r.length) blocks.push({ t: "p", runs: r });
    loose = [];
  };
  const list = (el: HTMLElement, level: number, items: ListItem[]) => {
    for (const li of Array.from(el.children)) {
      if (li.tagName !== "LI") { if (li.tagName === "UL" || li.tagName === "OL") list(li as HTMLElement, level + 1, items); continue; }
      const own = li.cloneNode(true) as HTMLElement;
      own.querySelectorAll("ul,ol").forEach((x) => x.remove());
      const ml = parseFloat((li as HTMLElement).style.marginLeft || "0");
      items.push({ runs: runsOf(own), level: Math.min(4, level + (ml ? Math.round(ml / 1.5) : 0)) });
      for (const sub of Array.from(li.children)) if (sub.tagName === "UL" || sub.tagName === "OL") list(sub as HTMLElement, level + 1, items);
    }
  };
  const visit = (parent: HTMLElement) => {
    for (const n of Array.from(parent.childNodes)) {
      if (n.nodeType !== 1) { if (n.nodeType === 3 && (n.textContent ?? "").trim()) loose.push(n); continue; }
      const el = n as HTMLElement;
      const tag = el.tagName;
      if (!BLOCK.test(tag)) { loose.push(el); continue; }
      flushLoose();
      if (el.dataset?.pagebreak !== undefined || el.style?.pageBreakAfter === "always" || el.style?.breakAfter === "page") { blocks.push({ t: "pagebreak" }); continue; }
      const h = /^H([1-6])$/.exec(tag);
      if (h) { const al = alignOf(el); blocks.push({ t: "h", level: Math.min(4, Number(h[1])) as 1 | 2 | 3 | 4, runs: runsOf(el), ...(al ? { align: al } : {}) }); continue; }
      if (tag === "UL" || tag === "OL") { const items: ListItem[] = []; list(el, 0, items); if (items.length) blocks.push({ t: "list", ordered: tag === "OL", items }); continue; }
      if (tag === "BLOCKQUOTE") { blocks.push({ t: "quote", runs: runsOf(el) }); continue; }
      if (tag === "PRE") { blocks.push({ t: "code", text: (el.textContent ?? "").replace(/\n$/, "") }); continue; }
      if (tag === "HR") { blocks.push({ t: "hr" }); continue; }
      if (tag === "TABLE") {
        const rows = Array.from(el.querySelectorAll("tr")).map((tr) => Array.from(tr.children).filter((c) => c.tagName === "TD" || c.tagName === "TH").map((c) => runsOf(c)));
        if (rows.length) blocks.push({ t: "table", rows });
        continue;
      }
      if (tag === "IMG") { pushImg(el as HTMLImageElement); continue; }
      // P / DIV / section-like: images inside become their own blocks; nested blocks recurse.
      if (Array.from(el.children).some((c) => BLOCK.test(c.tagName) && c.tagName !== "IMG")) { visit(el); flushLoose(); continue; }
      const imgs = Array.from(el.querySelectorAll("img"));
      const r = runsOf(el);
      const al = alignOf(el);
      if (r.length || !imgs.length) blocks.push({ t: "p", runs: r, ...(al ? { align: al } : {}) });
      for (const img of imgs) pushImg(img);
    }
  };
  const pushImg = (img: HTMLImageElement) => {
    const src = img.getAttribute("src") ?? "";
    if (!/^data:image\/(png|jpeg|gif|webp);base64,/.test(src)) return;
    // Keep the picture's own proportions: exporters otherwise have to guess a height.
    const nw = img.naturalWidth || img.width, nh = img.naturalHeight || img.height;
    const w = Math.min(600, img.width || nw);
    const size = w && nw && nh ? { w, h: Math.round((w * nh) / nw) } : {};
    blocks.push({ t: "img", src, alt: img.getAttribute("alt") ?? "", ...size });
  };
  visit(root);
  flushLoose();
  // An editor that is empty still shows one paragraph.
  return { title, blocks: blocks.length ? blocks : [{ t: "p", runs: [] }] };
}

/** Pasted HTML -> model, via an inert document (scripts never run in a DOMParser document). */
export function htmlToDoc(html: string, title = "Pasted"): Doc {
  const d = new DOMParser().parseFromString(html, "text/html");
  return domToDoc(d.body, title);
}
