/* ────────────────────────────────────────────────────────────────────────────
   Line diff — what changed in a file, line by line.

   Used by Rewind (a snapshot against now) and by the AIOS Chat diff panel.

   Myers' O(ND) algorithm, which is what `git diff` and `diff` use, and which is
   fast exactly where it matters: two versions of a file that differ in a few
   places. Two things keep it safe on the files a person actually has:

   1. The common prefix and suffix are trimmed before the algorithm runs. A
      single edit in a 5,000-line file then diffs two one-line middles.
   2. The number of edits is CAPPED. Myers is O((N+M)·D) in time and keeps one
      row of state per edit; two files that share nothing would otherwise walk
      every diagonal. Past the cap the result is still correct — every old
      line removed, every new line added — and says `truncated`, so the viewer
      can tell the person "too different to line up" instead of freezing.

   PURE. No DOM, no clock.
   ──────────────────────────────────────────────────────────────────────────── */

export type DiffKind = "same" | "add" | "del";

export interface DiffOp {
  kind: DiffKind;
  text: string;
  /** 1-based line in the OLD text; absent for an added line. */
  a?: number;
  /** 1-based line in the NEW text; absent for a removed line. */
  b?: number;
}

export interface DiffResult {
  ops: DiffOp[];
  added: number;
  removed: number;
  /** True when the edit cap was hit and the middle was replaced wholesale. */
  truncated: boolean;
}

export const DEFAULT_MAX_EDITS = 1500;

export const splitLines = (s: string): string[] => (s === "" ? [] : s.replace(/\r\n?/g, "\n").split("\n"));

/**
 * Diff two texts by line.
 *
 * `ops` lists every line of both texts exactly once each (a "same" line
 * counts once for both), in order, so reading the `a` side reproduces the old
 * text and reading the `b` side reproduces the new one. That property is what
 * the tests pin, because it is what makes a diff trustworthy.
 */
export function diffLines(oldText: string, newText: string, opts: { maxEdits?: number } = {}): DiffResult {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const maxEdits = Math.max(1, opts.maxEdits ?? DEFAULT_MAX_EDITS);

  // 1. Common prefix and suffix, which is almost always most of the file.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;

  const midA = a.slice(pre, a.length - suf);
  const midB = b.slice(pre, b.length - suf);

  const ops: DiffOp[] = [];
  for (let i = 0; i < pre; i++) ops.push({ kind: "same", text: a[i], a: i + 1, b: i + 1 });

  let truncated = false;
  const mid = myers(midA, midB, maxEdits);
  if (mid) {
    for (const o of mid) {
      ops.push({
        kind: o.kind,
        text: o.text,
        ...(o.a !== undefined ? { a: o.a + pre + 1 } : {}),
        ...(o.b !== undefined ? { b: o.b + pre + 1 } : {}),
      });
    }
  } else {
    truncated = true;
    midA.forEach((t, i) => ops.push({ kind: "del", text: t, a: pre + i + 1 }));
    midB.forEach((t, i) => ops.push({ kind: "add", text: t, b: pre + i + 1 }));
  }

  for (let i = 0; i < suf; i++) {
    ops.push({ kind: "same", text: a[a.length - suf + i], a: a.length - suf + i + 1, b: b.length - suf + i + 1 });
  }

  let added = 0, removed = 0;
  for (const o of ops) {
    if (o.kind === "add") added++;
    else if (o.kind === "del") removed++;
  }
  return { ops, added, removed, truncated };
}

interface RawOp { kind: DiffKind; text: string; a?: number; b?: number }

/**
 * Myers' greedy shortest-edit-script, with backtracking.
 *
 * Each round stores only the slice of the frontier it can reach (diagonals
 * -d-1..d+1), so memory is about D² integers rather than D·(N+M). Returns null
 * when the script would need more than `maxEdits` edits.
 */
