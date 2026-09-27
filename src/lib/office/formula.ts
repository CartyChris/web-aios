/* ────────────────────────────────────────────────────────────────────────────
   Spreadsheet formulas: parse, evaluate, and shift for fill/copy.

   The Calc app's engine. A workbook is a list of sheets, each a map from "A1"
   to what the person typed. Anything starting with "=" is a formula; the rest
   is a literal (number, percentage, TRUE/FALSE, or text).

   Semantics follow Excel/LibreOffice where it matters for trust:
   - operator precedence: comparison < & < + - < * / < ^ < unary minus < %
   - errors are values that propagate (#DIV/0!, #VALUE!, #REF!, #NAME?, #N/A,
     #NUM!), and a formula that depends on itself is #CYCLE! rather than a
     stack overflow;
   - aggregates over a RANGE skip text and blanks, as SUM(A1:A9) does;
   - IF, IFERROR, IFS, CHOOSE, AND, OR evaluate lazily, so an error in the
     branch not taken does not poison the result.

   PURE. The clock for TODAY/NOW is a parameter.
   ──────────────────────────────────────────────────────────────────────────── */

export type ErrCode = "#DIV/0!" | "#VALUE!" | "#REF!" | "#NAME?" | "#N/A" | "#NUM!" | "#CYCLE!" | "#ERROR!";
export interface FErr { error: ErrCode; detail?: string }
export type Scalar = number | string | boolean | null | FErr;

export interface Sheet { name: string; cells: Record<string, string> }
export interface Workbook { sheets: Sheet[] }

export const isErr = (v: unknown): v is FErr => typeof v === "object" && v !== null && "error" in v;
const err = (error: ErrCode, detail?: string): FErr => (detail ? { error, detail } : { error });

/* ── addresses ───────────────────────────────────────────────────────────── */

export function colToIndex(col: string): number {
  let n = 0;
  for (const ch of col.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function indexToCol(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export const addr = (c: number, r: number): string => `${indexToCol(c)}${r + 1}`;

export function parseAddr(a: string): { c: number; r: number; absC: boolean; absR: boolean } | null {
  const m = /^(\$?)([A-Za-z]{1,3})(\$?)([0-9]{1,7})$/.exec(a.trim());
  if (!m) return null;
  const r = Number(m[4]) - 1;
  if (r < 0) return null;
  return { c: colToIndex(m[2]), r, absC: m[1] === "$", absR: m[3] === "$" };
}

/* ── tokens ──────────────────────────────────────────────────────────────── */

type Tok =
  | { t: "num"; v: number; s: number; e: number }
  | { t: "str"; v: string; s: number; e: number }
  | { t: "bool"; v: boolean; s: number; e: number }
  | { t: "ref"; sheet?: string; ref: string; s: number; e: number }
  | { t: "ident"; v: string; s: number; e: number }
  | { t: "op"; v: string; s: number; e: number }
  | { t: "err"; v: ErrCode; s: number; e: number }
  | { t: "(" | ")" | "," | ":"; s: number; e: number };

const REF_RE = /^(?:('(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!)?(\$?[A-Za-z]{1,3}\$?[0-9]{1,7})(?![A-Za-z0-9_(])/;
const ERRS: ErrCode[] = ["#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#N/A", "#NUM!", "#CYCLE!", "#ERROR!"];

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    const s = i;
    if (ch === '"') {
      let v = "";
      i++;
      while (i < src.length) {
        if (src[i] === '"') { if (src[i + 1] === '"') { v += '"'; i += 2; continue; } break; }
        v += src[i++];
      }
      if (src[i] !== '"') throw new SyntaxError("Unclosed text in quotes.");
      i++;
      out.push({ t: "str", v, s, e: i });
      continue;
    }
    if (ch === "#") {
      const e = ERRS.find((x) => src.startsWith(x, i));
      if (!e) throw new SyntaxError(`Unknown error value at ${i + 1}.`);
      i += e.length;
      out.push({ t: "err", v: e, s, e: i });
      continue;
    }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
    // A number, unless it is the row part of something like "1:1" (unsupported) -- digits followed by a letter are a ref.
    if (num && !/^[A-Za-z]/.test(src.slice(i + num[0].length))) {
      i += num[0].length;
      out.push({ t: "num", v: Number(num[0]), s, e: i });
      continue;
    }
    const ref = REF_RE.exec(src.slice(i));
    if (ref) {
      i += ref[0].length;
      const sheet = ref[1] ? (ref[1].startsWith("'") ? ref[1].slice(1, -1).replace(/''/g, "'") : ref[1]) : undefined;
      out.push({ t: "ref", sheet, ref: ref[2].toUpperCase(), s, e: i });
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i));
    if (id) {
      i += id[0].length;
      const up = id[0].toUpperCase();
      if (up === "TRUE" || up === "FALSE") out.push({ t: "bool", v: up === "TRUE", s, e: i });
      else out.push({ t: "ident", v: up, s, e: i });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "<>") { i += 2; out.push({ t: "op", v: two, s, e: i }); continue; }
    if ("+-*/^&=<>%".includes(ch)) { i++; out.push({ t: "op", v: ch, s, e: i }); continue; }
    if (ch === "(" || ch === ")" || ch === ":") { i++; out.push({ t: ch, s, e: i }); continue; }
    if (ch === "," || ch === ";") { i++; out.push({ t: ",", s, e: i }); continue; }
    throw new SyntaxError(`Unexpected "${ch}" at ${i + 1}.`);
  }
  return out;
}

/* ── syntax tree ─────────────────────────────────────────────────────────── */

export type Node =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "err"; v: ErrCode }
  | { k: "ref"; sheet?: string; c: number; r: number }
  | { k: "range"; sheet?: string; c1: number; r1: number; c2: number; r2: number }
  | { k: "un"; op: string; a: Node }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "pct"; a: Node }
  | { k: "call"; name: string; args: Node[] };

