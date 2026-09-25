/* Terminal: tokenising, pipes, completion and the text filters. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  tokenize, splitPipeline, resolvePath, complete, parseFlags, grepText, wcText, headText, tailText, sortText, treeText, globMatch,
} from "../.test-build/shellparse.js";

test("tokenize honours quotes and escapes", () => {
  assert.deepEqual(tokenize(`write "a b.md" 'it''s' x\\ y`), ["write", "a b.md", "its", "x y"]);
  assert.deepEqual(tokenize(`echo ""`), ["echo", ""]);
  assert.deepEqual(tokenize("  ls   /notes  "), ["ls", "/notes"]);
});

test("pipes split only outside quotes", () => {
  assert.deepEqual(splitPipeline(`cat a | grep "x|y" | wc -l`), { ok: true, stages: ["cat a", `grep "x|y"`, "wc -l"] });
  assert.equal(splitPipeline("cat a |").ok, false);
  assert.equal(splitPipeline("cat a || b").ok, false);
  assert.equal(splitPipeline(`echo "open`).ok, false);
});

test("resolvePath", () => {
  assert.equal(resolvePath("/notes", "../code/./x.ts"), "/code/x.ts");
  assert.equal(resolvePath("/notes", "/abs"), "/abs");
  assert.equal(resolvePath("/", ".."), "/");
});

const PATHS = ["/notes/alpha.md", "/notes/alpine.md", "/notes/sub/b.md", "/code/x.ts"];
const CMDS = ["cat", "cd", "clear", "grep", "ls"];

test("completion: commands first word, common prefix when ambiguous", () => {
  assert.deepEqual(complete("gr", CMDS, PATHS, "/"), { line: "grep ", options: [] });
  const c = complete("c", CMDS, PATHS, "/");
  assert.equal(c.line, "c");
  assert.deepEqual(c.options, ["cat", "cd", "clear"]);
});

test("completion: paths relative to cwd, folders keep the slash", () => {
  assert.deepEqual(complete("cat no", CMDS, PATHS, "/"), { line: "cat notes/", options: [] });
  const c = complete("cat al", CMDS, PATHS, "/notes");
  assert.equal(c.line, "cat alp");
  assert.deepEqual(c.options, ["alpha.md", "alpine.md"]);
  assert.deepEqual(complete("cat /notes/s", CMDS, PATHS, "/"), { line: "cat /notes/sub/", options: [] });
  assert.deepEqual(complete("cat ../code/", CMDS, PATHS, "/notes"), { line: "cat ../code/x.ts ", options: [] });
});

test("completion after a pipe is a command again", () => {
  assert.equal(complete("cat a | gr", CMDS, PATHS, "/").line, "cat a | grep ");
});

test("flags", () => {
  const f = parseFlags(["-iv", "-n", "5", "pat", "file"], ["n"]);
  assert.deepEqual([...f.flags].sort(), ["i", "v"]);
  assert.equal(f.values.n, "5");
  assert.deepEqual(f.rest, ["pat", "file"]);
  assert.equal(parseFlags(["-3"]).values.n, "3");
  assert.deepEqual(parseFlags(["--", "-x"]).rest, ["-x"]);
});

const TEXT = "alpha\nBeta\ngamma alpha\ndelta\n";

test("grep: regex, -i, -v, -c, -n, bad regex matched literally", () => {
  assert.equal(grepText(TEXT, "alpha"), "alpha\ngamma alpha");
  assert.equal(grepText(TEXT, "beta", { ignoreCase: true }), "Beta");
  assert.equal(grepText(TEXT, "a$", { invert: true }), "");
  assert.equal(grepText(TEXT, "alpha", { count: true }), "2");
  assert.equal(grepText(TEXT, "delta", { lineNumbers: true }), "4:delta");
  assert.equal(grepText("a(b\nc", "a(b"), "a(b");
});

test("wc, head, tail, sort", () => {
  assert.deepEqual(wcText(TEXT), { lines: 4, words: 5, chars: TEXT.length });
  assert.deepEqual(wcText(""), { lines: 0, words: 0, chars: 0 });
  assert.equal(headText(TEXT, 2), "alpha\nBeta");
  assert.equal(tailText(TEXT, 1), "delta");
  assert.equal(tailText(TEXT, 0), "");
  assert.equal(sortText("b\na\nb\n", { unique: true }), "a\nb");
  assert.equal(sortText("10\n9\n100", { numeric: true, reverse: true }), "100\n10\n9");
});

test("tree draws folders first and counts", () => {
  const t = treeText(PATHS, "/notes");
  assert.equal(t.text, "/notes\n|-- sub/\n|   `-- b.md\n|-- alpha.md\n`-- alpine.md");
  assert.equal(t.dirs, 1);
  assert.equal(t.files, 3);
});

test("glob", () => {
  assert.equal(globMatch("notes.md", "*.md"), true);
  assert.equal(globMatch("notes.md", "*.ts"), false);
  assert.equal(globMatch("Notes.md", "note"), true);
  assert.equal(globMatch("a1", "a?"), true);
});
