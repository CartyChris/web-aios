/* ────────────────────────────────────────────────────────────────────────────
   Base: small tables and a SQL subset over them.

   LibreOffice Base is a front end to a database; in a browser OS the useful
   core is typed tables you can fill in, and questions you can ask of them.
   Questions are SQL -- which an AI can write from plain English and a person
   can read and correct -- parsed and run here, never passed to eval, and
   limited to SELECT (a query cannot change a table).

   Supported:
     SELECT [DISTINCT] cols|*|expr AS name|COUNT(*)|SUM/AVG/MIN/MAX(col)
     FROM table
     [WHERE cond AND/OR/NOT cond, with = != <> < > <= >= LIKE IN (...) IS [NOT] NULL BETWEEN]
     [GROUP BY cols] [HAVING cond] [ORDER BY col|n [ASC|DESC], ...] [LIMIT n [OFFSET m]]

   PURE.
   ──────────────────────────────────────────────────────────────────────────── */

export type ColType = "text" | "number" | "date" | "bool";
export interface Column { name: string; type: ColType }
export type Cell = string | number | boolean | null;
export interface Table { name: string; columns: Column[]; rows: Cell[][] }
export interface QueryResult { columns: string[]; rows: Cell[][] }

export function coerce(v: unknown, type: ColType): Cell {
  if (v === null || v === undefined || v === "") return null;
  if (type === "number") { const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, "")); return Number.isFinite(n) ? n : null; }
  if (type === "bool") return v === true || /^(true|yes|1|y)$/i.test(String(v));
  if (type === "date") { const s = String(v).trim(); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null; }
  return String(v);
}

/** Guess column types from sample values (for CSV import). */
export function inferType(values: string[]): ColType {
  const vs = values.filter((v) => v.trim() !== "").slice(0, 200);
  if (!vs.length) return "text";
  if (vs.every((v) => /^-?[\d,]*\.?\d+(e[+-]?\d+)?$/i.test(v.trim()))) return "number";
  if (vs.every((v) => /^\d{4}-\d{2}-\d{2}/.test(v.trim()))) return "date";
  if (vs.every((v) => /^(true|false|yes|no)$/i.test(v.trim()))) return "bool";
  return "text";
}

/* ── lexing ──────────────────────────────────────────────────────────────── */

type T = { k: "id" | "num" | "str" | "op" | "kw"; v: string };
const KW = new Set(["SELECT", "DISTINCT", "FROM", "WHERE", "GROUP", "BY", "HAVING", "ORDER", "ASC", "DESC", "LIMIT", "OFFSET", "AND", "OR", "NOT", "LIKE", "IN", "IS", "NULL", "BETWEEN", "AS", "TRUE", "FALSE"]);

function lex(sql: string): T[] {
  const out: T[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) { i++; continue; }
    if (sql.startsWith("--", i)) { while (i < sql.length && sql[i] !== "\n") i++; continue; }
    if (c === "'") {
      let v = ""; i++;
      while (i < sql.length) { if (sql[i] === "'") { if (sql[i + 1] === "'") { v += "'"; i += 2; continue; } break; } v += sql[i++]; }
      if (sql[i] !== "'") throw new Error("Unclosed text in quotes.");
      i++; out.push({ k: "str", v }); continue;
    }
    if (c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      const e = sql.indexOf(close, i + 1);
      if (e < 0) throw new Error("Unclosed quoted name.");
      out.push({ k: "id", v: sql.slice(i + 1, e) }); i = e + 1; continue;
    }
    const n = /^\d+(\.\d+)?/.exec(sql.slice(i));
    if (n) { out.push({ k: "num", v: n[0] }); i += n[0].length; continue; }
    const id = /^[A-Za-z_][\w]*/.exec(sql.slice(i));
    if (id) { const up = id[0].toUpperCase(); out.push(KW.has(up) ? { k: "kw", v: up } : { k: "id", v: id[0] }); i += id[0].length; continue; }
    const op = /^(<=|>=|<>|!=|[=<>*,().+\-/;])/.exec(sql.slice(i));
    if (op) { if (op[0] !== ";") out.push({ k: "op", v: op[0] }); i += op[0].length; continue; }
    throw new Error(`Unexpected "${c}".`);
  }
  return out;
}

/* ── parsing ─────────────────────────────────────────────────────────────── */

type Expr =
  | { e: "col"; name: string }
  | { e: "lit"; v: Cell }
  | { e: "star" }
  | { e: "agg"; fn: string; arg: Expr | "*" }
  | { e: "bin"; op: string; a: Expr; b: Expr }
  | { e: "not"; a: Expr }
  | { e: "neg"; a: Expr }
  | { e: "like"; a: Expr; pat: Expr; not: boolean }
  | { e: "in"; a: Expr; list: Expr[]; not: boolean }
  | { e: "isnull"; a: Expr; not: boolean }
  | { e: "between"; a: Expr; lo: Expr; hi: Expr; not: boolean }
  | { e: "fn"; fn: string; args: Expr[] };

