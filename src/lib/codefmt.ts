/* ────────────────────────────────────────────────────────────────────────────
   Code Studio's formatter, find/replace and line maths.

   PURE. No DOM, no clock. Written here rather than pulled in as a dependency
   because the job is narrow and the failure that matters is destruction: a
   formatter that reflows a template literal or eats a comment has broken the
   file it was asked to tidy. So the contract is deliberately conservative:

   - JSON is parsed and re-serialised. Invalid JSON is an error, never a guess.
   - CSS is re-laid-out completely (one declaration per line), because CSS
     whitespace outside strings is insignificant.
   - JS/TS and HTML are RE-INDENTED, not reflowed. Leading whitespace is
     rewritten from bracket (or tag) depth, trailing whitespace is trimmed,
     runs of blank lines collapse to one. Line breaks are never added or
     removed, so no statement can change meaning, and the inside of a string,
     template literal, block comment, <pre> or <textarea> is never touched.
   ──────────────────────────────────────────────────────────────────────────── */

export type Lang = "js" | "ts" | "css" | "json" | "html";

export type FormatResult = { ok: true; text: string; changed: boolean } | { ok: false; error: string };

export function langFor(path: string): Lang | null {
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  if (ext === "js" || ext === "mjs" || ext === "cjs" || ext === "jsx") return "js";
  if (ext === "ts" || ext === "tsx" || ext === "mts" || ext === "cts") return "ts";
  if (ext === "css") return "css";
  if (ext === "json") return "json";
  if (ext === "html" || ext === "htm") return "html";
  return null;
}

export function formatCode(src: string, lang: Lang, indent = 2): FormatResult {
  const unit = " ".repeat(Math.max(1, Math.min(8, indent)));
  let out: string;
  if (lang === "json") {
    if (!src.trim()) return { ok: true, text: src, changed: false };
    try {
      out = JSON.stringify(JSON.parse(src), null, unit) + "\n";
    } catch (e) {
      return { ok: false, error: `Not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
    }
  } else if (lang === "css") {
    out = finish(formatCss(src, unit, 0));
  } else if (lang === "html") {
    out = finish(reindentHtml(src, unit));
  } else {
    out = finish(reindentScript(src, unit, 0).join("\n"));
  }
  return { ok: true, text: out, changed: out !== src };
}

/** Trim trailing blank lines to exactly one final newline. */
function finish(s: string): string {
  const t = s.replace(/\s+$/, "");
  return t ? t + "\n" : "";
}

/* ── JS / TS ─────────────────────────────────────────────────────────────── */

type Mode = "code" | "sq" | "dq" | "tpl" | "line" | "block" | "regex";

/**
 * Re-indent script lines by bracket depth. `base` is the depth to start at,
 * used when the script is embedded in HTML.
 */
export function reindentScript(src: string, unit: string, base: number): string[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let depth = 0;
  let mode: Mode = "code";
  // Each `${` inside a template literal pushes the brace depth it opened at,
  // so the matching `}` returns to the template rather than closing a block.
  const tplStack: number[] = [];
  let prevSig = ""; // last significant code character, for the regex heuristic
  let blank = 0;

  for (const raw of lines) {
    const startMode = mode;
    const trimmed = raw.trim();
    // A line that begins inside a string, template or block comment belongs to
    // the author; its whitespace is content.
    if (startMode === "tpl" || startMode === "block" || startMode === "sq" || startMode === "dq") {
      out.push(raw.replace(/\s+$/, ""));
    } else if (!trimmed) {
      blank++;
      if (blank <= 1) out.push("");
    } else {
      blank = 0;
      let lead = 0;
      for (const ch of trimmed) {
        if (ch === "}" || ch === ")" || ch === "]") lead++;
        else break;
      }
      const d = Math.max(0, base + depth - Math.min(lead, depth));
      out.push(unit.repeat(d) + trimmed);
    }
    if (trimmed) blank = startMode === "code" ? 0 : blank;

    // Advance the scanner over the whole line.
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      const n = raw[i + 1];
      if (mode === "block") { if (c === "*" && n === "/") { mode = "code"; i++; } continue; }
      if (mode === "sq") { if (c === "\\") i++; else if (c === "'") mode = "code"; continue; }
      if (mode === "dq") { if (c === "\\") i++; else if (c === '"') mode = "code"; continue; }
      if (mode === "regex") {
        if (c === "\\") i++;
        else if (c === "[") { const close = raw.indexOf("]", i + 1); if (close > 0) i = close; }
        else if (c === "/") { mode = "code"; prevSig = "a"; }
        continue;
      }
      if (mode === "tpl") {
        if (c === "\\") i++;
        else if (c === "`") { mode = "code"; prevSig = "a"; }
        else if (c === "$" && n === "{") { tplStack.push(depth); depth++; mode = "code"; i++; }
        continue;
      }
      // code
      if (c === "/" && n === "/") { mode = "line"; break; }
      if (c === "/" && n === "*") { mode = "block"; i++; continue; }
      if (c === "'") { mode = "sq"; continue; }
      if (c === '"') { mode = "dq"; continue; }
      if (c === "`") { mode = "tpl"; continue; }
      if (c === "/") {
        if (prevSig === "" || "(,=:[!&|?{};+-*%<>~^".includes(prevSig)) { mode = "regex"; continue; }
        prevSig = c;
        continue;
      }
      if (c === "{" || c === "(" || c === "[") depth++;
      else if (c === "}" || c === ")" || c === "]") {
        depth = Math.max(0, depth - 1);
        if (c === "}" && tplStack.length && tplStack[tplStack.length - 1] === depth) {
          tplStack.pop();
          mode = "tpl";
          continue;
        }
      }
      if (!/\s/.test(c)) prevSig = /[\w$]/.test(c) ? "a" : c;
    }
    if (mode === "line") mode = "code";
    // Strings do not span lines without a backslash; recover rather than
    // letting one stray quote mis-indent the rest of the file.
    if ((mode === "sq" || mode === "dq") && !/\\$/.test(raw)) mode = "code";
    if (mode === "regex") mode = "code";
  }
  return out;
}

