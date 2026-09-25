/* ────────────────────────────────────────────────────────────────────────────
   Terminal — tokenising, pipes, completion and the text filters.

   `cat /notes/a.md | grep -i todo | wc -l` is split on UNQUOTED pipes only,
   each stage is tokenised with shell-ish quoting ("a b", 'a b', a\ b), and the
   filters below take the previous stage's output as their input.

   PURE. No DOM, no clock, no store — the VFS arrives as a list of paths.
   ──────────────────────────────────────────────────────────────────────────── */

export function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
    } else if (c === '"' || c === "'") { quote = c; has = true; }
    else if (c === "\\" && i + 1 < line.length) { cur += line[++i]; has = true; }
    else if (/\s/.test(c)) { if (has || cur) { out.push(cur); cur = ""; has = false; } }
    else { cur += c; has = true; }
  }
  if (has || cur) out.push(cur);
  return out;
}

export type Pipeline = { ok: true; stages: string[] } | { ok: false; reason: string };

/** Split on `|` outside quotes. `a || b` and a trailing pipe are errors. */
export function splitPipeline(line: string): Pipeline {
  const stages: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === quote) quote = null; cur += c; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === "\\" && i + 1 < line.length) { cur += c + line[++i]; continue; }
    if (c === "|") { stages.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (quote) return { ok: false, reason: "unterminated quote" };
  stages.push(cur.trim());
  if (stages.some((s) => !s)) return { ok: false, reason: "empty stage in pipeline" };
  return { ok: true, stages };
}

/** Resolve a path argument against a working directory, handling `.` and `..`. */
export function resolvePath(cwd: string, p: string): string {
  const parts = (p.startsWith("/") ? p : `${cwd}/${p}`).split("/");
  const out: string[] = [];
  for (const seg of parts) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return "/" + out.join("/");
}

function commonPrefix(list: string[]): string {
  if (!list.length) return "";
  let p = list[0];
  for (const s of list) while (!s.startsWith(p)) p = p.slice(0, -1);
  return p;
}

export interface Completion {
  /** The whole input line with the last word completed as far as it is unambiguous. */
  line: string;
  /** Every candidate when more than one remains; empty when completion was unique. */
  options: string[];
}

/**
 * Complete the word under the cursor (the end of the line). The first word
 * completes against commands; later words against VFS paths, relative to
 * `cwd`, with folders offered with a trailing slash.
 */
export function complete(line: string, commands: string[], paths: string[], cwd: string): Completion {
  const m = /(\S*)$/.exec(line);
  const word = m ? m[1] : "";
  const head = line.slice(0, line.length - word.length);
  const isFirst = head.trim() === "" || /\|\s*$/.test(head);

  let candidates: string[];
  if (isFirst) {
    candidates = [...new Set(commands)].filter((c) => c.startsWith(word)).sort();
  } else {
    const slash = word.lastIndexOf("/");
    const typedDir = slash === -1 ? "" : word.slice(0, slash + 1);
    const partial = word.slice(slash + 1);
    const abs = resolvePath(cwd, typedDir || ".");
    const prefix = abs === "/" ? "/" : abs + "/";
    const names = new Set<string>();
    for (const p of paths) {
      if (!p.startsWith(prefix)) continue;
      const tail = p.slice(prefix.length);
      const seg = tail.split("/")[0];
      if (!seg || !seg.startsWith(partial)) continue;
      names.add(tail.includes("/") ? `${seg}/` : seg);
    }
    candidates = [...names].sort().map((n) => typedDir + n);
  }

  if (!candidates.length) return { line, options: [] };
  if (candidates.length === 1) {
    const c = candidates[0];
    return { line: head + c + (c.endsWith("/") ? "" : " "), options: [] };
  }
  const shared = commonPrefix(candidates);
  return { line: head + (shared.length > word.length ? shared : word), options: candidates };
}

/* ── filters ─────────────────────────────────────────────────────────────── */

export interface Flags { flags: Set<string>; values: Record<string, string>; rest: string[] }

/** `-i -v -n 5 pattern` -> flags {i,v}, values {n: "5"}, rest ["pattern"].
 *  `valued` lists the flags that take the following argument. `-5` is `-n 5`. */
