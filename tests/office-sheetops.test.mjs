/* Structural edits keep every formula pointing at the same data. */
import test from "node:test";
import assert from "node:assert/strict";
import { adjustFormula, shiftStructure, sortRange, fill, pasteBlock, autoSumRange } from "../.test-build/office/sheetops.js";
import { evaluateWorkbook } from "../.test-build/office/formula.js";

test("insert rows: references at or below move, above stay, absolute ones move too", () => {
  assert.equal(adjustFormula("=A1+A5+$A$6", "S", "S", "row", 3, 2), "=A1+A7+$A$8");
  assert.equal(adjustFormula("=SUM(A2:A10)", "S", "S", "row", 4, 1), "=SUM(A2:A11)", "a range spanning the insert grows");
  assert.equal(adjustFormula("=Other!A5", "S", "S", "row", 0, 1), "=Other!A5", "another sheet's references are untouched");
  assert.equal(adjustFormula("=S!A5", "Other", "S", "row", 0, 1), "=S!A6", "references from another sheet into this one move");
  assert.equal(adjustFormula('="A5"&A5', "S", "S", "row", 0, 1), '="A5"&A6', "text is not a reference");
});

test("delete rows: a reference into the deleted rows is #REF!, a range shrinks", () => {
  assert.equal(adjustFormula("=A3", "S", "S", "row", 2, -1), "=#REF!");
  assert.equal(adjustFormula("=A5*2", "S", "S", "row", 2, -2), "=A3*2");
  assert.equal(adjustFormula("=SUM(A1:A5)", "S", "S", "row", 2, -2), "=SUM(A1:A3)");
  assert.equal(adjustFormula("=SUM(A3:A4)", "S", "S", "row", 2, -2), "=SUM(#REF!)");
});

test("columns work the same way", () => {
  assert.equal(adjustFormula("=B1+D1", "S", "S", "col", 2, 1), "=B1+E1");
  assert.equal(adjustFormula("=SUM(A1:D1)", "S", "S", "col", 1, -1), "=SUM(A1:C1)");
});

test("a whole-workbook insert keeps every total equal to what it was", () => {
  const wb = { sheets: [{ name: "Data", cells: { A1: "1", A2: "2", A3: "3", A4: "=SUM(A1:A3)" } }, { name: "Report", cells: { B1: "=Data!A4*10" } }] };
  const before = evaluateWorkbook(wb).values;
  const after = shiftStructure(wb, "Data", "row", 1, 2);
  assert.equal(after.sheets[0].cells.A6, "=SUM(A1:A5)");
  assert.equal(after.sheets[0].cells.A3, undefined, "the inserted rows are empty");
  assert.equal(after.sheets[1].cells.B1, "=Data!A6*10");
  const v = evaluateWorkbook(after).values;
  assert.equal(v.Data.A6, before.Data.A4);
  assert.equal(v.Report.B1, before.Report.B1);
});

test("delete then the cells below move up", () => {
  const wb = { sheets: [{ name: "S", cells: { A1: "x", A2: "gone", A3: "y", B3: "=A3" } }] };
  const s = shiftStructure(wb, "S", "row", 1, -1).sheets[0].cells;
  assert.deepEqual(s, { A1: "x", A2: "y", B2: "=A2" });
});

test("sort keeps rows together, numbers before text, blanks last, and shifts row-relative formulas", () => {
  const sheet = { name: "S", cells: { A1: "b", B1: "2", A2: "a", B2: "10", B3: "5", A4: "c", B4: "1", C1: "=B1*2", C2: "=B2*2", C4: "=B4*2" } };
  const out = sortRange(sheet, { c1: 0, r1: 0, c2: 2, r2: 3 }, 1, false);
  assert.deepEqual([1, 2, 3, 4].map((r) => out.cells[`B${r}`]), ["1", "2", "5", "10"]);
  assert.deepEqual([1, 2, 3, 4].map((r) => out.cells[`A${r}`]), ["c", "b", undefined, "a"]);
  assert.equal(out.cells.C1, "=B1*2", "C4's formula moved to row 1 and now points at row 1");
  const v = evaluateWorkbook({ sheets: [out] }).values.S;
  assert.equal(v.C1, 2);
  assert.equal(v.C4, 20);
});

test("fill down and right shift relative references", () => {
  const s = fill({ name: "S", cells: { A1: "=B1*$C$1", B1: "1" } }, { c1: 0, r1: 0, c2: 0, r2: 2 }, "down");
  assert.equal(s.cells.A2, "=B2*$C$1");
  assert.equal(s.cells.A3, "=B3*$C$1");
  const r = fill({ name: "S", cells: { A1: "=A2" } }, { c1: 0, r1: 0, c2: 2, r2: 0 }, "right");
  assert.equal(r.cells.C1, "=C2");
});

test("paste moves formulas with the copy, and clears where the block is blank", () => {
  const s = pasteBlock({ name: "S", cells: { D5: "old" } }, [["=A1", "x"], ["", "y"]], { c: 3, r: 4 }, { c: 0, r: 1 });
  assert.equal(s.cells.D5, "=D4");
  assert.equal(s.cells.D6, undefined);
  assert.equal(s.cells.E6, "y");
});

test("AutoSum proposes the run of numbers directly above", () => {
  const values = { A1: "Head", A2: 1, A3: 2, A4: 3 };
  assert.equal(autoSumRange({ name: "S", cells: {} }, values, 0, 4), "=SUM(A2:A4)");
  assert.equal(autoSumRange({ name: "S", cells: {} }, { A1: "x" }, 0, 1), null);
});

import { shiftKeyed } from "../.test-build/office/sheetops.js";

test("formats move with inserted and deleted rows", () => {
  const f = { B6: { nf: "$#,##0.00" }, A1: { b: true }, B3: { i: true } };
  assert.deepEqual(shiftKeyed(f, "row", 2, 1), { B7: { nf: "$#,##0.00" }, A1: { b: true }, B4: { i: true } });
  assert.deepEqual(shiftKeyed(f, "row", 2, -1), { B5: { nf: "$#,##0.00" }, A1: { b: true } }, "the deleted row's format goes with it");
  assert.deepEqual(shiftKeyed({ C1: 1 }, "col", 0, 2), { E1: 1 });
});