/* ── CSS ─────────────────────────────────────────────────────────────────── */

export function formatCss(src: string, unit: string, base: number): string {
  const out: string[] = [];
  let buf = "";
  let depth = 0;
  let i = 0;
  const pad = () => unit.repeat(base + depth);
  const pushSpace = () => { if (buf && !buf.endsWith(" ")) buf += " "; };

  const declaration = (text: string) => {
    const t = text.trim();
    if (!t) return;
    // Only the property colon is normalised; anything after it (a url with a
    // scheme, a selector-ish value) is left exactly as written.
    const m = depth > 0 && !t.startsWith("@") ? /^([-\w]+)\s*:\s*/.exec(t) : null;
    out.push(pad() + (m ? `${m[1]}: ${t.slice(m[0].length)}` : t));
  };

  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      if (buf.trim()) { buf += src.slice(i, stop); }
      else { out.push(pad() + src.slice(i, stop)); buf = ""; }
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === "\\") j++; j++; }
      buf += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "(") {
      // Parentheses (url(), calc(), :not()) are copied verbatim, semicolons
      // inside a data: url included.
      let d = 0, j = i;
      for (; j < src.length; j++) {
        if (src[j] === "(") d++;
        else if (src[j] === ")") { d--; if (d === 0) break; }
      }
      buf += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (/\s/.test(c)) { pushSpace(); i++; continue; }
    if (c === "{") {
      out.push(pad() + `${buf.trim()} {`);
      buf = "";
      depth++;
      i++;
      continue;
    }
    if (c === ";") {
      declaration(buf + ";");
      buf = "";
      i++;
      continue;
    }
    if (c === "}") {
      if (buf.trim()) declaration(buf.trim().endsWith(";") ? buf : buf.trim() + ";");
      buf = "";
      depth = Math.max(0, depth - 1);
      out.push(pad() + "}");
      if (depth === 0) out.push("");
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  if (buf.trim()) out.push(pad() + buf.trim());
  // Collapse the blank line doubling that back-to-back rules produce.
  return out.filter((l, k) => !(l === "" && out[k - 1] === "")).join("\n");
}

/* ── HTML ────────────────────────────────────────────────────────────────── */

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr", "param"]);
const RAW = new Set(["script", "style", "pre", "textarea"]);

export function reindentHtml(src: string, unit: string): string {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let depth = 0;
  let raw: { tag: string; body: string[]; depth: number } | null = null;
  let inTag = false; // inside a start tag whose attributes span lines
  let inComment = false;
  let blank = 0;
  let pendingTag = "";

  const flushRaw = (closingLine: string) => {
    if (!raw) return;
    const body = raw.body.join("\n");
    let inner: string[];
    if (raw.tag === "script" && body.trim()) inner = reindentScript(body.replace(/^\n+|\s+$/g, ""), unit, raw.depth + 1);
    else if (raw.tag === "style" && body.trim()) inner = formatCss(body, unit, raw.depth + 1).split("\n");
    else inner = raw.body; // pre / textarea: content is content
    out.push(...inner.filter((l, k, a) => !(raw!.tag !== "pre" && raw!.tag !== "textarea" && l === "" && (k === 0 || k === a.length - 1))));
    out.push(unit.repeat(raw.depth) + closingLine.trim());
    raw = null;
  };

  for (const line of lines) {
    if (raw) {
      const closeRe = new RegExp(`</${raw.tag}\\s*>`, "i");
      const m = closeRe.exec(line);
      if (!m) { raw.body.push(line); continue; }
      const before = line.slice(0, m.index);
      if (before.trim()) raw.body.push(before);
      flushRaw(line.slice(m.index));
      continue;
    }
    const t = line.trim();
    if (!t) {
      blank++;
      if (blank <= 1) out.push("");
      continue;
    }
    blank = 0;
    if (inComment) {
      out.push(line.replace(/\s+$/, ""));
      if (t.includes("-->")) inComment = false;
      continue;
    }

    const startsClosing = /^<\//.test(t);
    const d = inTag ? depth + 1 : startsClosing ? Math.max(0, depth - 1) : depth;
    out.push(unit.repeat(d) + t);

    // Walk the tags on this line to move the depth.
    let s = inTag ? "<x " + t : t;
    if (inTag) {
      const close = s.indexOf(">");
      if (close < 0) continue;
      inTag = false;
      const selfClosed = s[close - 1] === "/";
      if (!selfClosed && pendingTag && !VOID.has(pendingTag)) {
        if (RAW.has(pendingTag)) { raw = { tag: pendingTag, body: [s.slice(close + 1)].filter((x) => x.trim()), depth }; pendingTag = ""; continue; }
        depth++;
      }
      pendingTag = "";
      s = s.slice(close + 1);
    }
    const re = /<!--|<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>|<([a-zA-Z][\w:-]*)(?![^<]*>)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      if (m[0] === "<!--") {
        const end = s.indexOf("-->", m.index + 4);
        if (end < 0) { inComment = true; break; }
        re.lastIndex = end + 3;
        continue;
      }
      if (m[5]) { inTag = true; pendingTag = m[5].toLowerCase(); break; }
      const closing = m[1] === "/";
      const tag = m[2].toLowerCase();
      if (closing) { depth = Math.max(0, depth - 1); continue; }
      if (m[4] === "/" || VOID.has(tag)) continue;
      if (RAW.has(tag)) {
        const rest = s.slice(re.lastIndex);
        const closeRe = new RegExp(`</${tag}\\s*>`, "i");
        const cm = closeRe.exec(rest);
        if (cm) { re.lastIndex += cm.index + cm[0].length; continue; } // opened and closed on one line
        raw = { tag, body: rest.trim() ? [rest] : [], depth };
        // Re-emit this line's depth for the closer: raw.depth is the tag's own.
        break;
      }
      depth++;
    }
  }
  if (raw) flushRaw("");
  return out.join("\n");
}

