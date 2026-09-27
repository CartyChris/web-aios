/* The XML reader and zip reader that every office importer stands on. */
import test from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync, deflateRawSync } from "node:zlib";
import { parseXml, all, textOf, attr, kids, escapeXml, decodeEntities } from "../.test-build/office/xml.js";
import { readZip, listZip, utf8 } from "../.test-build/office/zipread.js";
import { makeZip } from "../.test-build/zip.js";

const inflate = async (b) => new Uint8Array(inflateRawSync(b));

test("xml: elements, attributes, text, entities, CDATA", () => {
  const doc = parseXml('<?xml version="1.0"?><w:doc a="1 &amp; 2"><!-- c --><w:p><w:t xml:space="preserve">Hi &lt;there&gt; &#233;&#x1F600;</w:t></w:p><w:p/><x><![CDATA[<raw>]]></x></w:doc>');
  const d = kids(doc)[0];
  assert.equal(d.name, "w:doc");
  assert.equal(attr(d, "a"), "1 & 2");
  assert.equal(all(doc, "p").length, 2, "local names match across prefixes");
  assert.equal(textOf(all(doc, "t")[0]), "Hi <there> é\u{1F600}");
  assert.equal(textOf(all(doc, "x")[0]), "<raw>");
  assert.equal(attr(all(doc, "t")[0], "space"), "preserve");
});

test("xml: attributes containing > and quotes, and unknown entities left alone", () => {
  const d = kids(parseXml(`<a title="x > y" alt='say "hi"'>&nbsp;</a>`))[0];
  assert.equal(d.attrs.title, "x > y");
  assert.equal(d.attrs.alt, 'say "hi"');
  assert.equal(textOf(d), "&nbsp;", "no DTD, so no entity expansion");
});

test("xml: escape round-trips, and forbidden control characters are dropped", () => {
  const s = `a & b < c > "d" \u0001e`;
  assert.equal(decodeEntities(escapeXml(s)), `a & b < c > "d" e`);
});

test("xml: a node bomb is refused", () => {
  assert.throws(() => parseXml("<a/>".repeat(20), 10), /too large/);
});

test("zip: our own stored archive reads back byte for byte", async () => {
  const bytes = makeZip([{ path: "mimetype", content: "application/vnd.oasis.opendocument.text" }, { path: "dir/a.xml", content: "<a>é</a>" }], new Date(2026, 8, 27));
  const files = await readZip(bytes, inflate);
  assert.equal(utf8(files.get("mimetype")), "application/vnd.oasis.opendocument.text");
  assert.equal(utf8(files.get("dir/a.xml")), "<a>é</a>");
  assert.equal(listZip(bytes)[0].path, "mimetype", "order is kept (ODF needs mimetype first)");
});

test("zip: deflated entries go through the supplied inflate", async () => {
  const text = "hello ".repeat(500);
  const bytes = makeZip([{ path: "t.txt", content: text }], { when: new Date(2026, 8, 27), deflate: (b) => new Uint8Array(deflateRawSync(b)) });
  assert.equal(listZip(bytes)[0].method, 8);
  assert.equal(utf8((await readZip(bytes, inflate)).get("t.txt")), text);
});

test("zip: not-a-zip and bombs are refused before inflating", async () => {
  await assert.rejects(() => readZip(new Uint8Array([1, 2, 3]), inflate), /Not a zip/);
  const bytes = makeZip([{ path: "big.txt", content: "x".repeat(1000) }], new Date(2026, 8, 27));
  let called = false;
  await assert.rejects(() => readZip(bytes, async (b) => { called = true; return b; }, { maxEntryBytes: 100 }), /limit/);
  assert.equal(called, false);
  await assert.rejects(() => readZip(bytes, inflate, { maxTotalBytes: 500 }), /expands/);
});
