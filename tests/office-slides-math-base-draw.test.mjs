/* Impress, Math, Base and Draw: the pure halves. */
import test from "node:test";
import assert from "node:assert/strict";
import { fromOutline, toOutline, toPptx, fromPptx, toOdp, fromOdp, toHtmlDeck, normaliseTheme, THEMES } from "../.test-build/office/slides.js";
import { latexToMathML } from "../.test-build/office/mathml.js";
import { runQuery, parseSql, inferType, coerce, schemaText } from "../.test-build/office/basedb.js";
import { boundaryPoint, toSvg, align, distribute, parseDiagram, layoutGraph, toOdg, connectorEnds } from "../.test-build/office/draw.js";
import { wellFormed } from "./office-doc.test.mjs";

const asMap = (entries) => new Map(entries.map((e) => [e.path, e.content]));

/* ── Impress ─────────────────────────────────────────────────────────────── */

const outline = `# Launch plan
> Q4 2026

## Why now
- Market moved
  - Two competitors left
- We are ready
Notes: Mention the survey.
Keep it short.

## Options
- Build
||
- Buy

### Section break

## A thought
> Ship the smallest useful thing.
`;

test("outline -> deck: layouts, levels, notes, two columns, quotes", () => {
  const d = fromOutline(outline);
  assert.equal(d.title, "Launch plan");
  assert.deepEqual(d.slides.map((s) => s.layout), ["title", "content", "two", "section", "quote"]);
  assert.equal(d.slides[0].subtitle, "Q4 2026");
  assert.deepEqual(d.slides[1].bullets, [{ text: "Market moved", level: 0 }, { text: "Two competitors left", level: 1 }, { text: "We are ready", level: 0 }]);
  assert.equal(d.slides[1].notes, "Mention the survey.\nKeep it short.");
  assert.deepEqual(d.slides[2].right, [{ text: "Buy", level: 0 }]);
  assert.equal(d.slides[4].subtitle, "Ship the smallest useful thing.");
  assert.deepEqual(fromOutline(toOutline(d)), d, "outline round-trips");
});

test("pptx: every part well-formed, one slide part per slide, round trip", () => {
  const d = fromOutline(outline);
  const entries = toPptx(d);
  for (const e of entries) if (typeof e.content === "string") assert.equal(wellFormed(e.content), null, e.path);
  assert.equal(entries.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.path)).length, 5);
  const back = fromPptx(asMap(entries));
  assert.deepEqual(back.slides.map((s) => s.layout), ["title", "content", "two", "section", "quote"]);
  assert.deepEqual(back.slides.map((s) => s.title), d.slides.map((s) => s.title));
  assert.deepEqual(back.slides[1].bullets, d.slides[1].bullets);
  assert.equal(back.slides[0].subtitle, "Q4 2026");
  assert.equal(back.slides[4].subtitle, "Ship the smallest useful thing.");
});

test("odp: well-formed, and round trip keeps notes and nested levels", () => {
  const d = fromOutline(outline);
  const entries = toOdp(d);
  assert.equal(entries[0].path, "mimetype");
  for (const e of entries.slice(1)) if (typeof e.content === "string") assert.equal(wellFormed(e.content), null, e.path);
  const back = fromOdp(asMap(entries));
  assert.deepEqual(back.slides.map((s) => s.layout), ["title", "content", "two", "section", "quote"]);
  assert.deepEqual(back.slides[1].bullets, d.slides[1].bullets);
  assert.equal(back.slides[1].notes, d.slides[1].notes);
});

test("themes: a hostile theme cannot inject into the exported deck", () => {
  const t = normaliseTheme({ bg: "red;}</style><script>", fg: "#fff", font: "x}</style><script>alert(1)</script>" });
  assert.equal(t.bg, THEMES.midnight.bg);
  assert.equal(t.font, THEMES.midnight.font);
  const html = toHtmlDeck({ ...fromOutline("# <b>x</b>\n## s\n- <img src=x onerror=alert(1)>"), theme: t });
  assert.ok(!html.includes("<img src=x"));
  assert.ok(!html.includes("<b>x</b>"));
  assert.equal((html.match(/<section/g) ?? []).length, 2);
});

/* ── Math ────────────────────────────────────────────────────────────────── */

const mm = (s) => latexToMathML(s);

test("math: fractions, roots, scripts", () => {
  assert.equal(mm("\\frac{a}{b}"), '<math xmlns="http://www.w3.org/1998/Math/MathML"><mfrac><mi>a</mi><mi>b</mi></mfrac></math>');
  assert.match(mm("\\sqrt[3]{x}"), /<mroot><mi>x<\/mi><mrow><mn>3<\/mn><\/mrow><\/mroot>/);
  assert.match(mm("x^2_i"), /<msubsup><mi>x<\/mi><mi>i<\/mi><mn>2<\/mn><\/msubsup>/, "either order of ^ and _");
  assert.match(mm("e^{i\\pi}"), /<msup><mi>e<\/mi><mrow><mi>i<\/mi><mi>π<\/mi><\/mrow><\/msup>/);
});

