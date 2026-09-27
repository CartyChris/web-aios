/* ────────────────────────────────────────────────────────────────────────────
   A small XML reader and writer for office packages.

   The office formats (OOXML: .docx .xlsx .pptx; ODF: .odt .ods .odp) are zip
   archives of XML. Reading them in the page could use DOMParser, but then the
   importers could not be tested outside a browser, and they are exactly the
   code that meets hostile, strange, real-world files. This parser handles what
   those files contain: elements, attributes, text, CDATA, comments,
   processing instructions and the five named plus numeric entities. It does
   not resolve DTDs or external entities, which is also what makes it safe
   (no entity expansion attacks).

   PURE. No DOM.
   ──────────────────────────────────────────────────────────────────────────── */

export interface XNode {
  name: string;
  attrs: Record<string, string>;
  children: Array<XNode | string>;
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

export function escapeXml(s: string): string {
  // Characters XML 1.0 forbids outright are dropped rather than escaped.
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Parse a document; returns a synthetic root whose children are the top-level nodes. */
export function parseXml(src: string, maxNodes = 500_000): XNode {
  const root: XNode = { name: "#root", attrs: {}, children: [] };
  const stack: XNode[] = [root];
  let i = 0, count = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt < 0) { pushText(stack, src.slice(i)); break; }
    if (lt > i) pushText(stack, src.slice(i, lt));
    if (src.startsWith("<!--", lt)) { const e = src.indexOf("-->", lt + 4); i = e < 0 ? n : e + 3; continue; }
    if (src.startsWith("<![CDATA[", lt)) {
      const e = src.indexOf("]]>", lt + 9);
      const text = src.slice(lt + 9, e < 0 ? n : e);
      stack[stack.length - 1].children.push(text);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (src[lt + 1] === "?" || src[lt + 1] === "!") { const e = src.indexOf(">", lt); i = e < 0 ? n : e + 1; continue; }
    const gt = findTagEnd(src, lt);
    if (gt < 0) break;
    const body = src.slice(lt + 1, gt);
    i = gt + 1;
    if (body[0] === "/") {
      const name = body.slice(1).trim();
      // Close to the matching open tag; a stray close tag is ignored.
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) { stack.length = k; break; }
      }
      continue;
    }
    const selfClose = body.endsWith("/");
    const inner = selfClose ? body.slice(0, -1) : body;
    const m = /^([^\s/>]+)/.exec(inner);
    if (!m) continue;
    const node: XNode = { name: m[1], attrs: parseAttrs(inner.slice(m[1].length)), children: [] };
    if (++count > maxNodes) throw new Error("XML too large");
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}

function findTagEnd(src: string, from: number): number {
  let q: string | null = null;
  for (let k = from + 1; k < src.length; k++) {
    const c = src[k];
    if (q) { if (c === q) q = null; }
    else if (c === '"' || c === "'") q = c;
    else if (c === ">") return k;
  }
  return -1;
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out[m[1]] = decodeEntities(m[3] ?? m[4] ?? "");
  return out;
}

function pushText(stack: XNode[], raw: string) {
  if (!raw) return;
  stack[stack.length - 1].children.push(decodeEntities(raw));
}

/* ── queries ─────────────────────────────────────────────────────────────── */

/** Local name without a namespace prefix: "w:p" -> "p". */
export const local = (name: string): string => name.slice(name.indexOf(":") + 1);

export function kids(n: XNode, name?: string): XNode[] {
  return n.children.filter((c): c is XNode => typeof c !== "string" && (name === undefined || c.name === name || local(c.name) === name));
}

export function child(n: XNode, name: string): XNode | undefined {
  return kids(n, name)[0];
}

/** Every descendant with this (qualified or local) name, in document order. */
export function all(n: XNode, name: string, out: XNode[] = []): XNode[] {
  for (const c of n.children) {
    if (typeof c === "string") continue;
    if (c.name === name || local(c.name) === name) out.push(c);
    all(c, name, out);
  }
  return out;
}

/** All text under a node, concatenated. */
export function textOf(n: XNode): string {
  return n.children.map((c) => (typeof c === "string" ? c : textOf(c))).join("");
}

export function attr(n: XNode, name: string): string | undefined {
  if (name in n.attrs) return n.attrs[name];
  const k = Object.keys(n.attrs).find((a) => local(a) === name);
  return k === undefined ? undefined : n.attrs[k];
}
