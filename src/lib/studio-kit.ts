/* ────────────────────────────────────────────────────────────────────────────
   AI Studio's build loop: templates, the console bridge that lets a sandboxed
   preview report its own errors, the prompt that feeds those errors back to a
   model, a real line diff, and per-build version history.

   PURE. Ids and clocks are injected. Nothing here renders.

   The bridge is the security-relevant part. A generated app runs in an iframe
   sandboxed WITHOUT allow-same-origin, so it is an opaque origin that cannot
   touch this page. It talks back only by postMessage, and the receiving side
   must check BOTH that the message came from that iframe's window (the caller
   compares event.source) and that it carries the per-run token minted here —
   another frame can forge the shape of a message but not guess the token.
   ──────────────────────────────────────────────────────────────────────────── */

export interface Template {
  id: string;
  title: string;
  blurb: string;
  icon: string;
  target: string;
  prompt: string;
}

export const TEMPLATES: Template[] = [
  { id: "todo", title: "Task board", blurb: "Columns, drag to move, saved in the page.", icon: "tasks", target: "single-html", prompt: "a kanban task board with three columns (To do, Doing, Done), drag and drop between columns, add/edit/delete cards, and everything kept in memory with an export-to-JSON button" },
  { id: "timer", title: "Focus timer", blurb: "Pomodoro rounds with a ring and a log.", icon: "clock", target: "single-html", prompt: "a pomodoro focus timer with a progress ring, configurable work and break lengths, a session log, and a sound made with the Web Audio API when a round ends" },
  { id: "chart", title: "CSV charter", blurb: "Paste CSV, get a chart you can export.", icon: "signals", target: "single-html", prompt: "a CSV-to-chart tool: paste CSV, pick the x and y columns, render a line or bar chart on a canvas with axes and labels, and export the chart as a PNG" },
  { id: "game", title: "Arcade game", blurb: "A canvas game with a score and restart.", icon: "arcade", target: "single-html", prompt: "a small canvas arcade game where you steer a ship to collect stars and dodge asteroids, with keyboard and touch controls, a score, a best score, pause, and a restart button" },
  { id: "notes", title: "Markdown notes", blurb: "Two-pane editor with live preview.", icon: "notes", target: "single-html", prompt: "a markdown notes app with a list of notes, a two-pane editor with live preview, search, and word count" },
  { id: "synth", title: "Tiny synth", blurb: "Keyboard synth on Web Audio.", icon: "media", target: "single-html", prompt: "a polyphonic synth playable with the computer keyboard and on-screen keys, with waveform, attack and release controls and a visual oscilloscope" },
  { id: "react-dash", title: "React dashboard", blurb: "Components, state, a fake-free data table.", icon: "layout", target: "vite-react", prompt: "a React dashboard for a personal budget: a form to add transactions, a sortable table, category totals, and a bar chart drawn with SVG" },
  { id: "three", title: "3D scene", blurb: "A three.js scene you can orbit.", icon: "cube3d", target: "three-scene", prompt: "a three.js scene of a low-poly island with water, a few trees and a lighthouse whose light rotates, with orbit controls" },
];

/* ── the console bridge ──────────────────────────────────────────────────── */

export type ConsoleLevel = "error" | "warn" | "log" | "info";

export interface ConsoleEntry {
  level: ConsoleLevel;
  text: string;
}

export const BRIDGE_KEY = "__studio";

/**
 * Put a script at the very top of the document that forwards console calls,
 * uncaught errors and unhandled rejections to the parent. `parentOrigin` is
 * the only origin the messages are addressed to.
 */
export function injectBridge(html: string, token: string, parentOrigin: string): string {
  const cfg = JSON.stringify({ k: BRIDGE_KEY, t: token, o: parentOrigin || "*" }).replace(/</g, "\\u003c");
  const script = `<script>(function(){var C=${cfg};function f(v){if(typeof v==="string")return v;if(v&&v.stack)return String(v.stack);if(v&&v.message)return String(v.message);try{var s=JSON.stringify(v);return s===undefined?String(v):s}catch(e){return String(v)}}
function s(l,a){try{var m={};m[C.k]=C.t;m.level=l;m.text=Array.prototype.map.call(a,f).join(" ").slice(0,2000);parent.postMessage(m,C.o)}catch(e){}}
["error","warn","log","info"].forEach(function(l){var o=console[l];console[l]=function(){s(l,arguments);try{o&&o.apply(console,arguments)}catch(e){}}});
addEventListener("error",function(e){s("error",[(e.message||"Error")+(e.lineno?" (line "+e.lineno+")":"")])});
addEventListener("unhandledrejection",function(e){s("error",["Unhandled promise rejection: "+f(e.reason)])});})();</script>`;
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + script + html.slice(head.index + head[0].length);
  const top = /<html[^>]*>/i.exec(html) ?? /<!doctype[^>]*>/i.exec(html);
  if (top) return html.slice(0, top.index + top[0].length) + script + html.slice(top.index + top[0].length);
  return script + html;
}

/** Accept a message only if it carries this run's token and a known level. */
export function readBridge(data: unknown, token: string): ConsoleEntry | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d[BRIDGE_KEY] !== token || !token) return null;
  const level = d.level;
  if (level !== "error" && level !== "warn" && level !== "log" && level !== "info") return null;
  return { level, text: typeof d.text === "string" ? d.text.slice(0, 2000) : "" };
}

/** Append, keeping the newest `max` and folding exact repeats (an error in a
 *  render loop fires sixty times a second). */