test("math: big operators take limits under and over; integrals take them as scripts", () => {
  assert.match(mm("\\sum_{i=1}^{n} i"), /<munderover><mo largeop="true">∑<\/mo>/);
  assert.match(mm("\\int_0^1 f"), /<msubsup><mo largeop="true">∫<\/mo>/);
  assert.match(mm("\\lim_{x \\to 0}"), /<munder><mi>lim<\/mi>/);
});

test("math: fences, matrices, text, blackboard", () => {
  assert.match(mm("\\left( x \\right)"), /<mo fence="true">\(<\/mo><mi>x<\/mi><mo fence="true">\)<\/mo>/);
  const m = mm("\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}");
  assert.equal((m.match(/<mtr>/g) ?? []).length, 2);
  assert.equal((m.match(/<mtd>/g) ?? []).length, 4);
  assert.match(mm("\\text{if } x"), /<mtext>if <\/mtext>/);
  assert.match(mm("\\mathbb{R}"), /<mi>ℝ<\/mi>/);
});

test("math: output is always well-formed and never carries markup from the input", () => {
  for (const s of ["\\frac{<script>}{b}", "\\text{</math><img src=x>}", "}}}{{{", "\\left( x", "a^", "\\begin{pmatrix} a &", "\\unknowncmd{x}", "<b>", "&amp;"]) {
    const out = mm(s);
    assert.equal(wellFormed(out), null, s);
    assert.ok(!/<(script|img|b)[ >]/.test(out), s);
  }
  assert.match(mm("\\foo"), /<merror>/);
});

/* ── Base ────────────────────────────────────────────────────────────────── */

const tables = [{
  name: "orders",
  columns: [{ name: "id", type: "number" }, { name: "customer", type: "text" }, { name: "amount", type: "number" }, { name: "day", type: "date" }, { name: "paid", type: "bool" }],
  rows: [
    [1, "Ann", 120, "2026-09-01", true],
    [2, "Bob", 80, "2026-09-02", false],
    [3, "Ann", 45.5, "2026-09-10", true],
    [4, "Cy", null, "2026-10-01", false],
    [5, "bob", 200, "2026-10-03", true],
  ],
}];
const q = (sql) => runQuery(tables, sql);

test("base: select, where, order, limit", () => {
  assert.deepEqual(q("SELECT customer, amount FROM orders WHERE amount > 50 ORDER BY amount DESC LIMIT 2").rows, [["bob", 200], ["Ann", 120]]);
  assert.deepEqual(q("SELECT id FROM orders WHERE customer LIKE 'b%' ORDER BY id").rows, [[2], [5]], "LIKE is case-insensitive");
  assert.deepEqual(q("SELECT id FROM orders WHERE amount IS NULL").rows, [[4]]);
  assert.deepEqual(q("SELECT id FROM orders WHERE day BETWEEN '2026-09-01' AND '2026-09-30' AND paid = TRUE").rows, [[1], [3]]);
  assert.deepEqual(q("SELECT id FROM orders WHERE customer IN ('Cy', 'Ann') AND NOT paid = TRUE").rows, [[4]]);
});

test("base: aggregates, group by, having, order by alias and position", () => {
  const r = q("SELECT LOWER(customer) AS who, COUNT(*) AS n, SUM(amount) AS total FROM orders GROUP BY LOWER(customer) HAVING COUNT(*) > 1 ORDER BY total DESC");
  assert.deepEqual(r.columns, ["who", "n", "total"]);
  assert.deepEqual(r.rows, [["bob", 2, 280], ["ann", 2, 165.5]]);
  assert.deepEqual(q("SELECT COUNT(*), AVG(amount), MIN(day), MAX(amount) FROM orders").rows, [[5, 111.375, "2026-09-01", 200]], "AVG skips NULL");
  assert.deepEqual(q("SELECT customer, amount FROM orders WHERE amount IS NOT NULL ORDER BY 2 LIMIT 1").rows, [["Ann", 45.5]]);
  assert.deepEqual(q("SELECT DISTINCT paid FROM orders ORDER BY paid").rows, [[false], [true]]);
});

test("base: SELECT only; anything else is refused with a readable reason", () => {
  assert.throws(() => q("DELETE FROM orders"), /Expected SELECT/);
  assert.throws(() => q("SELECT * FROM orders; DROP TABLE orders"), /after the end/);
  assert.throws(() => q("SELECT nope FROM orders"), /No column "nope"/);
  assert.throws(() => q("SELECT * FROM people"), /No table named "people"/);
  assert.throws(() => q("SELECT EVAL(1) FROM orders"), /Unknown function/);
  assert.equal(parseSql("select * from orders -- comment").from, "orders");
});