/* ── find / replace ──────────────────────────────────────────────────────── */

export interface FindOptions { caseSensitive?: boolean; regex?: boolean; wholeWord?: boolean }
export interface Match { start: number; end: number }

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function buildRe(query: string, o: FindOptions): RegExp | { error: string } {
  let body = o.regex ? query : escapeRe(query);
  if (o.wholeWord) body = `\\b(?:${body})\\b`;
  try {
    return new RegExp(body, o.caseSensitive ? "g" : "gi");
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Invalid pattern" };
  }
}

export const MAX_MATCHES = 5000;

export function findAll(text: string, query: string, o: FindOptions = {}): { matches: Match[]; error?: string } {
  if (!query) return { matches: [] };
  const re = buildRe(query, o);
  if (!(re instanceof RegExp)) return { matches: [], error: re.error };
  const matches: Match[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && matches.length < MAX_MATCHES) {
    if (m[0].length === 0) { re.lastIndex++; continue; } // an empty match is not a result
    matches.push({ start: m.index, end: m.index + m[0].length });
  }
  return { matches };
}

/** Replace every match. A literal replacement stays literal: `$1` in it is
 *  text unless the search itself is a regex. */
export function replaceAll(text: string, query: string, replacement: string, o: FindOptions = {}): { text: string; count: number; error?: string } {
  if (!query) return { text, count: 0 };
  const re = buildRe(query, o);
  if (!(re instanceof RegExp)) return { text, count: 0, error: re.error };
  let out = "";
  let at = 0;
  let count = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && count < MAX_MATCHES) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    out += text.slice(at, m.index) + (o.regex ? expand(replacement, m) : replacement);
    at = m.index + m[0].length;
    count++;
  }
  return { text: count ? out + text.slice(at) : text, count };
}

