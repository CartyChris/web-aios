/* ────────────────────────────────────────────────────────────────────────────
   File operations over the flat, path-addressed VFS — planned here, applied
   by the caller one `rename` at a time.

   The VFS is a map of path -> node, so "move a folder" is really "rename every
   node at or under that path". Getting that subtree right, refusing to move a
   folder into itself, and refusing to overwrite are the parts that go wrong,
   so they are planned purely and tested.

   TRASH IS A PATH, NOT A FLAG. A trashed node lives at
     /.trash/<stamp36>~<encodeURIComponent(original path)>[/rest]
   so its origin survives a reload without a new store field, and restoring is
   the inverse rename. Nothing here ever plans a permanent delete.

   PURE. No DOM, no clock — `stamp` is passed in.
   ──────────────────────────────────────────────────────────────────────────── */

export const TRASH = "/.trash";

export const normPath = (p: string): string => "/" + p.replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
export const dirOf = (p: string): string => {
  const parts = normPath(p).split("/");
  parts.pop();
  return parts.join("/") || "/";
};
export const baseName = (p: string): string => normPath(p).split("/").pop() || "/";
export const joinPath = (dir: string, name: string): string => normPath(`${dir}/${name}`);

export const isUnder = (path: string, root: string): boolean => {
  const p = normPath(path), r = normPath(root);
  return r === "/" ? true : p === r || p.startsWith(r + "/");
};

export const isTrashed = (path: string): boolean => isUnder(path, TRASH);

export type Plan = { ok: true; pairs: Array<[string, string]> } | { ok: false; reason: string };

/** Every existing path at or below `root`, paired with where it goes. */
function subtree(all: string[], root: string, dest: string): Array<[string, string]> {
  const r = normPath(root), d = normPath(dest);
  return all
    .map(normPath)
    .filter((p) => p === r || p.startsWith(r + "/"))
    .sort()
    .map((p) => [p, d + p.slice(r.length)] as [string, string]);
}

function checkCollisions(all: string[], pairs: Array<[string, string]>): string | null {
  const moving = new Set(pairs.map(([f]) => f));
  const existing = new Set(all.map(normPath));
  for (const [, to] of pairs) if (existing.has(to) && !moving.has(to)) return `${to} already exists.`;
  return null;
}

/** Move `from` (a file or a folder, explicit or implied) into `toDir`. */
export function planMove(all: string[], from: string, toDir: string): Plan {
  const f = normPath(from), d = normPath(toDir);
  if (f === "/") return { ok: false, reason: "The root folder cannot be moved." };
  if (isUnder(d, f)) return { ok: false, reason: "A folder cannot be moved into itself." };
  if (dirOf(f) === d) return { ok: false, reason: "It is already there." };
  const pairs = subtree(all, f, joinPath(d, baseName(f)));
  if (!pairs.length) return { ok: false, reason: `${f} does not exist.` };
  const clash = checkCollisions(all, pairs);
  return clash ? { ok: false, reason: clash } : { ok: true, pairs };
}

/** Rename in place: same folder, new last segment. */
export function planRename(all: string[], from: string, newName: string): Plan {
  const name = newName.trim();
  if (!name || name.includes("/")) return { ok: false, reason: "A name cannot be empty or contain a slash." };
  const f = normPath(from);
  const to = joinPath(dirOf(f), name);
  if (to === f) return { ok: false, reason: "That is already its name." };
  const pairs = subtree(all, f, to);
  if (!pairs.length) return { ok: false, reason: `${f} does not exist.` };
  const clash = checkCollisions(all, pairs);
  return clash ? { ok: false, reason: clash } : { ok: true, pairs };
}

export function trashPathFor(path: string, stamp: number): string {
  return `${TRASH}/${Math.max(0, Math.floor(stamp)).toString(36)}~${encodeURIComponent(normPath(path))}`;
}

export interface TrashEntry {
  /** The top-level trash path, e.g. /.trash/k3x~%2Fnotes%2Fa.md */
  path: string;
  original: string;
  trashedAt: number;
}

/** Decode a top-level trash entry, or null for anything that is not one. */
export function parseTrashPath(path: string): TrashEntry | null {
  const p = normPath(path);
  if (!p.startsWith(TRASH + "/")) return null;
  const seg = p.slice(TRASH.length + 1).split("/")[0];
  const m = /^([0-9a-z]+)~(.+)$/.exec(seg);
  if (!m) return null;
  let original: string;
  try { original = decodeURIComponent(m[2]); } catch { return null; }
  if (!original.startsWith("/")) return null;
  return { path: `${TRASH}/${seg}`, original: normPath(original), trashedAt: parseInt(m[1], 36) };
}

/** Soft delete: move a file or folder subtree into the trash. */
export function planTrash(all: string[], path: string, stamp: number): Plan {
  const f = normPath(path);
  if (f === "/" || f === TRASH) return { ok: false, reason: "That cannot be moved to the trash." };
  if (isTrashed(f)) return { ok: false, reason: "It is already in the trash." };
  const pairs = subtree(all, f, trashPathFor(f, stamp));
  if (!pairs.length) return { ok: false, reason: `${f} does not exist.` };
  const clash = checkCollisions(all, pairs);
  return clash ? { ok: false, reason: clash } : { ok: true, pairs };
}

/** Put a trashed entry back where it came from — or beside it, renamed, when
 *  something new has taken its place meanwhile. Never overwrites. */
