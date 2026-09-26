/** Rewind: change detection, diffs from the restore's point of view, and
 *  retention that thins old snapshots without losing pinned ones. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprint, diffFiles, diffKeys, prune, formatBytes, restoreOne, ancestors } from "../.test-build/rewind.js";

test("fingerprint ignores key order and functions, and sees real changes", () => {
  assert.equal(fingerprint({ a: 1, b: { c: 2, d: 3 } }), fingerprint({ b: { d: 3, c: 2 }, a: 1 }));
  assert.equal(fingerprint({ a: 1, f: () => 1 }), fingerprint({ a: 1 }));
  assert.notEqual(fingerprint({ a: 1 }), fingerprint({ a: 2 }));
});

test("diff is from the restore's side: added comes back, removed would disappear", () => {
  const then = { "/a.md": { size: 3, updatedAt: 1, content: "abc" }, "/b.md": { size: 2, updatedAt: 1, content: "hi" }, "/dir": { size: 0, updatedAt: 1, kind: "dir" } };
  const now = { "/b.md": { size: 5, updatedAt: 9, content: "hello" }, "/c.md": { size: 4, updatedAt: 9, content: "new!" } };
  const d = diffFiles(then, now);
  assert.deepEqual(d.added, [{ path: "/a.md", size: 3 }]);
  assert.deepEqual(d.removed, [{ path: "/c.md", size: 4 }]);
  assert.deepEqual(d.changed, [{ path: "/b.md", from: 5, to: 2 }]);
  assert.equal(d.bytesDelta, 5 - 9);
});

test("same size, different content is still a change", () => {
  const d = diffFiles({ "/x": { size: 2, updatedAt: 1, content: "ab" } }, { "/x": { size: 2, updatedAt: 1, content: "cd" } });
  assert.equal(d.changed.length, 1);
});

test("diffKeys lists only changed state keys", () => {
  assert.deepEqual(diffKeys({ theme: "a", wall: "x", set: () => 0 }, { theme: "b", wall: "x", set: () => 1 }), ["theme"]);
});

test("prune keeps pinned and recent, thins by hour then day, and caps", () => {
  const H = 3_600_000, NOW = 100 * 24 * H;
  const list = [
    { id: "pin", at: NOW - 30 * 24 * H, label: "", pinned: true },
    { id: "r1", at: NOW - 10 * 60_000, label: "" },
    { id: "r2", at: NOW - 70 * 60_000, label: "" },
    { id: "h5a", at: NOW - 5 * H - 60_000, label: "" },
    { id: "h5b", at: NOW - 5 * H - 120_000, label: "" },
    { id: "old", at: NOW - 20 * 24 * H, label: "" },
  ];
  const del = prune(list, NOW);
  assert.ok(!del.includes("pin") && !del.includes("r1") && !del.includes("r2"));
  assert.equal(["h5a", "h5b"].filter((x) => del.includes(x)).length, 1, "one per hour bucket");
  assert.ok(!del.includes("h5a"), "the newest in a bucket survives");
  assert.ok(del.includes("old"), "past two weeks and unpinned");
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, at: NOW - i * 60_000, label: "" }));
  assert.equal(prune(many, NOW, 10).length, 20);
});

test("formatBytes", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(-2048), "-2.0 KB");
});

/* ── restoring one file ──────────────────────────────────────────────────── */

const node = (path, content, extra = {}) => ({ path, kind: "file", content, size: content.length, updatedAt: 1, ...extra });
const dir = (path) => ({ path, kind: "dir", content: "", size: 0, updatedAt: 1 });

test("ancestors lists every parent folder, outermost first", () => {
  assert.deepEqual(ancestors("/a/b/c.txt"), ["/a", "/a/b"]);
  assert.deepEqual(ancestors("/c.txt"), []);
});

test("a changed file is replaced and nothing else moves", () => {
  const then = { "/a.txt": node("/a.txt", "old"), "/b.txt": node("/b.txt", "b then") };
  const now = { "/a.txt": node("/a.txt", "new"), "/b.txt": node("/b.txt", "b now"), "/c.txt": node("/c.txt", "c") };
  const r = restoreOne(then, now, "/a.txt");
  assert.equal(r.action, "replaced");
  assert.equal(r.next["/a.txt"].content, "old");
  // Every other key is exactly the current one: restoring a file is not a
  // restore of the snapshot.
  assert.equal(r.next["/b.txt"], now["/b.txt"]);
  assert.equal(r.next["/c.txt"], now["/c.txt"]);
  assert.deepEqual(Object.keys(r.next).sort(), Object.keys(now).sort());
});

test("a deleted file comes back WITH the folders it lived in", () => {
  // Restoring only the file node would leave it under a parent the file
  // system no longer has, and Files would not show it.
  const then = { "/docs": dir("/docs"), "/docs/notes": dir("/docs/notes"), "/docs/notes/x.md": node("/docs/notes/x.md", "hi") };
  const now = { "/other.txt": node("/other.txt", "o") };
  const r = restoreOne(then, now, "/docs/notes/x.md");
  assert.equal(r.action, "created");
  assert.ok(r.next["/docs"] && r.next["/docs/notes"], "the parents come back");
  assert.equal(r.next["/docs/notes/x.md"].content, "hi");
  assert.equal(r.next["/other.txt"], now["/other.txt"]);
});

test("a folder that still exists is not overwritten by the snapshot's copy", () => {
  const then = { "/d": dir("/d"), "/d/f": node("/d/f", "then") };
  const nowDir = { ...dir("/d"), starred: true };
  const now = { "/d": nowDir };
  const r = restoreOne(then, now, "/d/f");
  assert.equal(r.next["/d"], nowDir, "the current folder, with its star, is kept");
});

test("a file that did not exist in the snapshot is removed", () => {
  const r = restoreOne({ "/a": node("/a", "a") }, { "/a": node("/a", "a"), "/new": node("/new", "n") }, "/new");
  assert.equal(r.action, "removed");
  assert.ok(!("/new" in r.next));
  assert.ok("/a" in r.next);
});

test("an identical file is unchanged and returns the same object", () => {
  const now = { "/a": node("/a", "same") };
  const r = restoreOne({ "/a": node("/a", "same") }, now, "/a");
  assert.equal(r.action, "unchanged");
  assert.equal(r.next, now, "no new object, so no store update and no re-render");
});

test("a path in neither is reported missing", () => {
  const now = { "/a": node("/a", "x") };
  const r = restoreOne({}, now, "/nope");
  assert.equal(r.action, "missing");
  assert.equal(r.next, now);
});

test("restoreOne never mutates either input", () => {
  const then = { "/a": node("/a", "then") };
  const now = { "/a": node("/a", "now"), "/b": node("/b", "b") };
  const thenCopy = JSON.stringify(then), nowCopy = JSON.stringify(now);
  restoreOne(then, now, "/a");
  restoreOne(then, now, "/b");
  assert.equal(JSON.stringify(then), thenCopy);
  assert.equal(JSON.stringify(now), nowCopy);
});