export interface Query {
  distinct: boolean;
  select: Array<{ expr: Expr; as: string }>;
  from: string;
  where?: Expr;
  groupBy: Expr[];
  having?: Expr;
  orderBy: Array<{ expr: Expr | number; desc: boolean }>;
  limit?: number;
  offset?: number;
}

const AGGS = new Set(["COUNT", "SUM", "AVG", "MIN", "MAX"]);
const SCALAR_FNS = new Set(["UPPER", "LOWER", "LENGTH", "ROUND", "ABS", "COALESCE", "SUBSTR", "YEAR", "MONTH"]);

export function parseSql(sql: string): Query {
  const t = lex(sql);
  let p = 0;
  const peek = (o = 0) => t[p + o];
  const is = (k: T["k"], v?: string) => peek()?.k === k && (v === undefined || peek()!.v.toUpperCase() === v);
  const take = (k: T["k"], v?: string) => { if (!is(k, v)) throw new Error(`Expected ${v ?? k}${peek() ? ` near "${peek()!.v}"` : " at the end"}.`); return t[p++]; };
  const opt = (k: T["k"], v?: string) => (is(k, v) ? t[p++] : null);

  function primary(): Expr {
    if (opt("op", "(")) { const e = or(); take("op", ")"); return e; }
    if (opt("op", "-")) return { e: "neg", a: primary() };
    if (is("num")) return { e: "lit", v: Number(t[p++].v) };
    if (is("str")) return { e: "lit", v: t[p++].v };
    if (opt("kw", "NULL")) return { e: "lit", v: null };
    if (opt("kw", "TRUE")) return { e: "lit", v: true };
    if (opt("kw", "FALSE")) return { e: "lit", v: false };
    if (is("op", "*")) { p++; return { e: "star" }; }
    if (is("id")) {
      const name = t[p++].v;
      const up = name.toUpperCase();
      if (opt("op", "(")) {
        if (AGGS.has(up)) {
          const arg: Expr | "*" = opt("op", "*") ? "*" : or();
          take("op", ")");
          return { e: "agg", fn: up, arg };
        }
        if (!SCALAR_FNS.has(up)) throw new Error(`Unknown function ${name}.`);
        const args: Expr[] = [];
        if (!is("op", ")")) { do args.push(or()); while (opt("op", ",")); }
        take("op", ")");
        return { e: "fn", fn: up, args };
      }
      return { e: "col", name };
    }
    throw new Error(peek() ? `Unexpected "${peek()!.v}".` : "The query ends too early.");
  }
  function mul(): Expr { let a = primary(); while (is("op", "*") || is("op", "/")) { const op = t[p++].v; a = { e: "bin", op, a, b: primary() }; } return a; }
  function add(): Expr { let a = mul(); while (is("op", "+") || is("op", "-")) { const op = t[p++].v; a = { e: "bin", op, a, b: mul() }; } return a; }
  function cmp(): Expr {
    const a = add();
    const not = !!opt("kw", "NOT");
    if (opt("kw", "LIKE")) return { e: "like", a, pat: add(), not };
    if (opt("kw", "IN")) { take("op", "("); const list: Expr[] = []; do list.push(add()); while (opt("op", ",")); take("op", ")"); return { e: "in", a, list, not }; }
    if (opt("kw", "BETWEEN")) { const lo = add(); take("kw", "AND"); return { e: "between", a, lo, hi: add(), not }; }
    if (not) throw new Error("NOT must be followed by LIKE, IN or BETWEEN here.");
    if (opt("kw", "IS")) { const n = !!opt("kw", "NOT"); take("kw", "NULL"); return { e: "isnull", a, not: n }; }
    for (const op of ["=", "!=", "<>", "<=", ">=", "<", ">"]) if (opt("op", op)) return { e: "bin", op: op === "!=" ? "<>" : op, a, b: add() };
    return a;
  }
  function not(): Expr { return opt("kw", "NOT") ? { e: "not", a: not() } : cmp(); }
  function and(): Expr { let a = not(); while (opt("kw", "AND")) a = { e: "bin", op: "AND", a, b: not() }; return a; }
  function or(): Expr { let a = and(); while (opt("kw", "OR")) a = { e: "bin", op: "OR", a, b: and() }; return a; }

  take("kw", "SELECT");
  const distinct = !!opt("kw", "DISTINCT");
  const select: Query["select"] = [];
  do {
    const expr = or();
    let as = "";
    if (opt("kw", "AS")) as = take("id").v;
    else if (is("id")) as = t[p++].v;
    select.push({ expr, as: as || label(expr) });
  } while (opt("op", ","));
  take("kw", "FROM");
  const from = take("id").v;
  const q: Query = { distinct, select, from, groupBy: [], orderBy: [] };
  if (opt("kw", "WHERE")) q.where = or();
  if (opt("kw", "GROUP")) { take("kw", "BY"); do q.groupBy.push(add()); while (opt("op", ",")); }
  if (opt("kw", "HAVING")) q.having = or();
  if (opt("kw", "ORDER")) {
    take("kw", "BY");
    do {
      const e: Expr | number = is("num") ? Number(t[p++].v) : add();
      const desc = !!opt("kw", "DESC");
      if (!desc) opt("kw", "ASC");
      q.orderBy.push({ expr: e, desc });
    } while (opt("op", ","));
  }
  if (opt("kw", "LIMIT")) { q.limit = Number(take("num").v); if (opt("kw", "OFFSET")) q.offset = Number(take("num").v); }
  if (p < t.length) throw new Error(`Unexpected "${t[p].v}" after the end of the query.`);
  return q;
}