export function parseFlags(args: string[], valued: string[] = []): Flags {
  const flags = new Set<string>();
  const values: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { rest.push(...args.slice(i + 1)); break; }
    if (/^-\d+$/.test(a)) { values.n = a.slice(1); continue; }
    if (/^-[A-Za-z]+$/.test(a)) {
      const letters = a.slice(1).split("");
      for (let j = 0; j < letters.length; j++) {
        const l = letters[j];
        if (valued.includes(l)) {
          const inline = a.slice(j + 2);
          if (inline) { values[l] = inline; break; }
          if (i + 1 < args.length) values[l] = args[++i];
          break;
        }
        flags.add(l);
      }
      continue;
    }
    rest.push(a);
  }
  return { flags, values, rest };
}

const lines = (text: string): string[] => {
  if (!text) return [];
  const ls = text.split("\n");
  if (ls[ls.length - 1] === "") ls.pop();
  return ls;
};

export interface GrepOpts { ignoreCase?: boolean; invert?: boolean; count?: boolean; lineNumbers?: boolean }

/** Fixed-string or regex grep. A pattern that is not a valid regex is matched literally. */
export function grepText(text: string, pattern: string, o: GrepOpts = {}): string {
  let re: RegExp;
  try { re = new RegExp(pattern, o.ignoreCase ? "i" : ""); }
  catch { re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), o.ignoreCase ? "i" : ""); }
  const hits: string[] = [];
  lines(text).forEach((l, i) => {
    if (re.test(l) !== Boolean(o.invert)) hits.push(o.lineNumbers ? `${i + 1}:${l}` : l);
  });
  return o.count ? String(hits.length) : hits.join("\n");
}

export function wcText(text: string): { lines: number; words: number; chars: number } {
  return {
    lines: text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0,
    words: text.split(/\s+/).filter(Boolean).length,
    chars: [...text].length,
  };
}

export const headText = (text: string, n = 10): string => lines(text).slice(0, Math.max(0, n)).join("\n");
export const tailText = (text: string, n = 10): string => (n <= 0 ? "" : lines(text).slice(-n).join("\n"));

export function sortText(text: string, o: { reverse?: boolean; numeric?: boolean; unique?: boolean } = {}): string {
  let ls = lines(text);
  ls.sort((a, b) => (o.numeric ? parseFloat(a) - parseFloat(b) || a.localeCompare(b) : a.localeCompare(b)));
  if (o.reverse) ls.reverse();
  if (o.unique) ls = ls.filter((l, i) => i === 0 || l !== ls[i - 1]);
  return ls.join("\n");
}

/** A `tree` drawing of the paths under `root`, folders first. ASCII only. */
export function treeText(paths: string[], root: string, maxDepth = 6): { text: string; dirs: number; files: number } {
  const r = root === "/" ? "" : root.replace(/\/+$/, "");
  type T = { children: Map<string, T> };
  const top: T = { children: new Map() };
  for (const p of paths) {
    if (r && !p.startsWith(r + "/")) continue;
    const segs = p.slice(r.length + 1).split("/").filter(Boolean);
    let cur = top;
    for (const s of segs) {
      if (!cur.children.has(s)) cur.children.set(s, { children: new Map() });
      cur = cur.children.get(s)!;
    }
  }
  let dirs = 0, files = 0;
  const out: string[] = [root || "/"];
  const walk = (t: T, pre: string, depth: number) => {
    const entries = [...t.children.entries()].sort(([a, x], [b, y]) => {
      const ad = x.children.size > 0 ? 0 : 1, bd = y.children.size > 0 ? 0 : 1;
      return ad - bd || a.localeCompare(b);
    });
    entries.forEach(([name, child], i) => {
      const last = i === entries.length - 1;
      const isDir = child.children.size > 0;
      if (isDir) dirs++; else files++;
      out.push(`${pre}${last ? "`-- " : "|-- "}${name}${isDir ? "/" : ""}`);
      if (isDir && depth < maxDepth) walk(child, pre + (last ? "    " : "|   "), depth + 1);
    });
  };
  walk(top, "", 1);
  return { text: out.join("\n"), dirs, files };
}

/** `*.md`, `note-?`, plain substrings. Case-insensitive. */
export function globMatch(name: string, glob: string): boolean {
  if (!/[*?]/.test(glob)) return name.toLowerCase().includes(glob.toLowerCase());
  const re = new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
  return re.test(name);
}
