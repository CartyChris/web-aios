/* Calc's formula engine. Expected values are what Excel and LibreOffice give. */
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateWorkbook, evaluateOne, shiftFormula, parseAddr, colToIndex, indexToCol, literal, displayValue, formatWithPattern, matchesCriterion, dateToSerial, FUNCTION_NAMES } from "../.test-build/office/formula.js";

const wb = (cells, more = []) => ({ sheets: [{ name: "Sheet1", cells }, ...more] });
const f = (formula, cells = {}) => evaluateOne(wb(cells), "Sheet1", formula);
const code = (v) => (v && typeof v === "object" ? v.error : v);

test("addresses", () => {
  assert.equal(colToIndex("A"), 0);
  assert.equal(colToIndex("Z"), 25);
  assert.equal(colToIndex("AA"), 26);
  assert.equal(indexToCol(701), "ZZ");
  assert.equal(indexToCol(702), "AAA");
  for (let i = 0; i < 2000; i++) assert.equal(colToIndex(indexToCol(i)), i);
  assert.deepEqual(parseAddr("$B$3"), { c: 1, r: 2, absC: true, absR: true });
  assert.equal(parseAddr("A0"), null);
});

test("literals", () => {
  assert.equal(literal("42"), 42);
  assert.equal(literal("1,234.5"), 1234.5);
  assert.equal(literal("12%"), 0.12);
  assert.equal(literal("true"), true);
  assert.equal(literal(""), null);
  assert.equal(literal("hello"), "hello");
  assert.equal(literal("1,23"), "1,23", "not a thousands pattern stays text");
});

test("precedence matches spreadsheets", () => {
  assert.equal(f("=1+2*3"), 7);
  assert.equal(f("=(1+2)*3"), 9);
  assert.equal(f("=2^3^2"), 64, "left-associative, as Excel and LibreOffice");
  assert.equal(f("=-2^2"), 4, "unary minus binds tighter than ^");
  assert.equal(f("=50%*2"), 1);
  assert.equal(f('="a"&1+1'), "a2", "& is looser than +");
  assert.equal(f("=1+1=2"), true, "comparison is loosest");
  assert.equal(f("=10/4"), 2.5);
});

test("references, ranges and aggregates", () => {
  const cells = { A1: "1", A2: "2", A3: "3", A4: "text", A5: "", B1: "=SUM(A1:A5)", B2: "=AVERAGE(A1:A4)", B3: "=COUNT(A1:A5)", B4: "=COUNTA(A1:A5)", B5: "=MAX(A1:A3)*MIN(A1:A3)" };
  const v = evaluateWorkbook(wb(cells)).values.Sheet1;
  assert.equal(v.B1, 6, "text and blanks in a range are skipped");
  assert.equal(v.B2, 2);
  assert.equal(v.B3, 3);
  assert.equal(v.B4, 4);
  assert.equal(v.B5, 3);
  assert.equal(f('=SUM("3", 4)'), 7, "a direct text argument is coerced");
});

test("errors propagate and are the right ones", () => {
  assert.equal(code(f("=1/0")), "#DIV/0!");
  assert.equal(code(f('="a"+1')), "#VALUE!");
  assert.equal(code(f("=NOPE(1)")), "#NAME?");
  assert.equal(code(f("=SUM(1/0, 2)")), "#DIV/0!");
  assert.equal(code(f("=AVERAGE(A1:A3)")), "#DIV/0!", "average of nothing");
  assert.equal(code(f("=1+")), "#ERROR!", "a syntax error is a value, not a crash");
  assert.equal(code(f("=Other!A1")), "#REF!");
});

test("a cycle is #CYCLE! on every cell of it, and does not hang", () => {
  const v = evaluateWorkbook(wb({ A1: "=B1+1", B1: "=C1+1", C1: "=A1+1", D1: "=A1" })).values.Sheet1;
  for (const a of ["A1", "B1", "C1", "D1"]) assert.equal(code(v[a]), "#CYCLE!", a);
  assert.equal(code(evaluateWorkbook(wb({ A1: "=A1" })).values.Sheet1.A1), "#CYCLE!");
});

test("IF and friends are lazy: the branch not taken cannot poison the result", () => {
  assert.equal(f("=IF(TRUE, 1, 1/0)"), 1);
  assert.equal(f("=IFERROR(1/0, \"n/a\")"), "n/a");
  assert.equal(f("=IFS(1>2, \"a\", 2>1, \"b\")"), "b");
  assert.equal(f("=CHOOSE(2, 1/0, \"two\")"), "two");
  assert.equal(f("=AND(TRUE, 1)"), true);
  assert.equal(f("=OR(FALSE, 0)"), false);
  assert.equal(f("=IF(A1, \"set\", \"blank\")"), "blank");
});

test("conditional aggregates with criteria", () => {
  const cells = { A1: "apple", A2: "banana", A3: "apple", A4: "cherry", B1: "10", B2: "20", B3: "30", B4: "40" };
  assert.equal(f('=SUMIF(A1:A4, "apple", B1:B4)', cells), 40);
  assert.equal(f('=COUNTIF(B1:B4, ">15")', cells), 3);
  assert.equal(f('=AVERAGEIF(B1:B4, "<=20")', cells), 15);
  assert.equal(f('=COUNTIF(A1:A4, "a*")', cells), 2, "wildcards");
  assert.equal(f('=COUNTIF(A1:A4, "<>apple")', cells), 2);
  assert.ok(matchesCriterion(null, ""), "empty criterion matches blanks");
  assert.ok(!matchesCriterion("x", ""));
});