function label(e: Expr): string {
  switch (e.e) {
    case "col": return e.name;
    case "star": return "*";
    case "agg": return `${e.fn}(${e.arg === "*" ? "*" : label(e.arg)})`;
    case "lit": return String(e.v);
    case "fn": return `${e.fn}(${e.args.map(label).join(", ")})`;
    default: return "expr";
  }
}

/* ── running ─────────────────────────────────────────────────────────────── */

const cmpCells = (a: Cell, b: Cell): number => {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
};
const truthy = (v: Cell) => v !== null && v !== false && v !== 0 && v !== "";

export function runQuery(tables: Table[], sql: string, maxRows = 10_000): QueryResult {
  const q = parseSql(sql);
  const table = tables.find((t) => t.name.toLowerCase() === q.from.toLowerCase());
  if (!table) throw new Error(`No table named "${q.from}". Tables: ${tables.map((t) => t.name).join(", ") || "none"}.`);
  const colIndex = new Map(table.columns.map((c, i) => [c.name.toLowerCase(), i]));
  const hasAgg = (e: Expr): boolean => e.e === "agg" || (e.e === "bin" && (hasAgg(e.a) || hasAgg(e.b))) || (e.e === "fn" && e.args.some(hasAgg)) || (e.e === "not" && hasAgg(e.a)) || (e.e === "neg" && hasAgg(e.a));

  const evalE = (e: Expr, row: Cell[], group?: Cell[][]): Cell => {
    switch (e.e) {
      case "lit": return e.v;
      case "star": throw new Error("* is only allowed on its own or in COUNT(*).");
      case "col": {
        const i = colIndex.get(e.name.toLowerCase());
        if (i === undefined) throw new Error(`No column "${e.name}" in ${table.name}. Columns: ${table.columns.map((c) => c.name).join(", ")}.`);
        return row[i] ?? null;
      }
      case "neg": { const v = evalE(e.a, row, group); return typeof v === "number" ? -v : null; }
      case "not": return !truthy(evalE(e.a, row, group));
      case "agg": {
        const rows = group ?? [row];
        if (e.arg === "*") return rows.length;
        const vals = rows.map((r) => evalE(e.arg as Expr, r)).filter((v) => v !== null);
        if (e.fn === "COUNT") return vals.length;
        if (e.fn === "MIN") return vals.length ? vals.reduce((a, b) => (cmpCells(a, b) <= 0 ? a : b)) : null;
        if (e.fn === "MAX") return vals.length ? vals.reduce((a, b) => (cmpCells(a, b) >= 0 ? a : b)) : null;
        const nums = vals.filter((v): v is number => typeof v === "number");
        const sum = nums.reduce((a, b) => a + b, 0);
        return e.fn === "SUM" ? (nums.length ? sum : null) : nums.length ? sum / nums.length : null;
      }
      case "fn": {
        const a = e.args.map((x) => evalE(x, row, group));
        switch (e.fn) {
          case "UPPER": return a[0] === null ? null : String(a[0]).toUpperCase();
          case "LOWER": return a[0] === null ? null : String(a[0]).toLowerCase();
          case "LENGTH": return a[0] === null ? null : String(a[0]).length;
          case "ROUND": return typeof a[0] === "number" ? Math.round(a[0] * 10 ** Number(a[1] ?? 0)) / 10 ** Number(a[1] ?? 0) : null;
          case "ABS": return typeof a[0] === "number" ? Math.abs(a[0]) : null;
          case "COALESCE": return a.find((v) => v !== null) ?? null;
          case "SUBSTR": return a[0] === null ? null : String(a[0]).substr(Number(a[1] ?? 1) - 1, a[2] === undefined ? undefined : Number(a[2]));
          case "YEAR": return typeof a[0] === "string" && /^\d{4}/.test(a[0]) ? Number(a[0].slice(0, 4)) : null;
          case "MONTH": return typeof a[0] === "string" && /^\d{4}-\d{2}/.test(a[0]) ? Number(a[0].slice(5, 7)) : null;
        }
        return null;
      }
      case "like": {
        const v = evalE(e.a, row, group), pat = evalE(e.pat, row, group);
        if (v === null || pat === null) return null;
        const re = new RegExp(`^${String(pat).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".")}$`, "is");
        return re.test(String(v)) !== e.not;
      }
      case "in": { const v = evalE(e.a, row, group); const hit = e.list.some((x) => cmpCells(evalE(x, row, group), v) === 0); return v === null ? null : hit !== e.not; }
      case "isnull": return (evalE(e.a, row, group) === null) !== e.not;
      case "between": { const v = evalE(e.a, row, group); if (v === null) return null; const inside = cmpCells(v, evalE(e.lo, row, group)) >= 0 && cmpCells(v, evalE(e.hi, row, group)) <= 0; return inside !== e.not; }
      case "bin": {
        if (e.op === "AND") return truthy(evalE(e.a, row, group)) && truthy(evalE(e.b, row, group));
        if (e.op === "OR") return truthy(evalE(e.a, row, group)) || truthy(evalE(e.b, row, group));
        const a = evalE(e.a, row, group), b = evalE(e.b, row, group);
        if (["+", "-", "*", "/"].includes(e.op)) {
          if (typeof a !== "number" || typeof b !== "number") return null;
          return e.op === "+" ? a + b : e.op === "-" ? a - b : e.op === "*" ? a * b : b === 0 ? null : a / b;
        }
        if (a === null || b === null) return null;
        const d = cmpCells(a, b);
        return e.op === "=" ? d === 0 : e.op === "<>" ? d !== 0 : e.op === "<" ? d < 0 : e.op === ">" ? d > 0 : e.op === "<=" ? d <= 0 : d >= 0;
      }
    }
  };

  let rows = table.rows.filter((r) => !q.where || truthy(evalE(q.where, r)));
  const star = q.select.length === 1 && q.select[0].expr.e === "star";
  const columns = star ? table.columns.map((c) => c.name) : q.select.map((s) => s.as);
  let out: Array<{ cells: Cell[]; sortRow: Cell[]; group?: Cell[][] }>;

  if (q.groupBy.length || q.select.some((s) => hasAgg(s.expr))) {
    const groups = new Map<string, Cell[][]>();
    for (const r of rows) {
      const key = JSON.stringify(q.groupBy.map((g) => evalE(g, r)));
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(r);
    }
    if (!groups.size && !q.groupBy.length) groups.set("[]", []);
    out = [...groups.values()]
      .filter((g) => !q.having || truthy(evalE(q.having, g[0] ?? [], g)))
      .map((g) => ({ cells: q.select.map((s) => evalE(s.expr, g[0] ?? [], g)), sortRow: g[0] ?? [], group: g }));
  } else {
    out = rows.map((r) => ({ cells: star ? r.slice() : q.select.map((s) => evalE(s.expr, r)), sortRow: r }));
  }
  if (q.distinct) {
    const seen = new Set<string>();
    out = out.filter((o) => { const k = JSON.stringify(o.cells); if (seen.has(k)) return false; seen.add(k); return true; });
  }
  if (q.orderBy.length) {
    out.sort((x, y) => {
      for (const o of q.orderBy) {
        let a: Cell, b: Cell;
        if (typeof o.expr === "number") { a = x.cells[o.expr - 1] ?? null; b = y.cells[o.expr - 1] ?? null; }
        else {
          const alias = o.expr.e === "col" ? columns.findIndex((c) => c.toLowerCase() === (o.expr as { name: string }).name.toLowerCase()) : -1;
          if (alias >= 0 && !star) { a = x.cells[alias]; b = y.cells[alias]; }
          else { a = evalE(o.expr, x.sortRow, x.group); b = evalE(o.expr, y.sortRow, y.group); }
        }
        const d = cmpCells(a, b);
        if (d) return o.desc ? -d : d;
      }
      return 0;
    });
  }
  rows = out.map((o) => o.cells);
  const start = q.offset ?? 0;
  return { columns, rows: rows.slice(start, start + Math.min(q.limit ?? maxRows, maxRows)) };
}

/** A schema description for an AI writing SQL. */
export function schemaText(tables: Table[]): string {
  return tables.map((t) => `${t.name}(${t.columns.map((c) => `${c.name} ${c.type}`).join(", ")}) -- ${t.rows.length} rows`).join("\n");
}
