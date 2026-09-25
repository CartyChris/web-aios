/**
 * Code Studio formatter, find/replace and worker source.
 *
 * The failure that matters for a formatter is destruction, so most of these
 * assert what must NOT change: string and template contents, comments, line
 * count for re-indented languages, and idempotence.
 */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  langFor, formatCode, findAll, replaceAll, lineCol, offsetOfLine, workerSource,
} from "../.test-build/codefmt.js";

test("langFor maps extensions and refuses unknown ones", () => {
  assert.equal(langFor("/code/a.tsx"), "ts");
  assert.equal(langFor("x.MJS"), "js");
  assert.equal(langFor("s.css"), "css");
  assert.equal(langFor("d.json"), "json");
  assert.equal(langFor("i.htm"), "html");
  assert.equal(langFor("notes.md"), null);
});

test("JSON is re-serialised and invalid JSON is an error, not a guess", () => {
  const r = formatCode('{"a":1,"b":[1,2]}', "json");
  assert.equal(r.ok, true);
  assert.equal(r.text, '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}\n');
  const bad = formatCode('{"a":1,}', "json");
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Not valid JSON/);
});

test("JS is re-indented by bracket depth without adding or removing lines", () => {
  const src = "function f(a) {\nif (a) {\nreturn [\n1,\n2\n];\n}\n}\n";
  const r = formatCode(src, "js");
  assert.equal(r.ok, true);
  assert.equal(r.text, "function f(a) {\n  if (a) {\n    return [\n      1,\n      2\n    ];\n  }\n}\n");
  assert.equal(r.text.split("\n").length, src.split("\n").length);
});

test("braces inside strings, comments and regexes do not move the indent", () => {
  const src = [
    "const s = '{{{';",
    'const d = "}}";',
    "// { not a block",
    "/* } nor this { */",
    "const re = /[{]+/g;",
    "if (x) {",
    "y();",
    "}",
  ].join("\n");
  const r = formatCode(src, "js");
  const lines = r.text.split("\n");
  assert.equal(lines[0], "const s = '{{{';");
  assert.equal(lines[4], "const re = /[{]+/g;");
  assert.equal(lines[6], "  y();");
  assert.equal(lines[7], "}");
});

test("template literal contents are left exactly as written", () => {
  const src = "const t = `\n   keep   this\n{ not code }\n${a ? `in${b}` : 'x'}\n`;\nif (a) {\nb();\n}";
  const r = formatCode(src, "ts");
  assert.ok(r.text.includes("\n   keep   this\n{ not code }\n"), r.text);
  assert.ok(r.text.includes("if (a) {\n  b();\n}"), r.text);
});

test("formatting is idempotent", () => {
  for (const [src, lang] of [
    ["a{color:red;background:url(data:image/png;base64,AAA)}b{margin:0}", "css"],
    ["<div>\n<p>hi</p>\n<ul>\n<li>x</li>\n</ul>\n</div>", "html"],
    ["x(() => {\nreturn 1;\n});", "js"],
  ]) {
    const once = formatCode(src, lang).text;
    const twice = formatCode(once, lang).text;
    assert.equal(twice, once, `${lang} not idempotent`);
  }
});

test("CSS gets one declaration per line and keeps url() intact", () => {
  const r = formatCode("a{color:red;background:url(data:image/png;base64,AA;B)}@media (max-width:600px){a{margin:0}}", "css");
  assert.equal(
    r.text,
    "a {\n  color: red;\n  background: url(data:image/png;base64,AA;B);\n}\n\n@media (max-width:600px) {\n  a {\n    margin: 0;\n  }\n}\n",
  );
});

test("HTML re-indents by tag depth, skips void tags, and leaves <pre> alone", () => {
  const src = "<div>\n<img src=x>\n<p>\ntext\n</p>\n<pre>\n  keep\n    me\n</pre>\n</div>";
  const r = formatCode(src, "html");
  assert.equal(r.text, "<div>\n  <img src=x>\n  <p>\n    text\n  </p>\n  <pre>\n  keep\n    me\n  </pre>\n</div>\n");
});