test("lookups", () => {
  const cells = { A1: "1", A2: "5", A3: "10", B1: "low", B2: "mid", B3: "high", C1: "Ann", C2: "Bob", D1: "30", D2: "40" };
  assert.equal(f("=VLOOKUP(7, A1:B3, 2)", cells), "mid", "approximate: largest <= 7");
  assert.equal(code(f("=VLOOKUP(7, A1:B3, 2, FALSE)", cells)), "#N/A");
  assert.equal(f('=VLOOKUP("bob", C1:D2, 2, FALSE)', cells), 40, "exact text match is case-insensitive");
  assert.equal(code(f("=VLOOKUP(5, A1:B3, 3, FALSE)", cells)), "#REF!");
  assert.equal(f("=MATCH(10, A1:A3, 0)", cells), 3);
  assert.equal(f("=INDEX(A1:B3, 2, 2)", cells), "mid");
  assert.equal(f('=XLOOKUP("Bob", C1:C2, D1:D2)', cells), 40);
  assert.equal(f('=XLOOKUP("Zed", C1:C2, D1:D2, "none")', cells), "none");
});

test("text functions", () => {
  assert.equal(f('=LEFT("spreadsheet", 6)'), "spread");
  assert.equal(f('=MID("spreadsheet", 7, 5)'), "sheet");
  assert.equal(f('=RIGHT("abc", 2)'), "bc");
  assert.equal(f('=PROPER("hello wORLD")'), "Hello World");
  assert.equal(f('=TRIM("  a   b ")'), "a b");
  assert.equal(f('=SUBSTITUTE("a-b-c", "-", "+")'), "a+b+c");
  assert.equal(f('=TEXTJOIN(", ", TRUE, "a", "", "b")'), "a, b");
  assert.equal(f('=FIND("s", "cats")'), 4);
  assert.equal(code(f('=FIND("z", "cats")')), "#VALUE!");
  assert.equal(f('=LEN("héllo")'), 5);
});

test("rounding is the rounding a person expects", () => {
  assert.equal(f("=ROUND(2.675, 2)"), 2.68, "not 2.67 from binary float");
  assert.equal(f("=ROUND(-2.5, 0)"), -3);
  assert.equal(f("=ROUNDUP(1.21, 1)"), 1.3);
  assert.equal(f("=ROUNDDOWN(-1.29, 1)"), -1.2);
  assert.equal(f("=MOD(-3, 5)"), 2, "sign of the divisor, like spreadsheets");
  assert.equal(displayValue(f("=0.1+0.2")), "0.3");
});

test("number formats in TEXT", () => {
  assert.equal(formatWithPattern(1234567.891, "#,##0.00"), "1,234,567.89");
  assert.equal(formatWithPattern(0.256, "0.0%"), "25.6%");
  assert.equal(formatWithPattern(-1500, "$#,##0"), "-$1,500");
  assert.equal(f('=TEXT(3.14159, "0.00")'), "3.14");
});

test("dates are serial days, like every spreadsheet", () => {
  assert.equal(dateToSerial(1900, 3, 1), 61);
  assert.equal(dateToSerial(2026, 9, 27), 46292);
  assert.equal(f("=YEAR(DATE(2026, 9, 27))"), 2026);
  assert.equal(f("=DATE(2026, 9, 27) - DATE(2026, 1, 1)"), 269);
  const today = evaluateOne(wb({}), "Sheet1", "=TODAY()", { now: Date.UTC(2026, 8, 27, 3, 0), tzOffsetMin: 240 });
  assert.equal(today, dateToSerial(2026, 9, 26), "3am UTC is still the 26th in New York");
});

test("other sheets, including quoted names", () => {
  const book = { sheets: [{ name: "Sheet1", cells: { A1: "=Data!B2*2", A2: "='My Costs'!A1+1" } }, { name: "Data", cells: { B2: "21" } }, { name: "My Costs", cells: { A1: "9" } }] };
  const v = evaluateWorkbook(book).values.Sheet1;
  assert.equal(v.A1, 42);
  assert.equal(v.A2, 10);
});

test("fill shifts relative references and keeps absolute ones", () => {
  assert.equal(shiftFormula("=A1+$B$1+C$2+$D3", 1, 1), "=B2+$B$1+D$2+$D4");
  assert.equal(shiftFormula("=SUM(A1:A3)", 3, 0), "=SUM(A4:A6)");
  assert.equal(shiftFormula('="A1"&A1', 1, 0), '="A1"&A2', "text in quotes is not a reference");
  assert.equal(shiftFormula("=A1", -1, 0), "=#REF!");
  assert.equal(shiftFormula("=Data!A1", 0, 1), "=Data!B1");
  assert.equal(shiftFormula("plain", 1, 1), "plain");
});

test("SUMPRODUCT, STDEV, MEDIAN, LARGE", () => {
  const cells = { A1: "1", A2: "2", A3: "3", A4: "4", B1: "2", B2: "2", B3: "2", B4: "2" };
  assert.equal(f("=SUMPRODUCT(A1:A4, B1:B4)", cells), 20);
  assert.equal(f("=MEDIAN(A1:A4)", cells), 2.5);
  assert.equal(Math.round(f("=STDEV(A1:A4)", cells) * 1e6) / 1e6, 1.290994);
  assert.equal(f("=LARGE(A1:A4, 2)", cells), 3);
  assert.equal(code(f("=SUMPRODUCT(A1:A4, B1:B2)", cells)), "#VALUE!");
});

test("the function list is what the engine implements", () => {
  assert.ok(FUNCTION_NAMES.length >= 70, `${FUNCTION_NAMES.length} functions`);
  for (const n of ["SUM", "VLOOKUP", "XLOOKUP", "SUMIF", "TEXTJOIN", "IFS", "TODAY"]) assert.ok(FUNCTION_NAMES.includes(n), n);
});