export function planRestore(all: string[], trashPath: string): Plan {
  const e = parseTrashPath(trashPath);
  if (!e) return { ok: false, reason: "That is not a trash entry." };
  const existing = new Set(all.map(normPath));
  const dest = existing.has(e.original) || [...existing].some((p) => p.startsWith(e.original + "/"))
    ? uniquePath(existing, e.original)
    : e.original;
  const pairs = subtree(all, e.path, dest);
  if (!pairs.length) return { ok: false, reason: "That trash entry is empty." };
  const clash = checkCollisions(all, pairs);
  return clash ? { ok: false, reason: clash } : { ok: true, pairs };
}

/** Top-level trash entries, newest first. */
export function listTrash(all: string[]): TrashEntry[] {
  const seen = new Map<string, TrashEntry>();
  for (const p of all) {
    const e = parseTrashPath(p);
    if (e && !seen.has(e.path)) seen.set(e.path, e);
  }
  return [...seen.values()].sort((a, b) => b.trashedAt - a.trashedAt);
}

/** "a.md" -> "a copy.md" -> "a copy 2.md", first free one. */
export function uniquePath(existing: Set<string>, path: string): string {
  const p = normPath(path);
  const dir = dirOf(p);
  const name = baseName(p);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  const taken = (q: string) => existing.has(q) || [...existing].some((x) => x.startsWith(q + "/"));
  if (!taken(p)) return p;
  for (let i = 1; i < 10_000; i++) {
    const cand = joinPath(dir, `${stem} copy${i === 1 ? "" : ` ${i}`}${ext}`);
    if (!taken(cand)) return cand;
  }
  return joinPath(dir, `${stem} copy ${existing.size + 1}${ext}`);
}

export interface Crumb { label: string; path: string }

export function breadcrumbs(dir: string): Crumb[] {
  const d = normPath(dir);
  const out: Crumb[] = [{ label: "/", path: "/" }];
  if (d === "/") return out;
  let acc = "";
  for (const seg of d.slice(1).split("/")) {
    acc += `/${seg}`;
    out.push({ label: seg, path: acc });
  }
  return out;
}

export interface EntryNode { path: string; kind: "file" | "dir"; size: number; updatedAt: number }

export interface DirEntry {
  path: string;
  name: string;
  kind: "file" | "dir";
  size: number;
  updatedAt: number;
  /** Files at any depth below a folder. */
  count: number;
}

/**
 * The immediate children of `dir`, including folders that exist only because
 * a file lives under them (the VFS does not require an explicit mkdir).
 * Folders carry the total size and newest mtime of what is inside.
 */
export function childrenOf(nodes: EntryNode[], dir: string, opts: { showTrash?: boolean } = {}): DirEntry[] {
  const d = normPath(dir);
  const prefix = d === "/" ? "/" : d + "/";
  const dirs = new Map<string, DirEntry>();
  const files: DirEntry[] = [];
  for (const n of nodes) {
    const p = normPath(n.path);
    if (!p.startsWith(prefix) || p === d) continue;
    if (!opts.showTrash && isTrashed(p) && !isUnder(d, TRASH)) continue;
    const tail = p.slice(prefix.length);
    const slash = tail.indexOf("/");
    if (slash === -1) {
      if (n.kind === "dir") {
        if (!dirs.has(p)) dirs.set(p, { path: p, name: tail, kind: "dir", size: 0, updatedAt: n.updatedAt, count: 0 });
      } else files.push({ path: p, name: tail, kind: "file", size: n.size, updatedAt: n.updatedAt, count: 1 });
    } else {
      const sub = prefix + tail.slice(0, slash);
      const e = dirs.get(sub) ?? { path: sub, name: tail.slice(0, slash), kind: "dir" as const, size: 0, updatedAt: 0, count: 0 };
      if (n.kind === "file") { e.size += n.size; e.count += 1; }
      e.updatedAt = Math.max(e.updatedAt, n.updatedAt);
      dirs.set(sub, e);
    }
  }
  return [...dirs.values(), ...files];
}

export type SortKey = "name" | "modified" | "size";

/** Folders first, always; then by the key. Name order is natural ("file2" < "file10"). */
export function sortEntries<T extends { name: string; kind: "file" | "dir"; size: number; updatedAt: number }>(
  list: T[], key: SortKey, dir: "asc" | "desc",
): T[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...list].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    let c = 0;
    if (key === "size") c = a.size - b.size;
    else if (key === "modified") c = a.updatedAt - b.updatedAt;
    if (c === 0) c = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    return c * sign;
  });
}

/** What the preview pane can show for a path + mime. */
export type PreviewKind = "markdown" | "html" | "image" | "text";

export function previewKind(path: string, mime: string, content: string): PreviewKind {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (mime.includes("markdown") || ext === "md") return "markdown";
  if (mime.includes("html") || ext === "html" || ext === "htm") return "html";
  if (mime.startsWith("image/") || /^data:image\//.test(content.trim()) || ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "image";
  return "text";
}

/** An <img> src for an image node: a data URL as stored, or SVG text encoded.
 *  Anything else (raw binary text, an http URL) returns null — the preview
 *  does not fetch. */
export function imageSrc(path: string, content: string): string | null {
  const c = content.trim();
  if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml)[;,]/i.test(c)) return c;
  if (/\.svg$/i.test(path) && c.startsWith("<svg")) return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(c)}`;
  return null;
}
