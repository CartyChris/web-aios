/* Calc's formats: what the person typed comes back, formulas included. */
import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv, toCsv, detectDelimiter, cellsToGrid, gridToCells, toXlsx, fromXlsx, toOds, fromOds, toOdfFormula, fromOdfFormula } from "../.test-build/office/sheetio.js";
import { evaluateWorkbook } from "../.test-build/office/formula.js";
import { wellFormed } from "./office-doc.test.mjs";

const book = { sheets: [
  { name: "Budget", cells: { A1: "Item", B1: "Cost", A2: "Rent", B2: "1200", A3: "Food", B3: "450.5", A4: "Total", B4: "=SUM(B2:B3)", C4: '=IF(B4>1000,"over","ok")', D4: "=Other!A1*2", E4: "12%", F4: "TRUE", A5: "a, \"quoted\" <b>" } },
  { name: "Other", cells: { A1: "21" } },
] };
const values = evaluateWorkbook(book).values;
const asMap = (entries) => new Map(entries.map((e) => [e.path, e.content]));

test("csv: quotes, commas, newlines and CRLF", () => {
  const rows = parseCsv('a,"b,c","d ""e"""\r\n1,"multi\nline",3\n');
  assert.deepEqual(rows, [["a", "b,c", 'd "e"'], ["1", "multi\nline", "3"]]);
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
});

test("csv: the delimiter is detected, semicolons and tabs included", () => {
  assert.equal(detectDelimiter("a;b;c\n1;2;3"), ";");
  assert.equal(detectDelimiter("a\tb\n1\t2"), "\t");
  assert.equal(detectDelimiter("name,notes\nx,\"a; b; c; d\""), ",", "consistency beats frequency");
});

test("grid <-> cells", () => {
  const cells = { A1: "x", C2: "y" };
  assert.deepEqual(cellsToGrid(cells), [["x", "", ""], ["", "", "y"]]);
  assert.deepEqual(gridToCells(cellsToGrid(cells)), cells);
});

test("odf formula dialect both ways, quotes untouched", () => {
  assert.equal(toOdfFormula("=SUM(A1:B2, Data!C3)"), "of:=SUM([.A1:.B2]; [$Data.C3])");
  assert.equal(toOdfFormula('=IF(A1="x,y", 1, 2)'), 'of:=IF([.A1]="x,y"; 1; 2)');
  assert.equal(toOdfFormula("='My Sheet'!A1"), "of:=[$'My Sheet'.A1]");
  assert.equal(fromOdfFormula("of:=SUM([.A1:.B2];[$Data.C3])"), "=SUM(A1:B2,Data!C3)");
  assert.equal(fromOdfFormula('of:=IF([.A1]="a;b";1;2)'), '=IF(A1="a;b",1,2)');
  for (const f of ["=SUM(A1:B2,Data!C3)", '=IF(B4>1000,"over","ok")', "=$A$1+B$2", "='My Sheet'!A1"]) assert.equal(fromOdfFormula(toOdfFormula(f)), f.replace(/, /g, ","));
});

test("xlsx: well-formed, and every typed cell comes back", () => {
  const entries = toXlsx(book, values);
  for (const e of entries) assert.equal(wellFormed(e.content), null, e.path);
  const back = fromXlsx(asMap(entries));
  assert.deepEqual(back.sheets.map((s) => s.name), ["Budget", "Other"]);
  const cells = back.sheets[0].cells;
  assert.equal(cells.B4, "=SUM(B2:B3)");
  assert.equal(cells.C4, '=IF(B4>1000,"over","ok")');
  assert.equal(cells.D4, "=Other!A1*2");
  assert.equal(cells.A5, 'a, "quoted" <b>');
  assert.equal(cells.B3, "450.5");
  assert.equal(cells.F4, "TRUE");
  assert.equal(cells.E4, "0.12", "a percentage is stored as its value, with a % number format");
});

test("xlsx: cached values are written so the file shows numbers before recalculation", () => {
  const sheet = toXlsx(book, values).find((e) => e.path === "xl/worksheets/sheet1.xml").content;
  assert.match(sheet, /<c r="B4"><f>SUM\(B2:B3\)<\/f><v>1650.5<\/v><\/c>/);
  assert.match(sheet, /<c r="C4" t="str"><f>IF\(B4&gt;1000,&quot;over&quot;,&quot;ok&quot;\)<\/f><v>over<\/v><\/c>/);
});

test("xlsx: shared formulas from Excel expand to each cell", () => {
  const files = new Map([
    ["xl/workbook.xml", '<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ["xl/_rels/workbook.xml.rels", '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'],
    ["xl/sharedStrings.xml", "<sst><si><t>hello</t></si><si><r><t>rich </t></r><r><t>text</t></r></si></sst>"],
    ["xl/worksheets/sheet1.xml", '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="C2"><f t="shared" ref="C2:C4" si="0">A2*2</f><v>0</v></c></row><row r="3"><c r="C3"><f t="shared" si="0"/><v>0</v></c></row></sheetData></worksheet>'],
  ]);
  const s = fromXlsx(files).sheets[0];
  assert.equal(s.cells.A1, "hello");
  assert.equal(s.cells.B1, "rich text");
  assert.equal(s.cells.C2, "=A2*2");
  assert.equal(s.cells.C3, "=A3*2");
});

test("ods: well-formed, mimetype first, and every typed cell comes back", () => {
  const entries = toOds(book, values);
  assert.equal(entries[0].path, "mimetype");
  for (const e of entries.slice(1)) assert.equal(wellFormed(e.content), null, e.path);
  const back = fromOds(asMap(entries));
  assert.deepEqual(back.sheets.map((s) => s.name), ["Budget", "Other"]);
  const c = back.sheets[0].cells;
  assert.equal(c.B4, "=SUM(B2:B3)");
  assert.equal(c.C4, '=IF(B4>1000,"over","ok")');
  assert.equal(c.D4, "=Other!A1*2");
  assert.equal(c.E4, "12%");
  assert.equal(c.A5, 'a, "quoted" <b>');
  // And it evaluates to the same numbers as the original.
  assert.deepEqual(evaluateWorkbook(back).values.Budget.B4, 1650.5);
});

test("ods: repeated rows and columns expand, but are capped", () => {
  const files = new Map([["content.xml", '<office:document-content><office:body><office:spreadsheet><table:table table:name="T"><table:table-row table:number-rows-repeated="2"><table:table-cell table:number-columns-repeated="3" office:value-type="float" office:value="7"><text:p>7</text:p></table:table-cell></table:table-row><table:table-row table:number-rows-repeated="1048000"><table:table-cell table:number-columns-repeated="16384"/></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>']]);
  const cells = fromOds(files).sheets[0].cells;
  assert.deepEqual(Object.keys(cells).sort(), ["A1", "A2", "B1", "B2", "C1", "C2"]);
});
