/* Office files in the VFS, and pulling usable output out of model replies. */
import test from "node:test";
import assert from "node:assert/strict";
import { appForPath, newName, parseDoc, parseSheetFile, parseDeck, parseDrawing, parseMath, parseBase, extOf } from "../.test-build/office/files.js";
import { cleanReply, extractFormula, extractCsv, extractSql, extractOutline, extractJson, extractLatex, writerPrompt } from "../.test-build/office/ai.js";

test("which app opens which file", () => {
  assert.equal(appForPath("/documents/Plan.wdoc"), "writer");
  assert.equal(appForPath("/x/Budget.WSHEET"), "sheets");
  assert.equal(appForPath("/a.wslides"), "impress");
  assert.equal(appForPath("/a.docx"), null, "imports are not opened in place");
  assert.equal(extOf("/a/b.tar.gz"), "gz");
  assert.equal(newName("writer", new Set(["/documents/Untitled.wdoc"])), "/documents/Untitled 2.wdoc");
});

test("stored documents are re-validated: junk fields and hostile values do not survive", () => {
  const d = parseDoc({ title: "T", blocks: [{ t: "p", runs: [{ text: "x", b: true, href: "javascript:alert(1)", color: "red", onclick: "x" }] }, { t: "script", src: "x" }, { t: "img", src: "https://evil/x.png" }, { t: "h", level: 9, runs: [] }] });
  assert.deepEqual(d.blocks, [{ t: "p", runs: [{ text: "x", b: true }] }, { t: "h", level: 1, runs: [] }]);
  assert.deepEqual(parseDoc(null), { title: "Untitled", blocks: [] });
});

test("sheet files: bad addresses, duplicate names and odd formats are dropped", () => {
  const f = parseSheetFile({ wb: { sheets: [{ name: "A", cells: { A1: "1", "A0": "x", "a1": "y", B2: 5 } }, { name: "a", cells: {} }] }, formats: { A: { A1: { b: true, bg: "url(x)", nf: "0.00" } } }, colWidths: { A: { A: 5000, B: 120 } } });
  assert.deepEqual(f.wb.sheets[0].cells, { A1: "1" });
  assert.equal(f.wb.sheets[1].name, "a 2", "sheet names stay unique, case-insensitively");
  assert.deepEqual(f.formats.A.A1, { b: true, nf: "0.00" });
  assert.deepEqual(f.colWidths.A, { B: 120 });
  assert.equal(parseSheetFile({}).wb.sheets[0].name, "Sheet1");
});

test("decks, drawings, math and base files validate", () => {
  const deck = parseDeck({ title: "D", theme: { bg: "#000000", font: "x;}" }, slides: [{ layout: "bogus", title: "S", bullets: [{ text: "b", level: 9 }], image: "data:text/html;base64,PHNjcmlwdD4=" }] });
  assert.equal(deck.slides[0].layout, "content");
  assert.equal(deck.slides[0].bullets[0].level, 3);
  assert.equal(deck.slides[0].image, undefined);
  assert.equal(deck.theme.bg, "#000000");
  const dr = parseDrawing({ shapes: [{ id: "a", kind: "rect", x: 1, y: 2, w: 3, h: 4, fill: "javascript:x", strokeW: 999 }, { id: "a", kind: "rect" }, { id: "b", kind: "iframe" }] });
  assert.equal(dr.shapes.length, 1);
  assert.equal(dr.shapes[0].fill, "none");
  assert.equal(dr.shapes[0].strokeW, 40);
  assert.equal(parseMath({}).formulas.length, 1, "an empty math file gets a starter formula");
  const b = parseBase({ tables: [{ name: "my table!", columns: [{ name: "n", type: "number" }, { name: "x", type: "blob" }], rows: [[1, { a: 1 }], [2]] }, { name: "MY_TABLE_" }] });
  assert.equal(b.tables.length, 1);
  assert.equal(b.tables[0].name, "my_table_");
  assert.deepEqual(b.tables[0].columns.map((c) => c.type), ["number", "text"]);
  assert.deepEqual(b.tables[0].rows, [[1, null], [2, null]]);
});

test("cleanReply strips the wrappers models add", () => {
  assert.equal(cleanReply("Here is the revised text:\n\nThe cat sat."), "The cat sat.");
  assert.equal(cleanReply("```\nfenced\n```"), "fenced");
  assert.equal(cleanReply('"quoted whole"'), "quoted whole");
  assert.equal(cleanReply('He said "hi" to me.'), 'He said "hi" to me.', "inner quotes are content");
});

test("formula, CSV, SQL, outline, JSON and LaTeX extraction", () => {
  assert.equal(extractFormula("Sure! Use this:\n```\n=SUMIF(A2:A10,\"x\",B2:B10)\n```\nIt sums..."), '=SUMIF(A2:A10,"x",B2:B10)');
  assert.equal(extractFormula("Formula: `=AVERAGE(B:B)`"), "=AVERAGE(B:B)");
  assert.equal(extractFormula("I cannot do that."), null);
  assert.equal(extractCsv("Here you go:\n```csv\nname,age\nAnn,30\n```"), "name,age\nAnn,30");
  assert.equal(extractCsv("no table here"), null);
  assert.equal(extractSql("```sql\nSELECT * FROM t WHERE a = 1;\n```"), "SELECT * FROM t WHERE a = 1");
  assert.equal(extractSql("The query is:\nselect count(*) from orders\n\nThis counts them."), "select count(*) from orders");
  assert.equal(extractSql("DROP TABLE x"), null);
  assert.equal(extractOutline("Here's a deck:\n# T\n## S\n- a"), "# T\n## S\n- a");
  assert.deepEqual(extractJson('Sure: {"a": {"b": "}"}, "c": [1]} trailing'), { a: { b: "}" }, c: [1] });
  assert.equal(extractJson("{not json} and nothing else"), null);
  assert.equal(extractLatex("$$\\frac{a}{b}$$"), "\\frac{a}{b}");
  assert.equal(extractLatex("```latex\nx^2\n```"), "x^2");
});

test("writer prompts carry the text and cap the context", () => {
  const p = writerPrompt("Fix it.", "abc", "x".repeat(10_000));
  assert.ok(p.includes('"""\nabc\n"""'));
  assert.ok(p.length < 7000);
});