function myers(a: string[], b: string[], maxEdits: number): RawOp[] | null {
  const n = a.length, m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return b.map((t, i) => ({ kind: "add" as const, text: t, b: i }));
  if (m === 0) return a.map((t, i) => ({ kind: "del" as const, text: t, a: i }));

  const max = Math.min(n + m, maxEdits);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Array<{ base: number; row: Int32Array }> = [];

  for (let d = 0; d <= max; d++) {
    // Only diagonals within one of ±d are ever read at round d.
    const lo = Math.max(0, off - d - 1);
    const hi = Math.min(v.length, off + d + 2);
    trace.push({ base: lo, row: v.slice(lo, hi) });

    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace, off);
    }
  }
  return null;
}

function backtrack(a: string[], b: string[], trace: Array<{ base: number; row: Int32Array }>, off: number): RawOp[] {
  const out: RawOp[] = [];
  let x = a.length, y = b.length;
  const at = (t: { base: number; row: Int32Array }, k: number) => t.row[off + k - t.base];

  for (let d = trace.length - 1; d >= 0; d--) {
    const t = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(t, k - 1) < at(t, k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(t, prevK);
    const prevY = d === 0 ? 0 : prevX - prevK;

    while (x > prevX && y > prevY) {
      x--; y--;
      out.push({ kind: "same", text: a[x], a: x, b: y });
    }
    if (d > 0) {
      if (x === prevX) { y--; out.push({ kind: "add", text: b[y], b: y }); }
      else { x--; out.push({ kind: "del", text: a[x], a: x }); }
    }
  }
  return out.reverse();
}

/* ── presentation ────────────────────────────────────────────────────────── */

export interface SideCell {
  n: number;
  text: string;
  kind: DiffKind;
}

export interface SideRow {
  left?: SideCell;
  right?: SideCell;
}

/**
 * Two columns, old on the left and new on the right.
 *
 * A run of removals followed by a run of additions is paired row by row, which
 * is what makes a changed line read as "this became that" instead of a
 * deletion somewhere and an insertion somewhere else.
 */
export function sideBySide(ops: DiffOp[]): SideRow[] {
  const rows: SideRow[] = [];
  let i = 0;
  while (i < ops.length) {
    const o = ops[i];
    if (o.kind === "same") {
      rows.push({ left: { n: o.a!, text: o.text, kind: "same" }, right: { n: o.b!, text: o.text, kind: "same" } });
      i++;
      continue;
    }
    const dels: DiffOp[] = [];
    const adds: DiffOp[] = [];
    while (i < ops.length && ops[i].kind === "del") dels.push(ops[i++]);
    while (i < ops.length && ops[i].kind === "add") adds.push(ops[i++]);
    const len = Math.max(dels.length, adds.length);
    for (let j = 0; j < len; j++) {
      const d = dels[j], ad = adds[j];
      rows.push({
        ...(d ? { left: { n: d.a!, text: d.text, kind: "del" as const } } : {}),
        ...(ad ? { right: { n: ad.b!, text: ad.text, kind: "add" as const } } : {}),
      });
    }
  }
  return rows;
}

export type Collapsed<T> = { kind: "row"; row: T } | { kind: "skip"; count: number };

/**
 * Hide long runs of unchanged rows, keeping `context` rows either side of a
 * change — the "@@" hunks a person expects. A file with no changes collapses to
 * a single skip, which the viewer shows as "identical".
 */
export function collapse<T>(rows: T[], isSame: (r: T) => boolean, context = 3): Array<Collapsed<T>> {
  const keep = new Array<boolean>(rows.length).fill(false);
  rows.forEach((r, i) => {
    if (isSame(r)) return;
    for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) keep[j] = true;
  });
  const out: Array<Collapsed<T>> = [];
  let skip = 0;
  rows.forEach((r, i) => {
    if (keep[i]) {
      if (skip) { out.push({ kind: "skip", count: skip }); skip = 0; }
      out.push({ kind: "row", row: r });
    } else skip++;
  });
  if (skip) out.push({ kind: "skip", count: skip });
  return out;
}

export const rowIsSame = (r: SideRow): boolean => r.left?.kind === "same" && r.right?.kind === "same";
