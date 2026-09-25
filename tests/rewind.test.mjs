/** Rewind: change detection, diffs from the restore's point of view, and
 *  retention that thins old snapshots without losing pinned ones. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprint, diffFiles, diffKeys, prune, formatBytes } from "../.test-build/rewind.js";

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