/** `$&`, `$1`..`$99` and `$$`, the subset of String.replace patterns people use. */
function expand(rep: string, m: RegExpExecArray): string {
  return rep.replace(/\$(\$|&|\d{1,2})/g, (_all, g: string) => {
    if (g === "$") return "$";
    if (g === "&") return m[0];
    const n = Number(g);
    return n < m.length ? m[n] ?? "" : `$${g}`;
  });
}

/* ── lines ───────────────────────────────────────────────────────────────── */

/** 1-based line and column of an offset. */
export function lineCol(text: string, offset: number): { line: number; col: number } {
  const o = Math.max(0, Math.min(offset, text.length));
  let line = 1, last = -1;
  for (let i = 0; i < o; i++) if (text.charCodeAt(i) === 10) { line++; last = i; }
  return { line, col: o - last };
}

/** Offset of the start of a 1-based line, clamped to the document. */
export function offsetOfLine(text: string, line: number): number {
  if (line <= 1) return 0;
  let seen = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) { seen++; if (seen === line) return i + 1; }
  }
  return text.length;
}

/* ── running JS off the main thread ──────────────────────────────────────── */

/**
 * The source a Worker runs: a console shim that posts every call back, then
 * the user's code inside an async function so top-level `await` works.
 * Messages are `{__ide:1, level, text}` and a final `{__ide:1, done:true}`.
 */
export function workerSource(code: string): string {
  return `(function(){
  function fmt(v){
    if (typeof v === "string") return v;
    if (v && typeof v === "object" && "stack" in v && "message" in v) return String(v.stack || v.message);
    try { var s = JSON.stringify(v); return s === undefined ? String(v) : s; } catch (e) { return String(v); }
  }
  function send(level, args){ try { postMessage({ __ide: 1, level: level, text: Array.prototype.map.call(args, fmt).join(" ") }); } catch (e) {} }
  ["log","info","warn","error","debug"].forEach(function(l){ console[l] = function(){ send(l, arguments); }; });
  if (typeof self !== "undefined" && self.addEventListener) {
    self.addEventListener("unhandledrejection", function(e){ send("error", ["Unhandled rejection: " + fmt(e.reason)]); });
  }
})();
(async function(){
${code}
})().then(
  function(){ postMessage({ __ide: 1, done: true }); },
  function(e){ console.error(e); postMessage({ __ide: 1, done: true, failed: true }); }
);
`;
}

/** Map a line number reported by the Worker back to the user's own line. */
export function userLine(workerLine: number): number {
  const marker = "\u0000line\u0000";
  const offset = workerSource(marker).split("\n").indexOf(marker);
  return Math.max(1, workerLine - offset);
}
