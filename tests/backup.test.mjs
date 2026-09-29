/* A full backup read back in: the file the Download button writes restores,
   and anything else is refused with a reason instead of half-applied. */
import test from "node:test";
import assert from "node:assert/strict";
import { readBackup, MAX_BACKUP_BYTES } from "../.test-build/backup.js";

// The exact shape Settings > Storage > Download full backup writes.
const settings = { __webaios: 1, version: 1, settings: { themeId: "aurora", ai: { provider: "openai", keys: {} } } };
const nodes = {
  "/documents": { path: "/documents", name: "documents", kind: "dir", content: "", updatedAt: 1 },
  "/documents/a.md": { path: "/documents/a.md", name: "a.md", kind: "file", content: "# hi", updatedAt: 2 },
};
const file = JSON.stringify({ __webaios_backup: 1, at: 1790000000000, settings, vfs: { __webaios_vfs: 1, nodes } });

test("a real backup restores both halves", () => {
  const r = readBackup(file);
  assert.equal(r.ok, true);
  assert.equal(r.files, 2);
  assert.equal(r.at, 1790000000000);
  assert.deepEqual(JSON.parse(r.settings), settings, "the profile goes to importProfile unchanged");
  assert.deepEqual(JSON.parse(r.vfs).nodes, nodes, "the nodes go to vfs.importAll unchanged");
});

test("only one half present still restores that half", () => {
  const r = readBackup(JSON.stringify({ __webaios_backup: 1, vfs: { nodes } }));
  assert.equal(r.ok, true);
  assert.equal(r.settings, null);
  assert.equal(r.files, 2);
});

test("not JSON, not ours, or empty is refused with a reason", () => {
  for (const bad of ["", "{nope", "[]", "null", JSON.stringify({ settings }), JSON.stringify({ __webaios_backup: 2, settings }), JSON.stringify({ __webaios_backup: 1 })]) {
    const r = readBackup(bad);
    assert.equal(r.ok, false, bad);
    assert.ok(r.error.length > 10);
  }
});

test("a settings profile on its own is not mistaken for a full backup", () => {
  assert.equal(readBackup(JSON.stringify(settings)).ok, false);
});

test("junk entries in the filesystem are not counted as files", () => {
  const r = readBackup(JSON.stringify({ __webaios_backup: 1, vfs: { nodes: { a: 1, b: null, c: { content: "x" } } } }));
  assert.equal(r.files, 1);
});

test("a wrong timestamp is dropped, not trusted", () => {
  assert.equal(readBackup(JSON.stringify({ __webaios_backup: 1, at: "soon", vfs: { nodes } })).at, null);
});

test("an absurdly large file is refused before parsing", () => {
  const r = readBackup(" ".repeat(MAX_BACKUP_BYTES + 1));
  assert.equal(r.ok, false);
  assert.match(r.error, /too big/);
});