const BIN: Record<string, number> = { "=": 1, "<>": 1, "<": 1, ">": 1, "<=": 1, ">=": 1, "&": 2, "+": 3, "-": 3, "*": 4, "/": 4, "^": 5 };

export function parseFormula(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];

  function expr(minPrec: number): Node {
    let left = unary();
    for (;;) {
      const t = peek();
      if (!t || t.t !== "op" || !(t.v in BIN)) break;
      const prec = BIN[t.v];
      if (prec < minPrec) break;
      next();
      // Every operator is left-associative, ^ included: spreadsheets give
      // 2^3^2 = 64, not the 512 of written maths, and people check against them.
      const right = expr(prec + 1);
      left = { k: "bin", op: t.v, a: left, b: right };
    }
    return left;
  }

  function unary(): Node {
    const t = peek();
    if (t && t.t === "op" && (t.v === "-" || t.v === "+")) {
      next();
      const a = unary();
      return t.v === "-" ? { k: "un", op: "-", a } : a;
    }
    // Unary minus binds tighter than ^ here (=-2^2 is 4), as in Excel and LibreOffice.
    let n = primary();
    while (peek()?.t === "op" && (peek() as { v: string }).v === "%") { next(); n = { k: "pct", a: n }; }
    return n;
  }

  function primary(): Node {
    const t = next();
    if (!t) throw new SyntaxError("The formula ends too early.");
    switch (t.t) {
      case "num": return { k: "num", v: t.v };
      case "str": return { k: "str", v: t.v };
      case "bool": return { k: "bool", v: t.v };
      case "err": return { k: "err", v: t.v };
      case "(": {
        const e = expr(1);
        if (next()?.t !== ")") throw new SyntaxError("Missing a closing bracket.");
        return e;
      }
      case "ref": {
        const a = parseAddr(t.ref)!;
        if (peek()?.t === ":") {
          next();
          const u = next();
          if (!u || u.t !== "ref") throw new SyntaxError("A range needs a cell after the colon.");
          const b = parseAddr(u.ref)!;
          return { k: "range", sheet: t.sheet, c1: Math.min(a.c, b.c), r1: Math.min(a.r, b.r), c2: Math.max(a.c, b.c), r2: Math.max(a.r, b.r) };
        }
        return { k: "ref", sheet: t.sheet, c: a.c, r: a.r };
      }
      case "ident": {
        if (peek()?.t !== "(") throw new SyntaxError(`"${t.v}" is not a function call or a cell.`);
        next();
        const args: Node[] = [];
        if (peek()?.t === ")") { next(); return { k: "call", name: t.v, args }; }
        for (;;) {
          // An empty argument (e.g. IF(A1,,2)) is a blank.
          if (peek()?.t === "," || peek()?.t === ")") args.push({ k: "str", v: "" });
          else args.push(expr(1));
          const sep = next();
          if (!sep) throw new SyntaxError(`Missing a closing bracket for ${t.v}.`);
          if (sep.t === ")") break;
          if (sep.t !== ",") throw new SyntaxError(`Expected , or ) in ${t.v}.`);
        }
        return { k: "call", name: t.v, args };
      }
      default:
        throw new SyntaxError("Unexpected symbol in the formula.");
    }
  }

  const tree = expr(1);
  if (p < toks.length) throw new SyntaxError("Unexpected text after the end of the formula.");
  return tree;
}

/* ── fill / copy ─────────────────────────────────────────────────────────── */

/** Shift the relative references in a formula by (dr, dc), as fill and paste
 *  do. `$` parts stay put; a reference pushed off the sheet becomes #REF!. */