test("HTML re-indents embedded script and style with their own rules", () => {
  const src = "<body>\n<script>\nif (a) {\nb();\n}\n</script>\n<style>\na{color:red}\n</style>\n</body>";
  const r = formatCode(src, "html");
  assert.ok(r.text.includes("  <script>\n    if (a) {\n      b();\n    }\n  </script>"), r.text);
  assert.ok(r.text.includes("  <style>\n    a {\n      color: red;\n    }\n  </style>"), r.text);
});

test("findAll: literal, case, whole word, regex, and a bad regex reports", () => {
  const t = "Cat cat concat CAT";
  assert.equal(findAll(t, "cat").matches.length, 4);
  assert.equal(findAll(t, "cat", { caseSensitive: true }).matches.length, 2);
  assert.equal(findAll(t, "cat", { wholeWord: true }).matches.length, 3);
  assert.deepEqual(findAll(t, "c.t", { regex: true, caseSensitive: true }).matches.map((m) => m.start), [4, 11]);
  assert.equal(findAll(t, "c.t").matches.length, 0, "a literal dot is not a wildcard");
  const bad = findAll(t, "(", { regex: true });
  assert.ok(bad.error);
  assert.equal(findAll(t, "x*", { regex: true }).matches.length, 0, "empty matches are not results");
});

test("replaceAll: literal $ stays literal, regex groups expand", () => {
  assert.deepEqual(replaceAll("a.b.c", ".", "$1"), { text: "a$1b$1c", count: 2 });
  assert.deepEqual(replaceAll("x=1, y=2", "(\\w)=(\\d)", "$2:$1", { regex: true }), { text: "1:x, 2:y", count: 2 });
  assert.equal(replaceAll("aaa", "b", "c").count, 0);
});

test("lineCol and offsetOfLine agree", () => {
  const t = "one\ntwo\nthree";
  assert.deepEqual(lineCol(t, 0), { line: 1, col: 1 });
  assert.deepEqual(lineCol(t, 5), { line: 2, col: 2 });
  assert.equal(offsetOfLine(t, 3), 8);
  assert.equal(offsetOfLine(t, 99), t.length);
  assert.equal(offsetOfLine(t, -4), 0);
});

test("workerSource captures console output, runs top-level await, and reports completion", async () => {
  const msgs = [];
  const ctx = { postMessage: (m) => msgs.push(JSON.parse(JSON.stringify(m))), console: {}, self: { addEventListener() {} }, JSON, Array, String, Promise };
  vm.runInNewContext(workerSource("console.log('hi', {a:1});\nawait Promise.resolve();\nconsole.error(new Error('boom'))"), ctx);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(msgs[0], { __ide: 1, level: "log", text: 'hi {"a":1}' });
  assert.equal(msgs[1].level, "error");
  assert.match(msgs[1].text, /boom/);
  assert.deepEqual(msgs[msgs.length - 1], { __ide: 1, done: true });
});

test("a throwing script still reports done, flagged as failed", async () => {
  const msgs = [];
  const ctx = { postMessage: (m) => msgs.push(JSON.parse(JSON.stringify(m))), console: {}, self: { addEventListener() {} }, JSON, Array, String, Promise, Error };
  vm.runInNewContext(workerSource("throw new Error('nope')"), ctx);
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(msgs.some((m) => m.level === "error" && /nope/.test(m.text)));
  assert.deepEqual(msgs[msgs.length - 1], { __ide: 1, done: true, failed: true });
});

test("userLine maps a worker line back to the author's line", async () => {
  const { userLine } = await import("../.test-build/codefmt.js");
  const lines = workerSource("a\nb\nTARGET\nc").split("\n");
  const workerLine = lines.indexOf("TARGET") + 1;
  assert.equal(userLine(workerLine), 3);
  assert.equal(userLine(1), 1, "clamped to the first line");
});
