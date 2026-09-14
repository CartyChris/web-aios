/**
 * Project scaffold tests.
 *
 * The delimiter format exists because asking a model to JSON-escape hundreds
 * of lines of code reliably produces broken escapes. These assert it survives
 * the things a model actually does: stray fences, prose, nested backticks,
 * and paths that try to climb out of the project root.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TARGETS, getTarget, parseProjectFiles, mergeProject } from "../.test-build/scaffold.js";

test("every target ships a base scaffold with a README", () => {
  for (const t of TARGETS) {
    const base = t.base("My App");
    assert.ok(base.length > 0, `${t.id} has base files`);
    assert.ok(base.some((f) => f.path === "README.md"), `${t.id} has a README`);
    assert.ok(t.expects.length > 0, `${t.id} declares expected files`);
  }
});

test("node targets emit valid, parseable package.json", () => {
  for (const t of TARGETS) {
    const pkg = t.base("My Cool App").find((f) => f.path === "package.json");
    if (!pkg) continue;
    const parsed = JSON.parse(pkg.content); // throws if the scaffold is malformed
    assert.ok(parsed.name, `${t.id} package name`);
    assert.match(parsed.name, /^[a-z0-9-]+$/, `${t.id} name must be npm-legal, got ${parsed.name}`);
    assert.ok(parsed.scripts && Object.keys(parsed.scripts).length, `${t.id} has scripts`);
  }
});

test("tsconfig files in scaffolds are valid JSON", () => {
  for (const t of TARGETS) {
    const tc = t.base("x").find((f) => f.path === "tsconfig.json");
    if (tc) JSON.parse(tc.content);
  }
});

test("parses the delimiter format into files", () => {
  const files = parseProjectFiles(`=== src/App.tsx ===
export default function App() {
  return <h1>hi</h1>;
}
=== src/index.css ===
body { margin: 0; }
`);
  assert.equal(files.length, 2);
  assert.equal(files[0].path, "src/App.tsx");
  assert.match(files[0].content, /return <h1>hi<\/h1>;/);
  assert.equal(files[1].path, "src/index.css");
  assert.match(files[1].content, /body \{ margin: 0; \}/);
});

test("content containing backticks and fences survives intact", () => {
  const files = parseProjectFiles(`=== README.md ===
Run \`npm install\`.

\`\`\`bash
npm run dev
\`\`\`
=== src/a.js ===
const t = \`template \${x}\`;
`);
  assert.equal(files.length, 2);
  assert.match(files[0].content, /```bash/);
  assert.match(files[1].content, /template \$\{x\}/);
});

test("a stray fence wrapping the whole reply is tolerated", () => {
  const files = parseProjectFiles("```\n=== a.txt ===\nhello\n```");
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "a.txt");
  assert.equal(files[0].content.trim(), "hello");
});

test("path traversal is refused", () => {
  const files = parseProjectFiles(`=== ../../etc/passwd ===
root:x:0:0
=== ok.txt ===
fine
`);
  assert.equal(files.length, 1, "the traversing path must be dropped");
  assert.equal(files[0].path, "ok.txt");
});

test("leading slashes and backslashes are normalised", () => {
  const files = parseProjectFiles("=== /src\\\\deep\\\\x.ts ===\nconst a = 1;\n");
  assert.equal(files[0].path, "src/deep/x.ts");
});

test("garbage yields no files rather than throwing", () => {
  assert.deepEqual(parseProjectFiles("I could not complete that request."), []);
  assert.deepEqual(parseProjectFiles(""), []);
});

test("generated files win over the base scaffold on conflict", () => {
  const merged = mergeProject(
    [{ path: "README.md", content: "base" }, { path: "package.json", content: "{}" }],
    [{ path: "README.md", content: "generated" }, { path: "src/app.ts", content: "x" }],
  );
  assert.equal(merged.length, 3);
  assert.equal(merged.find((f) => f.path === "README.md").content, "generated");
  assert.ok(merged.find((f) => f.path === "package.json"), "untouched base files survive");
});

test("an unknown target id falls back rather than crashing", () => {
  assert.equal(getTarget("nope").id, TARGETS[0].id);
});