test("base: type inference and coercion", () => {
  assert.equal(inferType(["1", "2.5", "-3", ""]), "number");
  assert.equal(inferType(["2026-09-01", "2026-10-02"]), "date");
  assert.equal(inferType(["yes", "No"]), "bool");
  assert.equal(inferType(["1", "x"]), "text");
  assert.equal(coerce("1,200", "number"), 1200);
  assert.equal(coerce("abc", "number"), null);
  assert.match(schemaText(tables), /^orders\(id number, customer text, amount number, day date, paid bool\) -- 5 rows$/);
});

/* ── Draw ────────────────────────────────────────────────────────────────── */

const box = (id, x, y, kind = "rect") => ({ id, kind, x, y, w: 100, h: 50, fill: "#ffffff", stroke: "#000000", strokeW: 1 });

test("draw: connectors leave from the outline, not the centre", () => {
  assert.deepEqual(boundaryPoint(box("a", 0, 0), 500, 25), [100, 25], "rectangle, to the right");
  const [x, y] = boundaryPoint(box("e", 0, 0, "ellipse"), 50, 500);
  assert.equal(Math.round(x), 50);
  assert.equal(Math.round(y), 50, "ellipse, straight down: the bottom of the ellipse");
  const [dx, dy] = boundaryPoint(box("d", 0, 0, "diamond"), 50 + 100, 25 + 50);
  assert.ok(Math.abs(dx / 100 + dy / 50 - 1.5) < 1e-9 || Math.abs((dx - 50) / 50 + (dy - 25) / 25 - 1) < 1e-9, "on the diamond's edge");
  const byId = new Map([["a", box("a", 0, 0)], ["b", box("b", 300, 0)]]);
  assert.deepEqual(connectorEnds({ id: "c", kind: "connector", from: "a", to: "b" }, byId), [[100, 25], [300, 25]]);
});

test("draw: align and distribute", () => {
  const shapes = [box("a", 0, 0), box("b", 50, 100), box("c", 400, 30)];
  assert.deepEqual(align(shapes, ["a", "b", "c"], "top").map((s) => s.y), [0, 0, 0]);
  assert.deepEqual(align(shapes, ["a", "b", "c"], "right").map((s) => s.x), [400, 400, 400]);
  const d = distribute(shapes, ["a", "b", "c"], "x");
  assert.deepEqual(d.map((s) => s.x), [0, 200, 400], "equal gaps of 100");
});

test("draw: svg is well-formed and escapes labels", () => {
  const svg = toSvg([{ ...box("a", 0, 0), text: "<script>x</script> & y" }, box("b", 200, 0, "ellipse"), { id: "c", kind: "connector", from: "a", to: "b", stroke: "#000000", strokeW: 2, fill: "none", x: 0, y: 0, w: 0, h: 0 }], { bg: "#ffffff" });
  assert.equal(wellFormed(svg), null);
  assert.ok(!svg.includes("<script>"));
  assert.match(svg, /marker-end="url\(#arrow\)"/);
});

test("draw: a model's diagram is validated before it is drawn", () => {
  assert.equal(parseDiagram({ nodes: [{ id: "a" }, { id: "a" }] }).ok, false, "duplicate ids");
  assert.match(parseDiagram({ nodes: [{ id: "a" }], edges: [{ from: "a", to: "zz" }] }).reason, /does not exist/);
  const ok = parseDiagram({ nodes: [{ id: 1, label: "Start", shape: "ellipse", color: "javascript:x" }, { id: 2, label: "End", shape: "hexagon" }], edges: [{ from: 1, to: 2 }] });
  assert.equal(ok.ok, true);
  assert.equal(ok.spec.nodes[1].shape, "rect", "unknown shapes fall back");
  assert.equal(ok.spec.nodes[0].color, undefined, "only hex colours survive");
});

test("draw: layered layout puts each node below everything that leads to it, cycles included", () => {
  const spec = { nodes: ["a", "b", "c", "d"].map((id) => ({ id, label: id })), edges: [{ from: "a", to: "b" }, { from: "a", to: "c" }, { from: "b", to: "d" }, { from: "c", to: "d" }, { from: "d", to: "a" }] };
  const shapes = layoutGraph(spec);
  const y = (id) => shapes.find((s) => s.id === `n-${id}`).y;
  assert.ok(y("a") < y("b") && y("b") === y("c") && y("c") < y("d"));
  assert.equal(shapes.filter((s) => s.kind === "connector").length, 5, "the back edge is still drawn");
  const nodes = shapes.filter((s) => s.kind !== "connector");
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const p = nodes[i], r = nodes[j];
    assert.ok(p.x + p.w <= r.x || r.x + r.w <= p.x || p.y + p.h <= r.y || r.y + r.h <= p.y, `${p.id} overlaps ${r.id}`);
  }
});

test("draw: odg export is well-formed", () => {
  const entries = toOdg(layoutGraph({ nodes: [{ id: "a", label: "A & B" }, { id: "b", label: "C", shape: "diamond" }], edges: [{ from: "a", to: "b", label: "yes" }] }));
  assert.equal(entries[0].path, "mimetype");
  for (const e of entries.slice(1)) assert.equal(wellFormed(e.content), null, e.path);
});