export function pushConsole(list: readonly (ConsoleEntry & { count: number })[], e: ConsoleEntry, max = 200): (ConsoleEntry & { count: number })[] {
  const last = list[list.length - 1];
  if (last && last.level === e.level && last.text === e.text) {
    return [...list.slice(0, -1), { ...last, count: last.count + 1 }];
  }
  const next = [...list, { ...e, count: 1 }];
  return next.length > max ? next.slice(next.length - max) : next;
}

/**
 * The instruction for a repair pass: the distinct errors, first occurrence
 * first, with warnings only as supporting context. Real error text is far
 * better evidence than "fix bugs".
 */
export function fixPrompt(entries: readonly ConsoleEntry[], maxErrors = 6): string {
  const errors: string[] = [];
  const warns: string[] = [];
  for (const e of entries) {
    const t = e.text.trim().slice(0, 600);
    if (!t) continue;
    if (e.level === "error" && !errors.includes(t)) errors.push(t);
    if (e.level === "warn" && !warns.includes(t)) warns.push(t);
  }
  if (!errors.length) return "";
  const lines = [
    `The app throws ${errors.length === 1 ? "this error" : `these ${Math.min(errors.length, maxErrors)} errors`} when it runs:`,
    "",
    ...errors.slice(0, maxErrors).map((t, i) => `${i + 1}. ${t}`),
  ];
  if (warns.length) lines.push("", "Warnings that may be related:", ...warns.slice(0, 3).map((t) => `- ${t}`));
  lines.push("", "Find the cause of each and fix it. Change nothing else.");
  return lines.join("\n");
}

export const errorCount = (entries: readonly ConsoleEntry[]) => entries.filter((e) => e.level === "error").length;

/* ── a real line diff ────────────────────────────────────────────────────── */

export type DiffOp = "same" | "add" | "del";
export interface DiffLine { op: DiffOp; text: string }

/** Above this many cells the LCS table is not worth building in a UI. */
export const DIFF_CELL_LIMIT = 4_000_000;

/**
 * Line diff by longest common subsequence, after trimming the shared prefix
 * and suffix (which is most of any real edit). Returns null when the middle is
 * too large to diff interactively; the caller shows counts instead.
 */
export function lineDiff(a: string, b: string): DiffLine[] | null {
  const A = a.split("\n");
  const B = b.split("\n");
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a2 = A.slice(pre, A.length - suf);
  const b2 = B.slice(pre, B.length - suf);
  const n = a2.length, m = b2.length;
  if ((n + 1) * (m + 1) > DIFF_CELL_LIMIT) return null;

  // dp[i][j] = LCS length of a2[i:] and b2[j:], flattened.
  const W = m + 1;
  const dp = new Uint32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * W + j] = a2[i] === b2[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
    }
  }
  const out: DiffLine[] = A.slice(0, pre).map((text) => ({ op: "same" as const, text }));
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a2[i] === b2[j]) { out.push({ op: "same", text: a2[i] }); i++; j++; }
    else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) { out.push({ op: "del", text: a2[i] }); i++; }
    else { out.push({ op: "add", text: b2[j] }); j++; }
  }
  while (i < n) out.push({ op: "del", text: a2[i++] });
  while (j < m) out.push({ op: "add", text: b2[j++] });
  for (const text of A.slice(A.length - suf)) out.push({ op: "same", text });
  return out;
}

export function diffStats(d: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const l of d) { if (l.op === "add") added++; else if (l.op === "del") removed++; }
  return { added, removed };
}

/** Only the changed lines plus `context` lines around each, with a gap
 *  marker where unchanged runs were cut. */
export function hunks(d: readonly DiffLine[], context = 2): Array<DiffLine | { op: "gap"; skipped: number }> {
  const keep = new Array(d.length).fill(false);
  d.forEach((l, i) => {
    if (l.op === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(d.length - 1, i + context); k++) keep[k] = true;
  });
  const out: Array<DiffLine | { op: "gap"; skipped: number }> = [];
  let skipped = 0;
  d.forEach((l, i) => {
    if (keep[i]) {
      if (skipped) { out.push({ op: "gap", skipped }); skipped = 0; }
      out.push(l);
    } else skipped++;
  });
  if (skipped && out.length) out.push({ op: "gap", skipped });
  return out;
}

/* ── build history ───────────────────────────────────────────────────────── */

export interface BuildFile { path: string; content: string }

export interface BuildVersion {
  id: string;
  at: number;
  label: string;
  files: BuildFile[];
}

export const MAX_BUILD_VERSIONS = 30;

const sameFiles = (a: readonly BuildFile[], b: readonly BuildFile[]) =>
  a.length === b.length && a.every((f, i) => f.path === b[i].path && f.content === b[i].content);

/**
 * Append a version. A version identical to the newest is not recorded (a
 * pass that changed nothing is not a step). Over the cap, the FIRST version —
 * what the model built before anyone asked it to change anything — is kept
 * and the oldest after it is dropped.
 */
export function pushBuildVersion(list: readonly BuildVersion[], v: BuildVersion, max = MAX_BUILD_VERSIONS): BuildVersion[] {
  const last = list[list.length - 1];
  if (last && sameFiles(last.files, v.files)) return list.slice();
  const next = [...list, v];
  if (next.length <= Math.max(2, max)) return next;
  return [next[0], ...next.slice(next.length - (Math.max(2, max) - 1))];
}

/** The file worth diffing between two versions: the first whose content
 *  differs, preferring index.html. */
export function changedPath(from: readonly BuildFile[], to: readonly BuildFile[]): string | null {
  const before = new Map(from.map((f) => [f.path, f.content]));
  const changed = to.filter((f) => before.get(f.path) !== f.content).map((f) => f.path);
  for (const f of from) if (!to.some((t) => t.path === f.path)) changed.push(f.path);
  if (!changed.length) return null;
  return changed.includes("index.html") ? "index.html" : changed[0];
}
