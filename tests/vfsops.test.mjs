/* Files: moves, renames, the trash (soft delete) and restore, listings. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  planMove, planRename, planTrash, planRestore, parseTrashPath, trashPathFor, listTrash, uniquePath,
  breadcrumbs, childrenOf, sortEntries, previewKind, imageSrc, isTrashed,
} from "../.test-build/vfsops.js";

const ALL = ["/notes/a.md", "/notes/sub/b.md", "/notes/sub/c.md", "/code/x.ts", "/notesX/y.md"];

test("moving a folder moves its whole subtree and nothing that merely shares a prefix", () => {
  const r = planMove(ALL, "/notes", "/code");
  assert.equal(r.ok, true);
  assert.deepEqual(r.pairs, [
    ["/notes/a.md", "/code/notes/a.md"],
    ["/notes/sub/b.md", "/code/notes/sub/b.md"],
    ["/notes/sub/c.md", "/code/notes/sub/c.md"],
  ]);
});

test("a folder cannot move into itself", () => {
  const r = planMove(ALL, "/notes", "/notes/sub");
  assert.equal(r.ok, false);
  assert.match(r.reason, /into itself/);
});

test("a move never overwrites", () => {
  const r = planMove([...ALL, "/code/a.md"], "/notes/a.md", "/code");
  assert.equal(r.ok, false);
  assert.match(r.reason, /already exists/);
});

test("rename a folder renames its children", () => {
  const r = planRename(ALL, "/notes/sub", "deep");
  assert.deepEqual(r.pairs, [["/notes/sub/b.md", "/notes/deep/b.md"], ["/notes/sub/c.md", "/notes/deep/c.md"]]);
  assert.equal(planRename(ALL, "/notes/a.md", "x/y").ok, false);
});

test("trash path round trip keeps the origin", () => {
  const t = trashPathFor("/notes/a b.md", 1727172000000);
  assert.ok(isTrashed(t));
  const e = parseTrashPath(t);
  assert.equal(e.original, "/notes/a b.md");
  assert.equal(e.trashedAt, 1727172000000);
  assert.equal(parseTrashPath("/notes/a.md"), null);
  assert.equal(parseTrashPath("/.trash/garbage"), null);
});

test("trash then restore is the identity", () => {
  const trash = planTrash(ALL, "/notes/sub", 1000);
  assert.equal(trash.ok, true);
  const after = ALL.map((p) => trash.pairs.find(([f]) => f === p)?.[1] ?? p);
  assert.ok(after.every((p) => !p.startsWith("/notes/sub")));
  const top = listTrash(after);
  assert.equal(top.length, 1);
  assert.equal(top[0].original, "/notes/sub");
  const back = planRestore(after, top[0].path);
  assert.equal(back.ok, true);
  const restored = after.map((p) => back.pairs.find(([f]) => f === p)?.[1] ?? p).sort();
  assert.deepEqual(restored, [...ALL].sort());
});

test("restore beside, never over, something that took the old place", () => {
  const trash = planTrash(ALL, "/notes/a.md", 5);
  const after = [...ALL.filter((p) => p !== "/notes/a.md"), trash.pairs[0][1], "/notes/a.md"];
  const back = planRestore(after, trash.pairs[0][1]);
  assert.equal(back.ok, true);
  assert.equal(back.pairs[0][1], "/notes/a copy.md");
});

test("already-trashed things cannot be trashed again", () => {
  assert.equal(planTrash(["/.trash/1~%2Fa"], "/.trash/1~%2Fa", 2).ok, false);
});

test("uniquePath counts up", () => {
  const s = new Set(["/a.md", "/a copy.md"]);
  assert.equal(uniquePath(s, "/a.md"), "/a copy 2.md");
  assert.equal(uniquePath(s, "/b.md"), "/b.md");
});

test("breadcrumbs", () => {
  assert.deepEqual(breadcrumbs("/notes/sub").map((c) => c.path), ["/", "/notes", "/notes/sub"]);
  assert.deepEqual(breadcrumbs("/").length, 1);
});

test("childrenOf derives implied folders with totals, and hides the trash", () => {
  const nodes = [
    { path: "/notes/a.md", kind: "file", size: 10, updatedAt: 1 },
    { path: "/notes/sub/b.md", kind: "file", size: 5, updatedAt: 9 },
    { path: "/notes/sub/c.md", kind: "file", size: 7, updatedAt: 3 },
    { path: "/.trash/1~%2Fz", kind: "file", size: 1, updatedAt: 1 },
  ];
  const root = childrenOf(nodes, "/");
  assert.deepEqual(root.map((e) => e.name), ["notes"]);
  const kids = childrenOf(nodes, "/notes");
  const sub = kids.find((e) => e.name === "sub");
  assert.equal(sub.kind, "dir");
  assert.equal(sub.size, 12);
  assert.equal(sub.count, 2);
  assert.equal(sub.updatedAt, 9);
  assert.equal(childrenOf(nodes, "/.trash").length, 1, "inside the trash, trash is shown");
});

test("sortEntries: folders first, natural names, size and date both ways", () => {
  const e = (name, kind, size, updatedAt) => ({ name, kind, size, updatedAt, path: "/" + name });
  const list = [e("file10", "file", 1, 3), e("file2", "file", 9, 1), e("zdir", "dir", 0, 0)];
  assert.deepEqual(sortEntries(list, "name", "asc").map((x) => x.name), ["zdir", "file2", "file10"]);
  assert.deepEqual(sortEntries(list, "size", "desc").map((x) => x.name), ["zdir", "file2", "file10"]);
  assert.deepEqual(sortEntries(list, "modified", "desc").map((x) => x.name), ["zdir", "file10", "file2"]);
});

test("preview kinds and image sources", () => {
  assert.equal(previewKind("/a.md", "text/plain", ""), "markdown");
  assert.equal(previewKind("/a.html", "text/html", ""), "html");
  assert.equal(previewKind("/a.svg", "image/svg+xml", "<svg/>"), "image");
  assert.equal(previewKind("/a.ts", "text/typescript", ""), "text");
  assert.match(imageSrc("/a.svg", "<svg xmlns='x'></svg>"), /^data:image\/svg\+xml/);
  assert.equal(imageSrc("/a.png", "https://evil.example/x.png"), null, "the preview never fetches");
  assert.equal(imageSrc("/a.png", "data:image/png;base64,AAAA"), "data:image/png;base64,AAAA");
});
