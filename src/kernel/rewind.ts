/** Rewind: the storage half of the OS time machine.
 *
 *  Snapshots hold the user's work as data: files, settings, scenes and custom
 *  themes. They live in IndexedDB (localStorage would hit its quota after a
 *  few copies of the file system), with metadata and data in separate stores
 *  so listing never loads every snapshot's files. Diff and retention rules are
 *  pure and tested in lib/rewind.ts.
 */
import { useVFS } from "./vfs";
import { useSettings } from "./settings";
import { useScenes } from "./scenes";
import { useCustomThemes } from "./customthemes";
import { bus } from "./bus";
import { fingerprint, prune, restoreOne, type SnapshotMeta, type RestoreAction } from "@/lib/rewind";

export interface SnapshotInfo extends SnapshotMeta {
  fp: string;
  files: number;
  bytes: number;
}

export interface SnapshotData {
  vfs: ReturnType<typeof useVFS.getState>["nodes"];
  settings: Record<string, unknown>;
  scenes: unknown[];
  themes: unknown[];
}

const DB = "webaios-rewind";
const AUTO_MS = 10 * 60_000;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore("meta", { keyPath: "id" });
      r.result.createObjectStore("data");
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function tx<T>(stores: string[], mode: IDBTransactionMode, run: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
  return open().then((db) => new Promise<T | undefined>((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const req = run(t);
    t.oncomplete = () => { db.close(); resolve(req ? req.result : undefined); };
    t.onerror = () => { db.close(); reject(t.error); };
  }));
}

/** Plain data only: store actions are functions and must not be snapshotted. */
const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function currentData(): SnapshotData {
  return {
    vfs: plain(useVFS.getState().nodes),
    settings: plain(useSettings.getState()) as unknown as Record<string, unknown>,
    scenes: plain(useScenes.getState().scenes),
    themes: plain(useCustomThemes.getState().themes),
  };
}

export async function listSnapshots(): Promise<SnapshotInfo[]> {
  const all = (await tx<SnapshotInfo[]>(["meta"], "readonly", (t) => t.objectStore("meta").getAll())) ?? [];
  return all.sort((a, b) => b.at - a.at);
}

export async function loadSnapshot(id: string): Promise<SnapshotData | undefined> {
  return tx<SnapshotData>(["data"], "readonly", (t) => t.objectStore("data").get(id));
}

let lastFp = "";

/** Take a snapshot unless nothing changed since the last one (or `force`). */
export async function takeSnapshot(label: string, opts: { force?: boolean; pinned?: boolean } = {}): Promise<SnapshotInfo | null> {
  const data = currentData();
  const fp = fingerprint(data as unknown as Record<string, unknown>);
  if (!lastFp) lastFp = (await listSnapshots())[0]?.fp ?? "";
  if (!opts.force && fp === lastFp) return null;
  const files = Object.values(data.vfs).filter((n) => n.kind === "file");
  const info: SnapshotInfo = {
    id: `snap_${Date.now().toString(36)}`, at: Date.now(), label, fp,
    files: files.length, bytes: files.reduce((a, n) => a + (n.size || 0), 0),
    ...(opts.pinned ? { pinned: true } : {}),
  };
  await tx(["meta", "data"], "readwrite", (t) => { t.objectStore("meta").put(info); t.objectStore("data").put(data, info.id); });
  lastFp = fp;
  const doomed = prune(await listSnapshots(), Date.now());
  if (doomed.length) await tx(["meta", "data"], "readwrite", (t) => { for (const id of doomed) { t.objectStore("meta").delete(id); t.objectStore("data").delete(id); } });
  return info;
}

export async function setPinned(id: string, pinned: boolean): Promise<void> {
  const list = await listSnapshots();
  const s = list.find((x) => x.id === id);
  if (s) await tx(["meta"], "readwrite", (t) => { t.objectStore("meta").put({ ...s, pinned }); });
}

/** Restore a snapshot. A pinned "Before restore" snapshot is taken first, so
 *  a restore can itself be undone; its id is returned. */
export async function restoreSnapshot(id: string): Promise<string | null> {
  const data = await loadSnapshot(id);
  if (!data) return null;
  const before = await takeSnapshot("Before restore", { force: true, pinned: true });
  useVFS.setState({ nodes: data.vfs });
  // Merge, not replace: the store's actions are not in the snapshot.
  useSettings.setState(data.settings as Partial<ReturnType<typeof useSettings.getState>>);
  useScenes.setState({ scenes: data.scenes as ReturnType<typeof useScenes.getState>["scenes"] });
  useCustomThemes.setState({ themes: data.themes as ReturnType<typeof useCustomThemes.getState>["themes"] });
  lastFp = fingerprint(currentData() as unknown as Record<string, unknown>);
  bus.emit("notify", { title: "Rewound", body: "Your files, settings, scenes and themes are back to that snapshot. Undo is in Rewind.", kind: "success", target: { appId: "rewind" } });
  return before?.id ?? null;
}

/** Name a snapshot. Naming pins it: a snapshot someone bothered to name is one
 *  they care about, and an unpinned one can be pruned out from under them. */
export async function renameSnapshot(id: string, label: string): Promise<void> {
  const name = label.trim().slice(0, 60);
  if (!name) return;
  const list = await listSnapshots();
  const s = list.find((x) => x.id === id);
  if (s) await tx(["meta"], "readwrite", (t) => { t.objectStore("meta").put({ ...s, label: name, pinned: true }); });
}

/**
 * Put ONE file back as it was in a snapshot, and leave everything else alone.
 *
 * The decision is made by restoreOne in lib/rewind.ts (pure, tested). Like a
 * full restore, the state being replaced is snapshotted and pinned first, so a
 * single-file restore is undoable with the same Undo button. Nothing is written
 * when there is nothing to do.
 */
export async function restoreFile(id: string, path: string): Promise<{ action: RestoreAction; undoId: string | null }> {
  const data = await loadSnapshot(id);
  if (!data) return { action: "missing", undoId: null };
  const r = restoreOne(data.vfs, useVFS.getState().nodes, path);
  if (r.action === "unchanged" || r.action === "missing") return { action: r.action, undoId: null };
  const name = path.split("/").pop() || path;
  const before = await takeSnapshot(`Before restoring ${name}`, { force: true, pinned: true });
  useVFS.setState({ nodes: r.next });
  lastFp = fingerprint(currentData() as unknown as Record<string, unknown>);
  const verb = r.action === "removed" ? "Removed" : "Restored";
  bus.emit("notify", { title: `${verb} ${name}`, body: "Only this file changed. Undo is in Rewind.", kind: "success", target: { appId: "rewind" } });
  return { action: r.action, undoId: before?.id ?? null };
}

let installed = false;

/** One snapshot at start-up and one every ten minutes, each skipped when
 *  nothing changed. Idempotent. */
export function installRewind(): () => void {
  if (installed || typeof indexedDB === "undefined") return () => {};
  installed = true;
  void takeSnapshot("Session start").catch(() => undefined);
  const t = setInterval(() => { void takeSnapshot("Automatic").catch(() => undefined); }, AUTO_MS);
  return () => { installed = false; clearInterval(t); };
}