export function shiftFormula(src: string, dr: number, dc: number): string {
  if (!src.startsWith("=")) return src;
  let toks: Tok[];
  try { toks = tokenize(src.slice(1)); } catch { return src; }
  let out = "";
  let last = 0;
  const body = src.slice(1);
  for (const t of toks) {
    if (t.t !== "ref") continue;
    const a = parseAddr(t.ref)!;
    const c = a.absC ? a.c : a.c + dc;
    const r = a.absR ? a.r : a.r + dr;
    const sheetPart = body.slice(t.s, t.e).slice(0, body.slice(t.s, t.e).length - t.ref.length);
    const moved = c < 0 || r < 0 ? "#REF!" : `${sheetPart}${a.absC ? "$" : ""}${indexToCol(c)}${a.absR ? "$" : ""}${r + 1}`;
    out += body.slice(last, t.s) + moved;
    last = t.e;
  }
  return `=${out}${body.slice(last)}`;
}

/* ── values ──────────────────────────────────────────────────────────────── */

interface Range { range: true; rows: Scalar[][] }
type Val = Scalar | Range;
const isRange = (v: Val): v is Range => typeof v === "object" && v !== null && "range" in v;

export function literal(raw: string): Scalar {
  const s = raw.trim();
  if (s === "") return null;
  if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return Number(s);
  if (/^[+-]?(\d{1,3}(,\d{3})+)(\.\d+)?$/.test(s)) return Number(s.replace(/,/g, ""));
  if (/^[+-]?(\d+\.?\d*|\.\d+)%$/.test(s)) return Number(s.slice(0, -1)) / 100;
  const up = s.toUpperCase();
  if (up === "TRUE") return true;
  if (up === "FALSE") return false;
  return raw;
}

function toNum(v: Scalar): number | FErr {
  if (isErr(v)) return v;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === null || v === "") return 0;
  const l = literal(v);
  return typeof l === "number" ? l : err("#VALUE!", `"${v}" is not a number`);
}

function toStr(v: Scalar): string {
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return formatNumber(v);
  if (isErr(v)) return v.error;
  return v;
}

function toBool(v: Scalar): boolean | FErr {
  if (isErr(v)) return v;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (v === null || v === "") return false;
  const u = v.toUpperCase();
  if (u === "TRUE") return true;
  if (u === "FALSE") return false;
  return err("#VALUE!");
}

/** Display a number the way a spreadsheet does: no float noise. */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "#NUM!";
  if (Number.isInteger(n)) return String(n);
  const s = String(Number(n.toPrecision(12)));
  return s;
}

export function displayValue(v: Scalar): string {
  return isErr(v) ? v.error : toStr(v);
}

function compare(a: Scalar, b: Scalar): number {
  // Blank compares as 0 against numbers and "" against text.
  const rank = (x: Scalar) => (typeof x === "number" || x === null ? 0 : typeof x === "string" ? 1 : 2);
  const an = a === null && typeof b === "string" ? "" : a;
  const bn = b === null && typeof a === "string" ? "" : b;
  const ra = rank(an), rb = rank(bn);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return (Number(an ?? 0)) - (Number(bn ?? 0));
  if (ra === 1) return String(an).toLowerCase().localeCompare(String(bn).toLowerCase());
  return Number(an) - Number(bn);
}

function flat(vals: Val[]): Array<{ v: Scalar; fromRange: boolean }> {
  const out: Array<{ v: Scalar; fromRange: boolean }> = [];
  for (const v of vals) {
    if (isRange(v)) for (const row of v.rows) for (const x of row) out.push({ v: x, fromRange: true });
    else out.push({ v, fromRange: false });
  }
  return out;
}

/** Numbers for an aggregate: from ranges, only real numbers; direct arguments are coerced. */
function numbers(vals: Val[]): number[] | FErr {
  const out: number[] = [];
  for (const { v, fromRange } of flat(vals)) {
    if (isErr(v)) return v;
    if (fromRange) { if (typeof v === "number") out.push(v); continue; }
    const n = toNum(v);
    if (isErr(n)) return n;
    out.push(n);
  }
  return out;
}

/* ── criteria (SUMIF, COUNTIF, AVERAGEIF) ────────────────────────────────── */

