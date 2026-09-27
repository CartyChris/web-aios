/* Writer's document model: every format round-trips what the model holds. */
import test from "node:test";
import assert from "node:assert/strict";
import { toDocx, fromDocx, toOdt, fromOdt, toMarkdown, fromMarkdown, toHtml, parseInline, wordCount, toBase64, fromBase64 } from "../.test-build/office/doc.js";
import { makeZip } from "../.test-build/zip.js";
import { readZip, listZip } from "../.test-build/office/zipread.js";
import { inflateRawSync } from "node:zlib";

/** Strict well-formedness: every open tag closed in order, attributes quoted. */
export function wellFormed(xml) {
  const stack = [];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<\?[^>]*\?>|<!--[\s\S]*?-->/g;
  let m, last = 0;
  while ((m = re.exec(xml))) {
    if (xml.slice(last, m.index).includes("<")) return `stray < before ${m.index}`;
    last = re.lastIndex;
    if (!m[2]) continue;
    if (m[1]) { if (stack.pop() !== m[2]) return `mismatched </${m[2]}> at ${m.index}`; }
    else if (!m[4]) stack.push(m[2]);
  }
  if (xml.slice(last).includes("<")) return "stray < at end";
  return stack.length ? `unclosed <${stack.at(-1)}>` : null;
}

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const sample = {
  title: "Plan & notes",
  blocks: [
    { t: "h", level: 1, runs: [{ text: "Quarterly plan" }] },
    { t: "p", runs: [{ text: "Plain, " }, { text: "bold", b: true }, { text: " and " }, { text: "italic", i: true }, { text: " with " }, { text: "a link", href: "https://example.com/x?a=1&b=2" }, { text: " <tags> & ampersands." }] },
    { t: "p", align: "center", runs: [{ text: "Centred " }, { text: "struck", s: true }, { text: " " }, { text: "code()", code: true }, { text: " red", color: "#cc0000" }] },
    { t: "h", level: 2, runs: [{ text: "Steps" }] },
    { t: "list", ordered: true, items: [{ runs: [{ text: "First" }], level: 0 }, { runs: [{ text: "Nested a" }], level: 1 }, { runs: [{ text: "Nested b" }], level: 1 }, { runs: [{ text: "Second" }], level: 0 }] },
    { t: "list", ordered: false, items: [{ runs: [{ text: "Bullet" }], level: 0 }] },
    { t: "quote", runs: [{ text: "Measure twice." }] },
    { t: "code", text: "const x = 1;\n  indented()" },
    { t: "table", rows: [[[{ text: "Name" }], [{ text: "Qty" }]], [[{ text: "Apples" }], [{ text: "3" }]]] },
    { t: "img", src: PNG, alt: "a pixel" },
    { t: "hr" },
    { t: "pagebreak" },
    { t: "p", runs: [{ text: "End." }] },
  ],
};

const asMap = (entries) => new Map(entries.map((e) => [e.path, typeof e.content === "string" ? e.content : e.content]));
// Table header cells are written bold in .docx; everything else must match exactly.
const unboldHeader = (d) => ({ ...d, blocks: d.blocks.map((b) => (b.t === "table" ? { ...b, rows: b.rows.map((r) => r.map((c) => c.map((x) => { const y = { ...x }; delete y.b; return y; }))) } : b)) });

test("docx: every XML part is well-formed", () => {
  for (const e of toDocx(sample)) if (typeof e.content === "string") assert.equal(wellFormed(e.content), null, e.path);
});

test("docx: round trip keeps every block and every run format", () => {
  const back = fromDocx(asMap(toDocx(sample)), sample.title);
  assert.deepEqual(unboldHeader(back), sample);
});

test("docx: the image is embedded as a real media part", () => {
  const parts = toDocx(sample);
  const img = parts.find((p) => p.path === "word/media/image1.png");
  assert.ok(img && img.content.length > 50);
  assert.match(parts.find((p) => p.path === "[Content_Types].xml").content, /Extension="png"/);
});

test("docx: it survives being zipped and unzipped", async () => {
  const bytes = makeZip(toDocx(sample), new Date(2026, 8, 27));
  const files = await readZip(bytes, async (b) => new Uint8Array(inflateRawSync(b)));
  const text = new Map([...files].map(([k, v]) => [k, k.endsWith(".xml") || k.endsWith(".rels") ? new TextDecoder().decode(v) : v]));
  assert.deepEqual(unboldHeader(fromDocx(text, sample.title)), sample);
});

test("odt: mimetype first and stored, every XML part well-formed", () => {
  const entries = toOdt(sample);
  assert.equal(entries[0].path, "mimetype");
  assert.equal(entries[0].content, "application/vnd.oasis.opendocument.text");
  for (const e of entries) if (typeof e.content === "string" && e.path !== "mimetype") assert.equal(wellFormed(e.content), null, e.path);
  const bytes = makeZip(entries, new Date(2026, 8, 27));
  assert.equal(listZip(bytes)[0].method, 0);
  // The ODF spec: "mimetype" at offset 30 of the file, readable without unzipping.
  assert.equal(new TextDecoder().decode(bytes.subarray(38, 38 + 39)), "application/vnd.oasis.opendocument.text");
});

test("odt: round trip keeps every block, nested list levels included", () => {
  const back = fromOdt(asMap(toOdt(sample)), sample.title);
  assert.deepEqual(back, sample);
});

test("markdown: round trip of the text constructs", () => {
  const md = toMarkdown(sample);
  assert.match(md, /^# Quarterly plan/m);
  assert.match(md, /\*\*bold\*\*/);
  assert.match(md, /\[a link\]\(https:\/\/example\.com\/x\?a=1&b=2\)/);
  assert.match(md, /^ {2}2\. Nested b|^ {2}\d\. Nested b/m);
  const back = fromMarkdown(md, sample.title);
  const kinds = back.blocks.map((b) => b.t);
  assert.deepEqual(kinds.slice(0, 9), ["h", "p", "p", "h", "list", "list", "quote", "code", "table"]);
  assert.deepEqual(back.blocks[4].items.map((i) => i.level), [0, 1, 1, 0]);
  assert.equal(back.blocks[7].text, "const x = 1;\n  indented()");
});

test("markdown inline: nesting, escapes and code are respected", () => {
  assert.deepEqual(parseInline("**bold *both*** and `x*y` \\*lit\\*"), [
    { text: "bold ", b: true }, { text: "both", b: true, i: true }, { text: " and " }, { text: "x*y", code: true }, { text: " *lit*" },
  ]);
  assert.deepEqual(parseInline("[go **now**](https://a.b)"), [{ text: "go ", href: "https://a.b" }, { text: "now", href: "https://a.b", b: true }]);
});

test("html export escapes text and refuses script links", () => {
  const html = toHtml({ title: "t", blocks: [{ t: "p", runs: [{ text: "<script>alert(1)</script>" }, { text: "x", href: "javascript:alert(1)" }] }] });
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("javascript:"));
  assert.match(toHtml(sample, { standalone: true }), /^<!doctype html>/);
});

test("word count ignores punctuation-only tokens", () => {
  assert.deepEqual(wordCount({ title: "", blocks: [{ t: "p", runs: [{ text: "Hello, world - it's 2026 !" }] }] }), { words: 4, chars: 21 });
});

test("base64 round trip at every length mod 3", () => {
  for (let n = 0; n < 40; n++) {
    const b = new Uint8Array(n).map((_, i) => (i * 37 + 11) & 255);
    assert.deepEqual(fromBase64(toBase64(b)), b, `length ${n}`);
  }
  assert.equal(toBase64(new TextEncoder().encode("Man")), "TWFu");
});
