/* Rewind: the pure half of an OS-wide time machine.

   A snapshot is the user's work as data: files, settings, scenes, custom
   themes. This module decides three things without touching storage: whether
   anything changed since the last snapshot (so an idle desktop does not fill
   the disk with copies of itself), what differs between two snapshots, and
   which snapshots to keep as they age.

   Pure: no clock, no DOM, no storage. */

export interface FileEntry {
  size: number;
  updatedAt: number;
  kind?: "file" | "dir";
  content?: string;
}

export interface SnapshotMeta {
  id: string;
  at: number;
  label: string;
  /** Kept whatever their age. The pre-restore snapshot is pinned. */
  pinned?: boolean;
}

/** FNV-1a over a string, as 8 hex digits. Change detection, not security. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** A fingerprint of the parts a snapshot holds. Keys are sorted so the same
 *  state always prints the same way, whatever order the stores hold it in. */
export function fingerprint(parts: Record<string, unknown>): string {
  return fnv1a(stableJson(parts));
}

export function stableJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined && typeof o[k] !== "function").sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
}

export interface FileDiff {
  added: Array<{ path: string; size: number }>;
  removed: Array<{ path: string; size: number }>;
  changed: Array<{ path: string; from: number; to: number }>;
  /** Net bytes, then minus now. */
  bytesDelta: number;
}

/** What differs between `then` and `now`, from the point of view of restoring
 *  `then`: "removed" are files that exist now and would disappear. */
export function diffFiles(then: Record<string, FileEntry>, now: Record<string, FileEntry>): FileDiff {
  const out: FileDiff = { added: [], removed: [], changed: [], bytesDelta: 0 };
  const isFile = (e: FileEntry) => (e.kind ?? "file") === "file";
  for (const [path, e] of Object.entries(then)) {
    if (!isFile(e)) continue;
    const cur = now[path];
    if (!cur || !isFile(cur)) out.added.push({ path, size: e.size });
    else if (cur.size !== e.size || (e.content !== undefined && cur.content !== undefined ? cur.content !== e.content : cur.updatedAt !== e.updatedAt)) {
      out.changed.push({ path, from: cur.size, to: e.size });
    }
  }
  for (const [path, e] of Object.entries(now)) {
    if (isFile(e) && !(path in then)) out.removed.push({ path, size: e.size });
  }
  const sum = (m: Record<string, FileEntry>) => Object.values(m).filter(isFile).reduce((a, e) => a + e.size, 0);
  out.bytesDelta = sum(then) - sum(now);
  for (const list of [out.added, out.removed, out.changed]) list.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/** Top-level keys whose values differ. Functions are ignored: they are store
 *  actions, not state. */
export function diffKeys(then: Record<string, unknown>, now: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(then), ...Object.keys(now)]);
  return [...keys]
    .filter((k) => typeof then[k] !== "function" && typeof now[k] !== "function")
    .filter((k) => stableJson(then[k]) !== stableJson(now[k]))
    .sort();
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Which snapshots to keep: every pinned one; everything from the last two
 *  hours; then the newest per hour for a day, the newest per day for two
 *  weeks; and never more than `max` unpinned. Returns ids to DELETE. */
export function prune(list: SnapshotMeta[], now: number, max = 48): string[] {
  const keep = new Set<string>();
  const newestFirst = [...list].sort((a, b) => b.at - a.at);
  const seen = new Set<string>();
  for (const s of newestFirst) {
    const age = now - s.at;
    if (s.pinned || age < 2 * HOUR) { keep.add(s.id); continue; }
    const bucket = age < DAY ? `h${Math.floor(s.at / HOUR)}` : age < 14 * DAY ? `d${Math.floor(s.at / DAY)}` : null;
    if (bucket && !seen.has(bucket)) { seen.add(bucket); keep.add(s.id); }
  }
  let unpinned = newestFirst.filter((s) => keep.has(s.id) && !s.pinned);
  if (unpinned.length > max) {
    for (const s of unpinned.slice(max)) keep.delete(s.id);
    unpinned = unpinned.slice(0, max);
  }
  return list.filter((s) => !keep.has(s.id)).map((s) => s.id);
}

export function formatBytes(n: number): string {
  const a = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (a < 1024) return `${sign}${a} B`;
  if (a < 1024 * 1024) return `${sign}${(a / 1024).toFixed(1)} KB`;
  return `${sign}${(a / 1048576).toFixed(1)} MB`;
}

/* ── restoring one file ──────────────────────────────────────────────────── */

export type RestoreAction = "created" | "replaced" | "removed" | "unchanged" | "missing";

/** The ancestor paths of `path`, outermost first: "/a/b/c.txt" -> ["/a", "/a/b"]. */
export function ancestors(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(`/${parts.slice(0, i).join("/")}`);
  return out;
}

/**
 * Put ONE path back the way it was in a snapshot, leaving everything else as
 * it is now.
 *
 * Three real cases, and the one that is easy to get wrong is the first: a file
 * that comes back into a folder that has since been deleted. Restoring only the
 * file node would leave it under a parent the file system has no node for, so
 * Files would not show it. Any ancestor folder missing now but present in the
 * snapshot comes back with it. Nothing outside `path` and those ancestors is
 * touched, which the tests check against every other key.
 *
 * - created:   in the snapshot, not now
 * - replaced:  in both, and different
 * - removed:   not in the snapshot, but exists now (restoring means deleting it)
 * - unchanged: identical in both, so there is nothing to do
 * - missing:   in neither
 */
export function restoreOne<N extends FileEntry>(
  then: Record<string, N>,
  now: Record<string, N>,
  path: string,
): { next: Record<string, N>; action: RestoreAction } {
  const was = then[path];
  const is = now[path];
  if (!was && !is) return { next: now, action: "missing" };
  if (!was) {
    const next = { ...now };
    delete next[path];
    return { next, action: "removed" };
  }
  if (is && stableJson(is) === stableJson(was)) return { next: now, action: "unchanged" };
  const next = { ...now, [path]: was };
  for (const a of ancestors(path)) {
    if (!next[a] && then[a]) next[a] = then[a];
  }
  return { next, action: is ? "replaced" : "created" };
}