export function matchesCriterion(value: Scalar, crit: Scalar): boolean {
  if (typeof crit === "number" || typeof crit === "boolean") return compare(value, crit) === 0 && typeof value === typeof crit;
  const c = crit === null ? "" : isErr(crit) ? crit.error : crit;
  const m = /^(<=|>=|<>|<|>|=)?(.*)$/s.exec(c)!;
  const op = m[1] ?? "=";
  const rhsRaw = m[2];
  const rhs = literal(rhsRaw);
  if (typeof rhs === "number") {
    if (typeof value !== "number") return op === "<>";
    const d = value - rhs;
    return op === "=" ? d === 0 : op === "<>" ? d !== 0 : op === "<" ? d < 0 : op === ">" ? d > 0 : op === "<=" ? d <= 0 : d >= 0;
  }
  const text = value === null ? "" : toStr(value);
  if (op === "=" || op === "<>") {
    const re = new RegExp(`^${rhsRaw.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "is");
    const hit = rhsRaw === "" ? value === null || value === "" : re.test(text);
    return op === "=" ? hit : !hit;
  }
  const d = text.toLowerCase().localeCompare(rhsRaw.toLowerCase());
  return op === "<" ? d < 0 : op === ">" ? d > 0 : op === "<=" ? d <= 0 : d >= 0;
}

/* ── dates: serial days since 1899-12-30, like every spreadsheet ────────── */

const EPOCH = Date.UTC(1899, 11, 30);
export const dateToSerial = (y: number, m: number, d: number): number => Math.round((Date.UTC(y, m - 1, d) - EPOCH) / 86_400_000);
function serialToDate(n: number): Date { return new Date(EPOCH + Math.floor(n) * 86_400_000); }

/* ── evaluation ──────────────────────────────────────────────────────────── */

export interface EvalOptions {
  /** ms since the epoch, for TODAY() and NOW(). */
  now?: number;
  /** Date.getTimezoneOffset() convention, for TODAY(). */
  tzOffsetMin?: number;
}

type Fn = (args: Node[], ev: (n: Node) => Val, ctx: Ctx) => Val;
interface Ctx { now: number; tz: number }

const num1 = (f: (x: number) => number): Fn => (args, ev) => {
  if (args.length !== 1) return err("#VALUE!", "needs 1 argument");
  const v = ev(args[0]);
  if (isRange(v)) return err("#VALUE!");
  const n = toNum(v);
  if (isErr(n)) return n;
  const r = f(n);
  return Number.isFinite(r) ? r : err("#NUM!");
};

const scal = (v: Val): Scalar => (isRange(v) ? v.rows[0]?.[0] ?? null : v);

const FUNCS: Record<string, Fn> = {
  SUM: (a, ev) => { const n = numbers(a.map(ev)); return isErr(n) ? n : n.reduce((x, y) => x + y, 0); },
  PRODUCT: (a, ev) => { const n = numbers(a.map(ev)); return isErr(n) ? n : n.reduce((x, y) => x * y, 1); },
  AVERAGE: (a, ev) => { const n = numbers(a.map(ev)); return isErr(n) ? n : n.length ? n.reduce((x, y) => x + y, 0) / n.length : err("#DIV/0!"); },
  MIN: (a, ev) => { const n = numbers(a.map(ev)); return isErr(n) ? n : n.length ? Math.min(...n) : 0; },
  MAX: (a, ev) => { const n = numbers(a.map(ev)); return isErr(n) ? n : n.length ? Math.max(...n) : 0; },
  MEDIAN: (a, ev) => {
    const n = numbers(a.map(ev));
    if (isErr(n)) return n;
    if (!n.length) return err("#NUM!");
    const s = [...n].sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  },
  STDEV: (a, ev) => { const n = numbers(a.map(ev)); if (isErr(n)) return n; if (n.length < 2) return err("#DIV/0!"); const mu = n.reduce((x, y) => x + y, 0) / n.length; return Math.sqrt(n.reduce((s, x) => s + (x - mu) ** 2, 0) / (n.length - 1)); },
  VAR: (a, ev) => { const n = numbers(a.map(ev)); if (isErr(n)) return n; if (n.length < 2) return err("#DIV/0!"); const mu = n.reduce((x, y) => x + y, 0) / n.length; return n.reduce((s, x) => s + (x - mu) ** 2, 0) / (n.length - 1); },
  COUNT: (a, ev) => flat(a.map(ev)).filter(({ v, fromRange }) => typeof v === "number" || (!fromRange && typeof toNum(v) === "number" && v !== null && v !== "")).length,
  COUNTA: (a, ev) => flat(a.map(ev)).filter(({ v }) => v !== null && v !== "").length,
  COUNTBLANK: (a, ev) => flat(a.map(ev)).filter(({ v }) => v === null || v === "").length,
  LARGE: (a, ev) => { const n = numbers([ev(a[0])]); const k = toNum(scal(ev(a[1]))); if (isErr(n)) return n; if (isErr(k)) return k; const s = [...n].sort((x, y) => y - x); return k >= 1 && k <= s.length ? s[Math.floor(k) - 1] : err("#NUM!"); },
  SMALL: (a, ev) => { const n = numbers([ev(a[0])]); const k = toNum(scal(ev(a[1]))); if (isErr(n)) return n; if (isErr(k)) return k; const s = [...n].sort((x, y) => x - y); return k >= 1 && k <= s.length ? s[Math.floor(k) - 1] : err("#NUM!"); },
  SUMPRODUCT: (a, ev) => {
    const rs = a.map(ev);
    if (!rs.every(isRange)) return err("#VALUE!");
    const ranges = rs as Range[];
    const h = ranges[0].rows.length, w = ranges[0].rows[0]?.length ?? 0;
    if (ranges.some((r) => r.rows.length !== h || (r.rows[0]?.length ?? 0) !== w)) return err("#VALUE!", "ranges must be the same size");
    let s = 0;
    for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) s += ranges.reduce((p, r) => p * (typeof r.rows[i][j] === "number" ? (r.rows[i][j] as number) : 0), 1);
    return s;
  },

  ABS: num1(Math.abs),
  SQRT: num1((x) => (x < 0 ? NaN : Math.sqrt(x))),
  INT: num1(Math.floor),
  EXP: num1(Math.exp),
  LN: num1((x) => (x <= 0 ? NaN : Math.log(x))),
  LOG10: num1((x) => (x <= 0 ? NaN : Math.log10(x))),
  SIGN: num1(Math.sign),
  PI: () => Math.PI,
  POWER: (a, ev) => { const x = toNum(scal(ev(a[0]))), y = toNum(scal(ev(a[1]))); if (isErr(x)) return x; if (isErr(y)) return y; const r = x ** y; return Number.isFinite(r) ? r : err("#NUM!"); },
  MOD: (a, ev) => { const x = toNum(scal(ev(a[0]))), y = toNum(scal(ev(a[1]))); if (isErr(x)) return x; if (isErr(y)) return y; if (y === 0) return err("#DIV/0!"); return x - y * Math.floor(x / y); },
  ROUND: (a, ev) => roundWith(a, ev, Math.round),
  ROUNDUP: (a, ev) => roundWith(a, ev, (x) => Math.sign(x) * Math.ceil(Math.abs(x))),
  ROUNDDOWN: (a, ev) => roundWith(a, ev, (x) => Math.sign(x) * Math.floor(Math.abs(x))),

  IF: (a, ev) => {
    const c = toBool(scal(ev(a[0])));
    if (isErr(c)) return c;
    return c ? (a[1] ? ev(a[1]) : true) : a[2] ? ev(a[2]) : false;
  },
  IFS: (a, ev) => {
    for (let i = 0; i + 1 < a.length; i += 2) {
      const c = toBool(scal(ev(a[i])));
      if (isErr(c)) return c;
      if (c) return ev(a[i + 1]);
    }
    return err("#N/A", "no condition was true");
  },
  IFERROR: (a, ev) => { const v = ev(a[0]); return isErr(scal(v)) ? ev(a[1]) : v; },
  IFNA: (a, ev) => { const v = ev(a[0]); const s = scal(v); return isErr(s) && s.error === "#N/A" ? ev(a[1]) : v; },
  AND: (a, ev) => { for (const x of a) { for (const { v } of flat([ev(x)])) { if (v === null) continue; const b = toBool(v); if (isErr(b)) return b; if (!b) return false; } } return true; },
  OR: (a, ev) => { for (const x of a) { for (const { v } of flat([ev(x)])) { if (v === null) continue; const b = toBool(v); if (isErr(b)) return b; if (b) return true; } } return false; },
  NOT: (a, ev) => { const b = toBool(scal(ev(a[0]))); return isErr(b) ? b : !b; },
  CHOOSE: (a, ev) => { const i = toNum(scal(ev(a[0]))); if (isErr(i)) return i; const k = Math.floor(i); return k >= 1 && k < a.length ? ev(a[k]) : err("#VALUE!"); },
  ISBLANK: (a, ev) => { const v = scal(ev(a[0])); return v === null; },
  ISNUMBER: (a, ev) => typeof scal(ev(a[0])) === "number",
  ISTEXT: (a, ev) => typeof scal(ev(a[0])) === "string",
  ISERROR: (a, ev) => isErr(scal(ev(a[0]))),

  CONCAT: (a, ev) => { let s = ""; for (const { v } of flat(a.map(ev))) { if (isErr(v)) return v; s += toStr(v); } return s; },
  CONCATENATE: (a, ev) => FUNCS.CONCAT(a, ev, { now: 0, tz: 0 }),
  TEXTJOIN: (a, ev) => {
    const sep = toStr(scal(ev(a[0])));
    const skip = toBool(scal(ev(a[1])));
    if (isErr(skip)) return skip;
    const parts: string[] = [];
    for (const { v } of flat(a.slice(2).map(ev))) { if (isErr(v)) return v; if (skip && (v === null || v === "")) continue; parts.push(toStr(v)); }
    return parts.join(sep);
  },
  LEN: (a, ev) => { const v = scal(ev(a[0])); return isErr(v) ? v : toStr(v).length; },
  UPPER: (a, ev) => { const v = scal(ev(a[0])); return isErr(v) ? v : toStr(v).toUpperCase(); },
  LOWER: (a, ev) => { const v = scal(ev(a[0])); return isErr(v) ? v : toStr(v).toLowerCase(); },
  PROPER: (a, ev) => { const v = scal(ev(a[0])); return isErr(v) ? v : toStr(v).toLowerCase().replace(/(^|[^a-z])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase()); },
  TRIM: (a, ev) => { const v = scal(ev(a[0])); return isErr(v) ? v : toStr(v).trim().replace(/ {2,}/g, " "); },
  LEFT: (a, ev) => { const v = scal(ev(a[0])); const n = a[1] ? toNum(scal(ev(a[1]))) : 1; if (isErr(v)) return v; if (isErr(n)) return n; return toStr(v).slice(0, Math.max(0, n)); },
  RIGHT: (a, ev) => { const v = scal(ev(a[0])); const n = a[1] ? toNum(scal(ev(a[1]))) : 1; if (isErr(v)) return v; if (isErr(n)) return n; const s = toStr(v); return n <= 0 ? "" : s.slice(-n); },
  MID: (a, ev) => { const v = scal(ev(a[0])); const st = toNum(scal(ev(a[1]))), n = toNum(scal(ev(a[2]))); if (isErr(v)) return v; if (isErr(st)) return st; if (isErr(n)) return n; if (st < 1 || n < 0) return err("#VALUE!"); return toStr(v).substr(st - 1, n); },
  FIND: (a, ev) => { const needle = toStr(scal(ev(a[0]))), hay = toStr(scal(ev(a[1]))); const st = a[2] ? toNum(scal(ev(a[2]))) : 1; if (isErr(st)) return st; const i = hay.indexOf(needle, st - 1); return i < 0 ? err("#VALUE!", "not found") : i + 1; },
  SEARCH: (a, ev) => { const needle = toStr(scal(ev(a[0]))).toLowerCase(), hay = toStr(scal(ev(a[1]))).toLowerCase(); const i = hay.indexOf(needle); return i < 0 ? err("#VALUE!", "not found") : i + 1; },
  SUBSTITUTE: (a, ev) => { const s = toStr(scal(ev(a[0]))), from = toStr(scal(ev(a[1]))), to = toStr(scal(ev(a[2]))); return from ? s.split(from).join(to) : s; },
  REPT: (a, ev) => { const s = toStr(scal(ev(a[0]))); const n = toNum(scal(ev(a[1]))); if (isErr(n)) return n; if (n < 0 || n * s.length > 32767) return err("#VALUE!"); return s.repeat(Math.floor(n)); },
  VALUE: (a, ev) => toNum(scal(ev(a[0]))),
  TEXT: (a, ev) => { const n = toNum(scal(ev(a[0]))); if (isErr(n)) return n; return formatWithPattern(n, toStr(scal(ev(a[1])))); },

  SUMIF: (a, ev) => condAgg(a, ev, "sum"),
  COUNTIF: (a, ev) => condAgg(a, ev, "count"),
  AVERAGEIF: (a, ev) => condAgg(a, ev, "avg"),

  VLOOKUP: (a, ev) => {
    const key = scal(ev(a[0])), tbl = ev(a[1]), col = toNum(scal(ev(a[2])));
    const approx = a[3] ? toBool(scal(ev(a[3]))) : true;
    if (!isRange(tbl)) return err("#VALUE!");
    if (isErr(col)) return col;
    if (isErr(approx)) return approx;
    if (col < 1 || col > (tbl.rows[0]?.length ?? 0)) return err("#REF!");
    const i = lookupIndex(tbl.rows.map((r) => r[0]), key, approx ? 1 : 0);
    return i < 0 ? err("#N/A") : tbl.rows[i][Math.floor(col) - 1];
  },
  HLOOKUP: (a, ev) => {
    const key = scal(ev(a[0])), tbl = ev(a[1]), row = toNum(scal(ev(a[2])));
    const approx = a[3] ? toBool(scal(ev(a[3]))) : true;
    if (!isRange(tbl)) return err("#VALUE!");
    if (isErr(row)) return row;
    if (isErr(approx)) return approx;
    if (row < 1 || row > tbl.rows.length) return err("#REF!");
    const i = lookupIndex(tbl.rows[0], key, approx ? 1 : 0);
    return i < 0 ? err("#N/A") : tbl.rows[Math.floor(row) - 1][i];
  },
  MATCH: (a, ev) => {
    const key = scal(ev(a[0])), rng = ev(a[1]);
    const type = a[2] ? toNum(scal(ev(a[2]))) : 1;
    if (!isRange(rng)) return err("#VALUE!");
    if (isErr(type)) return type;
    const line = rng.rows.length === 1 ? rng.rows[0] : rng.rows.map((r) => r[0]);
    const i = lookupIndex(line, key, type);
    return i < 0 ? err("#N/A") : i + 1;
  },
  INDEX: (a, ev) => {
    const rng = ev(a[0]);
    if (!isRange(rng)) return err("#VALUE!");
    const r = toNum(scal(ev(a[1])));
    const c = a[2] ? toNum(scal(ev(a[2]))) : 1;
    if (isErr(r)) return r;
    if (isErr(c)) return c;
    // A single row given one index means a column index.
    if (rng.rows.length === 1 && !a[2]) return rng.rows[0][r - 1] ?? err("#REF!");
    return rng.rows[r - 1]?.[c - 1] ?? err("#REF!");
  },
  XLOOKUP: (a, ev) => {
    const key = scal(ev(a[0])), look = ev(a[1]), ret = ev(a[2]);
    if (!isRange(look) || !isRange(ret)) return err("#VALUE!");
    const vertical = look.rows.length > 1;
    const line = vertical ? look.rows.map((r) => r[0]) : look.rows[0];
    const i = lookupIndex(line, key, 0);
    if (i < 0) return a[3] ? ev(a[3]) : err("#N/A");
    return vertical ? ret.rows[i]?.[0] ?? err("#REF!") : ret.rows[0]?.[i] ?? err("#REF!");
  },

  TODAY: (_a, _ev, ctx) => { const d = new Date(ctx.now - ctx.tz * 60_000); return dateToSerial(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()); },
  NOW: (_a, _ev, ctx) => (ctx.now - ctx.tz * 60_000 - EPOCH) / 86_400_000,
  DATE: (a, ev) => { const y = toNum(scal(ev(a[0]))), m = toNum(scal(ev(a[1]))), d = toNum(scal(ev(a[2]))); if (isErr(y)) return y; if (isErr(m)) return m; if (isErr(d)) return d; return dateToSerial(y, m, d); },
  YEAR: (a, ev) => { const n = toNum(scal(ev(a[0]))); return isErr(n) ? n : serialToDate(n).getUTCFullYear(); },
  MONTH: (a, ev) => { const n = toNum(scal(ev(a[0]))); return isErr(n) ? n : serialToDate(n).getUTCMonth() + 1; },
  DAY: (a, ev) => { const n = toNum(scal(ev(a[0]))); return isErr(n) ? n : serialToDate(n).getUTCDate(); },
  WEEKDAY: (a, ev) => { const n = toNum(scal(ev(a[0]))); return isErr(n) ? n : serialToDate(n).getUTCDay() + 1; },
};

export const FUNCTION_NAMES = Object.keys(FUNCS).sort();

function roundWith(a: Node[], ev: (n: Node) => Val, f: (x: number) => number): Scalar {
  const x = toNum(scal(ev(a[0])));
  const d = a[1] ? toNum(scal(ev(a[1]))) : 0;
  if (isErr(x)) return x;
  if (isErr(d)) return d;
  const p = 10 ** Math.floor(d);
  // The epsilon makes 2.675 round to 2.68, as a person expects, not 2.67.
  return f(x * p + Math.sign(x) * 1e-9) / p;
}

function condAgg(a: Node[], ev: (n: Node) => Val, mode: "sum" | "count" | "avg"): Scalar {
  const rng = ev(a[0]);
  const crit = scal(ev(a[1]));
  const sumR = a[2] ? ev(a[2]) : rng;
  if (!isRange(rng) || !isRange(sumR)) return err("#VALUE!");
  let s = 0, n = 0;
  rng.rows.forEach((row, i) => row.forEach((v, j) => {
    if (!matchesCriterion(v, crit)) return;
    n++;
    const x = sumR.rows[i]?.[j];
    if (typeof x === "number") s += x;
  }));
  if (mode === "count") return n;
  if (mode === "sum") return s;
  return n ? s / n : err("#DIV/0!");
}

/** 0 = exact (wildcards allowed for text), 1 = largest <= key (sorted ascending), -1 = smallest >= key (sorted descending). */
function lookupIndex(line: Scalar[], key: Scalar, type: number): number {
  if (type === 0) {
    const crit = typeof key === "string" ? `=${key}` : key;
    return line.findIndex((v) => (typeof key === "string" ? matchesCriterion(v, crit) : compare(v, key) === 0 && v !== null));
  }
  let best = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === null) continue;
    const d = compare(line[i], key);
    if (type > 0 ? d <= 0 : d >= 0) best = i;
    else break;
  }
  return best;
}

/** A small subset of number formats: 0, 0.00, #,##0, #,##0.00, 0%, 0.0%, and a literal prefix/suffix like $ or " kg". */
export function formatWithPattern(n: number, pat: string): string {
  const m = /^([^#0]*)([#,0]*)(\.(0+))?(%?)(.*)$/.exec(pat);
  if (!m || !m[2]) return formatNumber(n);
  const [, pre, intPart, , dec = "", pct, post] = m;
  let x = pct ? n * 100 : n;
  const places = dec.length;
  x = Math.round(x * 10 ** places + Math.sign(x) * 1e-9) / 10 ** places;
  let s = Math.abs(x).toFixed(places);
  if (intPart.includes(",")) { const [i, f] = s.split("."); s = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (f ? `.${f}` : ""); }
  return `${x < 0 ? "-" : ""}${pre}${s}${pct}${post.replace(/^"|"$/g, "")}`;
}

/* ── the engine ──────────────────────────────────────────────────────────── */

export interface Evaluated {
  /** Sheet name -> address -> value, for every non-empty cell. */
  values: Record<string, Record<string, Scalar>>;
}

const MAX_RANGE_CELLS = 200_000;

export function evaluateWorkbook(wb: Workbook, opts: EvalOptions = {}): Evaluated {
  const ctx: Ctx = { now: opts.now ?? 0, tz: opts.tzOffsetMin ?? 0 };
  const byName = new Map(wb.sheets.map((s) => [s.name.toLowerCase(), s]));
  const cache = new Map<string, Scalar>();
  const visiting = new Set<string>();
  const trees = new Map<string, Node | FErr>();

  const sheetOf = (name: string | undefined, home: Sheet): Sheet | undefined => (name === undefined ? home : byName.get(name.toLowerCase()));

  function cellValue(sheet: Sheet, c: number, r: number): Scalar {
    const key = `${sheet.name}\u0000${c},${r}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    if (visiting.has(key)) return err("#CYCLE!", `${sheet.name}!${addr(c, r)} depends on itself`);
    const raw = sheet.cells[addr(c, r)];
    if (raw === undefined || raw === "") { cache.set(key, null); return null; }
    if (!raw.startsWith("=")) { const v = literal(raw); cache.set(key, v); return v; }
    visiting.add(key);
    let tree = trees.get(raw);
    if (!tree) {
      try { tree = parseFormula(raw.slice(1)); } catch (e) { tree = err("#ERROR!", (e as Error).message); }
      trees.set(raw, tree);
    }
    let v: Scalar;
    if (isErr(tree)) v = tree;
    else {
      const out = evalNode(tree, sheet);
      v = isRange(out) ? (out.rows.length === 1 && out.rows[0].length === 1 ? out.rows[0][0] : err("#VALUE!", "a range where one value was expected")) : out;
    }
    visiting.delete(key);
    cache.set(key, v);
    return v;
  }

  function evalNode(n: Node, home: Sheet): Val {
    switch (n.k) {
      case "num": return n.v;
      case "str": return n.v;
      case "bool": return n.v;
      case "err": return err(n.v);
      case "ref": {
        const s = sheetOf(n.sheet, home);
        return s ? cellValue(s, n.c, n.r) : err("#REF!", `no sheet named ${n.sheet}`);
      }
      case "range": {
        const s = sheetOf(n.sheet, home);
        if (!s) return err("#REF!", `no sheet named ${n.sheet}`);
        if ((n.r2 - n.r1 + 1) * (n.c2 - n.c1 + 1) > MAX_RANGE_CELLS) return err("#NUM!", "range too large");
        const rows: Scalar[][] = [];
        for (let r = n.r1; r <= n.r2; r++) {
          const row: Scalar[] = [];
          for (let c = n.c1; c <= n.c2; c++) row.push(cellValue(s, c, r));
          rows.push(row);
        }
        return { range: true, rows };
      }
      case "un": {
        const x = toNum(scal(evalNode(n.a, home)));
        return isErr(x) ? x : -x;
      }
      case "pct": {
        const x = toNum(scal(evalNode(n.a, home)));
        return isErr(x) ? x : x / 100;
      }
      case "bin": {
        const a = scal(evalNode(n.a, home));
        const b = scal(evalNode(n.b, home));
        if (isErr(a)) return a;
        if (isErr(b)) return b;
        if (n.op === "&") return toStr(a) + toStr(b);
        if (["=", "<>", "<", ">", "<=", ">="].includes(n.op)) {
          const d = compare(a, b);
          return n.op === "=" ? d === 0 : n.op === "<>" ? d !== 0 : n.op === "<" ? d < 0 : n.op === ">" ? d > 0 : n.op === "<=" ? d <= 0 : d >= 0;
        }
        const x = toNum(a), y = toNum(b);
        if (isErr(x)) return x;
        if (isErr(y)) return y;
        switch (n.op) {
          case "+": return x + y;
          case "-": return x - y;
          case "*": return x * y;
          case "/": return y === 0 ? err("#DIV/0!") : x / y;
          case "^": { const r = x ** y; return Number.isFinite(r) ? r : err("#NUM!"); }
        }
        return err("#VALUE!");
      }
      case "call": {
        const f = FUNCS[n.name];
        if (!f) return err("#NAME?", `unknown function ${n.name}`);
        return f(n.args, (x) => evalNode(x, home), ctx);
      }
    }
  }

  const values: Evaluated["values"] = {};
  for (const s of wb.sheets) {
    const out: Record<string, Scalar> = {};
    for (const a of Object.keys(s.cells)) {
      const p = parseAddr(a);
      if (!p || s.cells[a] === "") continue;
      out[a] = cellValue(s, p.c, p.r);
    }
    values[s.name] = out;
  }
  return { values };
}

/** One formula against a workbook, for a formula bar preview or an AI check. */
export function evaluateOne(wb: Workbook, sheetName: string, formula: string, opts: EvalOptions = {}): Scalar {
  const probe = "ZZZ99999";
  const sheets = wb.sheets.map((s) => (s.name === sheetName ? { ...s, cells: { ...s.cells, [probe]: formula } } : s));
  return evaluateWorkbook({ sheets }, opts).values[sheetName]?.[probe] ?? null;
}
