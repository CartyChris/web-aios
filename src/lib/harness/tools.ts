/* ────────────────────────────────────────────────────────────────────────────
   Layer 3: the tools.

   The whole point of this layer is that the numbers a person will act on are
   COMPUTED, not improvised. Nine of the ten built-ins are deterministic: the
   same arguments against the same FIXTURE_VERSION produce a byte-identical
   observation, forever. That is what makes a trace replayable, an eval
   baseline meaningful, and a KPI arguable-about in a meeting.

   Two decisions here are security decisions and are not negotiable:

   - `calc` is a hand-written shunting-yard parser. No `eval`, no `Function`.
     This module runs inside a page that concatenates model output into
     strings; an expression evaluator built on `eval` is a remote code
     execution primitive handed to whoever can influence the model's context.
     Forty lines of parser is a cheap price.
   - `write_artifact` FORCES the path under the run's own directory and takes
     only a bare file name. A model-supplied path is a directory traversal
     waiting to be written.

   Imports nothing but ./types and ./fixtures: the same code serves the browser
   and the /api/harness/mcp route, so other MCP clients get the same numbers.
   ──────────────────────────────────────────────────────────────────────────── */

import type {
  Disposer,
  JsonSchema,
  JsonSchemaProp,
  ToolAnnotations,
  ToolContext,
  ToolDef,
  ToolRegistry,
  ToolResult,
} from "./types";
import type { DocFixture, Fixtures, PolicyDecision, PolicyRule, Segment } from "./fixtures";
import { FIXTURE_VERSION } from "./fixtures";

/* ── formatting primitives ───────────────────────────────────────────────── */

/**
 * `toFixed` is specified exactly by ECMA-262; `toLocaleString` depends on the
 * host's ICU data. A KPI that renders "4.182.000" on one machine and
 * "4,182,000" on another is not one number, and byte-identical observations
 * are the entire contract of this layer — so grouping is done by hand.
 */
function groupDigits(n: number, decimals: number): string {
  const abs = Math.abs(n).toFixed(decimals);
  const dot = abs.indexOf(".");
  const intPart = dot === -1 ? abs : abs.slice(0, dot);
  const fracPart = dot === -1 ? "" : abs.slice(dot);
  return (n < 0 ? "-" : "") + intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + fracPart;
}

/** Kills accumulated binary-float noise before it reaches an observation. */
function roundTo(n: number, decimals: number): number {
  return Number(n.toFixed(decimals));
}

/** UTF-8 byte length without TextEncoder, which is not in every lib target
 *  this module is compiled under. */
function utf8Bytes(s: string): number {
  let total = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) total += 1;
    else if (cp < 0x800) total += 2;
    else if (cp < 0x10000) total += 3;
    else total += 4;
  }
  return total;
}

/**
 * Stable key for the per-run memo. Must stay byte-compatible with
 * `canonicalArgs` in loop.ts, which produces the eval `tool_sequence`: if the
 * two disagree, a cache hit and a recorded call describe different arguments
 * and the trace stops being a receipt.
 */
function canonicalKey(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(canonicalKey).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalKey(obj[k])).join(",") + "}";
}

/* ── registry ────────────────────────────────────────────────────────────── */

export function createRegistry(): ToolRegistry {
  const byName = new Map<string, ToolDef>();
  return {
    register(tool: ToolDef): Disposer {
      const existing = byName.get(tool.name);
      if (existing) {
        // Silently shadowing means the catalogue in the system prompt and the
        // code that actually runs describe different tools, and the model
        // reasons from a description that is no longer true.
        throw new Error(
          `Tool "${tool.name}" is already registered ("${existing.title}"). ` +
            `Dispose the first registration before registering another, or give this one a different name.`,
        );
      }
      byName.set(tool.name, tool);
      return () => {
        // Only remove our own registration: a disposer that fires after the
        // name was re-registered would delete someone else's tool.
        if (byName.get(tool.name) === tool) byName.delete(tool.name);
      };
    },
    get: (name: string) => byName.get(name),
    list: () => [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    signature: () =>
      [...byName.values()]
        .map((t) => {
          const props = Object.keys(t.inputSchema.properties).sort().join(",");
          return `${t.name}:${t.deterministic ? "d" : "n"}:${props}`;
        })
        .sort()
        .join("|"),
  };
}

/* ── argument validation ─────────────────────────────────────────────────── */

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function checkScalar(kind: JsonSchemaProp["type"], v: unknown): boolean {
  switch (kind) {
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "boolean":
      return typeof v === "boolean";
    case "array":
      return Array.isArray(v);
    case "object":
      return typeof v === "object" && v !== null && !Array.isArray(v);
  }
}

/**
 * Strict, on purpose. No coercion of "5" to 5 and no ignoring of unknown keys:
 * both hide a model mistake behind a plausible answer, and the whole layer
 * exists so that a wrong number is loud. The error names the constraint AND
 * the way forward, because an error the model cannot act on costs a whole step.
 */
export function validateArgs(
  schema: JsonSchema,
  args: Record<string, unknown>,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  const props = schema.properties;
  const allowed = Object.keys(props);
  const required = schema.required ?? [];
  const out: Record<string, unknown> = {};

  const unknown = Object.keys(args).filter((k) => !Object.prototype.hasOwnProperty.call(props, k));
  if (unknown.length > 0) {
    return {
      ok: false,
      error:
        `unknown argument${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `"${k}"`).join(", ")}. ` +
        `Accepted arguments: ${allowed.join(", ")}.`,
    };
  }

  for (const name of allowed) {
    const prop = props[name];
    if (!prop) continue;
    const raw = args[name];

    if (raw === undefined || raw === null) {
      if (prop.default !== undefined) {
        out[name] = prop.default;
        continue;
      }
      if (required.includes(name)) {
        return {
          ok: false,
          error:
            `missing required argument "${name}" (${prop.type}). ${prop.description} ` +
            (prop.enum ? `Allowed values: ${prop.enum.join(", ")}.` : `Add "${name}" and call again.`),
        };
      }
      continue;
    }

    if (!checkScalar(prop.type, raw)) {
      return {
        ok: false,
        error:
          `argument "${name}" must be ${prop.type}, received ${typeName(raw)} (${JSON.stringify(raw)}). ` +
          `${prop.description}`,
      };
    }

    if (prop.enum && (typeof raw !== "string" || !prop.enum.includes(raw))) {
      return {
        ok: false,
        error:
          `argument "${name}" must be one of ${prop.enum.join(", ")}, received ${JSON.stringify(raw)}. ` +
          `Pick one of the listed values and call again.`,
      };
    }

    if (prop.type === "array" && prop.items && Array.isArray(raw)) {
      const badIndex = raw.findIndex((item) => !checkScalar(prop.items?.type ?? "string", item));
      if (badIndex !== -1) {
        return {
          ok: false,
          error:
            `argument "${name}" must be an array of ${prop.items.type}; element ${badIndex} is ` +
            `${typeName(raw[badIndex])}. ${prop.description}`,
        };
      }
    }

    out[name] = raw;
  }

  return { ok: true, args: out };
}

/* ── annotations ─────────────────────────────────────────────────────────── */

const READ_SEGMENTS = new Set([
  "read", "get", "list", "search", "query", "lookup", "find", "view", "show",
  "describe", "status", "kpi", "calc", "check", "think", "date", "math",
  "doc", "docs", "table", "policy", "count", "diff",
]);

const WRITE_SEGMENTS = new Set([
  "write", "create", "update", "put", "post", "patch", "set", "send", "publish",
  "deploy", "exec", "run", "move", "rename", "upload", "commit", "merge",
]);

const DESTRUCTIVE_SEGMENTS = new Set([
  "delete", "remove", "drop", "truncate", "purge", "reset", "revoke", "kill", "wipe",
]);

const OPEN_WORLD_SEGMENTS = new Set([
  "mcp", "http", "https", "web", "browse", "url", "fetch", "api", "email",
  "mail", "slack", "github", "gitlab", "jira", "notion", "remote", "net",
]);

/**
 * Split FIRST, then match whole segments. A naive `/\bread\b/` never matches
 * `github_read_file`, because `_` is a word character — so the naive version
 * classifies almost every real tool as unrecognised and, with the fail-closed
 * default below, demands approval for every call until someone turns approvals
 * off entirely. The split is what keeps the safe default usable.
 *
 * An unrecognised name is treated as the most dangerous thing it could be.
 */
export function annotationsFor(name: string): ToolAnnotations {
  const segments = name
    .split(/[_\-./:]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const destructive = segments.some((s) => DESTRUCTIVE_SEGMENTS.has(s));
  const writes = destructive || segments.some((s) => WRITE_SEGMENTS.has(s));
  const reads = segments.some((s) => READ_SEGMENTS.has(s));
  const openWorld = segments.some((s) => OPEN_WORLD_SEGMENTS.has(s));

  if (!writes && !reads) {
    return { readOnly: false, destructive: true, openWorld: true, requiresApproval: true };
  }

  return {
    readOnly: !writes,
    destructive,
    openWorld,
    requiresApproval: destructive || openWorld,
  };
}

/* ── catalogue text ──────────────────────────────────────────────────────── */

function argSummary(schema: JsonSchema): string {
  const required = new Set(schema.required ?? []);
  const parts = Object.entries(schema.properties).map(([name, prop]) => {
    const flag = required.has(name) ? "*" : "";
    const kind = prop.enum ? `one of ${prop.enum.join(", ")}` : prop.type;
    const def = prop.default !== undefined ? `, default ${JSON.stringify(prop.default)}` : "";
    return `${name}${flag} (${kind}${def})`;
  });
  return parts.length > 0 ? parts.join(", ") : "none";
}

/**
 * The reviewer reading a trace and the model choosing a tool need the same
 * fact: which of these numbers can move between runs. So determinism is
 * rendered as a line of the catalogue, not left implicit.
 */
export function toolCatalogueText(tools: ToolDef[]): string {
  return tools
    .map((t) => {
      const lines = [
        `- ${t.name} — ${t.description}`,
        `  args: ${argSummary(t.inputSchema)}`,
        `  example: ${t.example}`,
        t.deterministic
          ? `  deterministic: the same arguments always produce the same observation`
          : `  NOT deterministic: the result may differ between runs, so do not quote it as a fixed figure`,
      ];
      if (t.annotations.requiresApproval) {
        lines.push(`  approval: a named person must approve each call before it runs`);
      }
      return lines.join("\n");
    })
    .join("\n");
}

/* ── execution ───────────────────────────────────────────────────────────── */

/**
 * read_doc is deterministic in its observation but it also moves run-scoped
 * state: it opens the document that `lookup` walks. A memo hit would return
 * the right bytes while leaving the cursor on the previously opened document,
 * so `lookup` would silently answer from the wrong file. The correct
 * observation and the correct side effect are not the same property, and the
 * memo can only preserve one of them.
 */
const RUN_SCOPED_STATE = new Set(["read_doc"]);

export function isMemoizable(tool: ToolDef): boolean {
  return tool.deterministic && !RUN_SCOPED_STATE.has(tool.name);
}

export async function runTool(
  tool: ToolDef,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const started = ctx.now();
  const stamp = (r: Omit<ToolResult, "ms">): ToolResult => {
    const observation =
      r.observation && r.observation.trim().length > 0
        ? r.observation
        : `${tool.name} returned no output. Nothing was recorded; try different arguments or a different tool.`;
    return { ...r, observation, ms: Math.max(0, ctx.now() - started) };
  };

  if (ctx.signal.aborted) {
    const error = `the run was aborted before ${tool.name} started. No work was done.`;
    return stamp({ status: "error", observation: `Not run: ${error}`, error });
  }

  const validated = validateArgs(tool.inputSchema, args);
  if (!validated.ok) {
    return stamp({
      status: "invalid_args",
      observation: `Invalid arguments for ${tool.name}: ${validated.error} Example: ${tool.example}`,
      error: validated.error,
    });
  }

  const key = `${tool.name}|${canonicalKey(validated.args)}`;
  if (isMemoizable(tool)) {
    const hit = ctx.cache.get(key);
    if (hit) return { ...hit, cached: true, ms: Math.max(0, ctx.now() - started) };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  try {
    const timeout = new Promise<ToolResult>((resolve) => {
      timer = setTimeout(() => {
        const error =
          `${tool.name} did not finish within ${tool.timeoutMs} ms. ` +
          `Narrow the request (a smaller limit, a tighter filter) and try again.`;
        resolve(stamp({ status: "timeout", observation: `Timed out: ${error}`, error }));
      }, tool.timeoutMs);
    });

    const aborted = new Promise<ToolResult>((resolve) => {
      onAbort = () => {
        const error = `the run was aborted while ${tool.name} was running. Treat its result as unknown.`;
        resolve(stamp({ status: "error", observation: `Aborted: ${error}`, error }));
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });
    });

    const result = await Promise.race([tool.run(validated.args, ctx), timeout, aborted]);
    const stamped = stamp(result);

    // Only successes are memoized: caching a failure turns one transient error
    // into a permanent one for the rest of the run, and the model cannot tell
    // the difference from the observation.
    if (isMemoizable(tool) && stamped.status === "ok") {
      ctx.cache.set(key, { ...stamped, cached: false });
    }
    return stamped;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return stamp({
      status: "error",
      observation:
        `${tool.name} failed: ${message}. The arguments were accepted, so this is a fault in the tool, ` +
        `not in the call; try a different tool or report the failure in your answer.`,
      error: message,
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) ctx.signal.removeEventListener("abort", onAbort);
  }
}

/* ── built-in tools ──────────────────────────────────────────────────────── */

export interface BuiltinToolOptions {
  fixtures: Fixtures;
  /** Injected so write_artifact works in the browser and is a no-op stub in
   *  the MCP route. */
  writeArtifact?: (path: string, content: string) => Promise<{ ok: boolean; path: string; error?: string }>;
}

const LOCAL_TIMEOUT_MS = 5_000;
const IO_TIMEOUT_MS = 10_000;

/** A budgeted window is what creates the reasoning pressure. Returning the
 *  whole document makes the context window the ceiling and retrieval
 *  meaningless. */
const WINDOW_SENTENCES = 5;

const MAX_EXPRESSION_CHARS = 200;
const MAX_ARTIFACT_CHARS = 200_000;
const MAX_TABLE_RENDER_ROWS = 20;
const SNIPPET_CHARS = 140;

function ok(observation: string, value: unknown): ToolResult {
  return { status: "ok", observation, value, ms: 0 };
}

function fail(observation: string, error: string, status: ToolResult["status"] = "error"): ToolResult {
  return { status, observation, error, ms: 0 };
}

/* ---- calc ---------------------------------------------------------------- */

type Token =
  | { t: "num"; v: number }
  | { t: "op"; v: string }
  | { t: "lp" }
  | { t: "rp" };

const PRECEDENCE: Record<string, number> = { "u-": 5, "u+": 5, "^": 4, "*": 3, "/": 3, "%": 3, "+": 2, "-": 2 };
const RIGHT_ASSOC = new Set(["^", "u-", "u+"]);

function tokenize(src: string): { ok: true; tokens: Token[] } | { ok: false; error: string } {
  const tokens: Token[] = [];
  let i = 0;
  // Tracks whether the previous token can end an operand: that is the only
  // way to tell a binary minus from a unary one without a second pass.
  let prevIsOperand = false;

  while (i < src.length) {
    const ch = src[i] ?? "";
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    if (ch >= "0" && ch <= "9") {
      const rest = src.slice(i);
      const m = /^\d+(\.\d+)?([eE][+-]?\d+)?/.exec(rest);
      if (!m) return { ok: false, error: `could not read a number at position ${i}` };
      tokens.push({ t: "num", v: Number(m[0]) });
      i += m[0].length;
      prevIsOperand = true;
      continue;
    }
    if (ch === ".") {
      const m = /^\.\d+([eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) return { ok: false, error: `a "." at position ${i} is not part of a number` };
      tokens.push({ t: "num", v: Number(m[0]) });
      i += m[0].length;
      prevIsOperand = true;
      continue;
    }
    if (ch === "(") {
      tokens.push({ t: "lp" });
      i += 1;
      prevIsOperand = false;
      continue;
    }
    if (ch === ")") {
      tokens.push({ t: "rp" });
      i += 1;
      prevIsOperand = true;
      continue;
    }
    if (ch === "+" || ch === "-" || ch === "*" || ch === "/" || ch === "%" || ch === "^") {
      const unary = (ch === "-" || ch === "+") && !prevIsOperand;
      tokens.push({ t: "op", v: unary ? `u${ch}` : ch });
      i += 1;
      prevIsOperand = false;
      continue;
    }
    return {
      ok: false,
      error: `character ${JSON.stringify(ch)} at position ${i} is not allowed`,
    };
  }
  return { ok: true, tokens };
}

function evaluateExpression(expr: string): { ok: true; value: number } | { ok: false; error: string } {
  if (expr.trim().length === 0) return { ok: false, error: "the expression is empty" };
  if (expr.length > MAX_EXPRESSION_CHARS) {
    return { ok: false, error: `the expression is ${expr.length} characters; the limit is ${MAX_EXPRESSION_CHARS}` };
  }
  const lexed = tokenize(expr);
  if (!lexed.ok) return lexed;

  const output: number[] = [];
  const ops: Token[] = [];

  const applyOp = (op: string): string | null => {
    if (op === "u-" || op === "u+") {
      const a = output.pop();
      if (a === undefined) return `operator "${op === "u-" ? "-" : "+"}" has nothing to apply to`;
      output.push(op === "u-" ? -a : a);
      return null;
    }
    const b = output.pop();
    const a = output.pop();
    if (a === undefined || b === undefined) return `operator "${op}" is missing an operand`;
    let r: number;
    switch (op) {
      case "+": r = a + b; break;
      case "-": r = a - b; break;
      case "*": r = a * b; break;
      case "/":
        if (b === 0) return "division by zero";
        r = a / b;
        break;
      case "%":
        if (b === 0) return "modulo by zero";
        r = a % b;
        break;
      case "^": r = Math.pow(a, b); break;
      default: return `unknown operator "${op}"`;
    }
    if (!Number.isFinite(r)) return `"${a} ${op} ${b}" is not a finite number`;
    output.push(r);
    return null;
  };

  for (const token of lexed.tokens) {
    if (token.t === "num") {
      output.push(token.v);
      continue;
    }
    if (token.t === "lp") {
      ops.push(token);
      continue;
    }
    if (token.t === "rp") {
      let matched = false;
      while (ops.length > 0) {
        const top = ops.pop();
        if (!top) break;
        if (top.t === "lp") {
          matched = true;
          break;
        }
        if (top.t === "op") {
          const err = applyOp(top.v);
          if (err) return { ok: false, error: err };
        }
      }
      if (!matched) return { ok: false, error: "a closing bracket has no matching opening bracket" };
      continue;
    }
    // token.t === "op"
    const prec = PRECEDENCE[token.v] ?? 0;
    while (ops.length > 0) {
      const top = ops[ops.length - 1];
      if (!top || top.t !== "op") break;
      const topPrec = PRECEDENCE[top.v] ?? 0;
      const takes = RIGHT_ASSOC.has(token.v) ? topPrec > prec : topPrec >= prec;
      if (!takes) break;
      ops.pop();
      const err = applyOp(top.v);
      if (err) return { ok: false, error: err };
    }
    ops.push(token);
  }

  while (ops.length > 0) {
    const top = ops.pop();
    if (!top) break;
    if (top.t === "lp") return { ok: false, error: "an opening bracket was never closed" };
    if (top.t === "op") {
      const err = applyOp(top.v);
      if (err) return { ok: false, error: err };
    }
  }

  if (output.length !== 1) {
    return { ok: false, error: "the expression does not reduce to a single value" };
  }
  const value = output[0];
  if (value === undefined || !Number.isFinite(value)) {
    return { ok: false, error: "the result is not a finite number" };
  }
  return { ok: true, value };
}

/** Ten decimals removes binary-float residue (0.1 + 0.2) without pretending to
 *  a precision the inputs never had; six is what is shown. */
function formatCalcValue(n: number): { value: number; text: string } {
  const value = roundTo(n, 10);
  const shown = roundTo(value, 6);
  const text = Number.isInteger(shown) ? String(shown) : String(shown);
  return { value: shown, text };
}

/* ---- period helpers ------------------------------------------------------ */

const QUARTER_MONTHS: Record<string, string[]> = {
  "1": ["01", "02", "03"],
  "2": ["04", "05", "06"],
  "3": ["07", "08", "09"],
  "4": ["10", "11", "12"],
};

function expandPeriod(period: string): { ok: true; months: string[] } | { ok: false; error: string } {
  const q = /^(\d{4})Q([1-4])$/.exec(period);
  if (q) {
    const year = q[1] ?? "";
    const months = QUARTER_MONTHS[q[2] ?? ""] ?? [];
    return { ok: true, months: months.map((m) => `${year}-${m}`) };
  }
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (m) return { ok: true, months: [`${m[1]}-${m[2]}`] };
  return {
    ok: false,
    error: `period "${period}" is not a period. Use YYYYQn (for example 2026Q1) or YYYY-MM (for example 2026-03)`,
  };
}

function priorPeriod(period: string): string | null {
  const q = /^(\d{4})Q([1-4])$/.exec(period);
  if (q) {
    const year = Number(q[1]);
    const n = Number(q[2]);
    return n === 1 ? `${year - 1}Q4` : `${year}Q${n - 1}`;
  }
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
  }
  return null;
}

function monthQuarter(month: string): string {
  const year = month.slice(0, 4);
  const n = Number(month.slice(5, 7));
  return `${year}Q${Math.floor((n - 1) / 3) + 1}`;
}

/* ---- date helpers -------------------------------------------------------- */

function parseIsoDate(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  // Round-trip check rejects 2026-02-30, which Date.UTC would happily roll
  // forward into March and then report as a valid answer.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return ms;
}

function toIsoDate(ms: number): string {
  const d = new Date(ms);
  const y = String(d.getUTCFullYear()).padStart(4, "0");
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

function addMonthsUtc(ms: number, months: number): number {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  const targetMonthStart = Date.UTC(y, m + months, 1);
  const t = new Date(targetMonthStart);
  const lastDay = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  // Clamp rather than roll: "31 January plus one month" is 28 February to
  // every finance team on earth, and 3 March to nobody.
  return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(day, lastDay));
}

/* ---- lexical search helpers ---------------------------------------------- */

const STOPWORDS = new Set([
  "the", "and", "for", "are", "not", "with", "that", "this", "from", "was",
  "were", "has", "have", "had", "its", "into", "than", "then", "when", "which",
  "will", "would", "been", "being", "other", "also", "only", "such", "they",
  "them", "their", "there", "these", "those", "what", "while", "your", "you",
  "our", "out", "all", "any", "but", "can", "may", "must", "per", "use",
  "used", "under", "over", "each", "every", "one", "two", "both", "more",
  "most", "less", "least", "about", "after", "before", "between", "during",
  "because", "through", "within", "without", "does", "did", "how", "why",
]);

/**
 * No stemming, no synonyms, a three-character floor. This retriever is
 * DELIBERATELY WEAK. A strong semantic retriever that returns the right
 * passage on the first try deletes the near-miss, and the near-miss is what
 * forces the model to reformulate in a visible thought — which is the whole
 * mechanism ReAct exploits. Improving this is a regression.
 */
function tokenizeText(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

const TITLE_WEIGHT = 3;

interface DocStats {
  doc: DocFixture;
  counts: Map<string, number>;
  length: number;
}

function docStats(docs: DocFixture[]): DocStats[] {
  return docs.map((doc) => {
    const counts = new Map<string, number>();
    let length = 0;
    const add = (tokens: string[], weight: number) => {
      for (const t of tokens) {
        counts.set(t, (counts.get(t) ?? 0) + weight);
        length += weight;
      }
    };
    add(tokenizeText(doc.title), TITLE_WEIGHT);
    add(tokenizeText(doc.sentences.join(" ")), 1);
    return { doc, counts, length };
  });
}

/** Dice coefficient over character bigrams: cheap, deterministic, and good
 *  enough to put the near-miss id next to the one the model asked for. */
function diceSimilarity(a: string, b: string): number {
  const bigrams = (s: string): string[] => {
    const out: string[] = [];
    const t = s.toLowerCase();
    for (let i = 0; i < t.length - 1; i += 1) out.push(t.slice(i, i + 2));
    return out;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.length === 0 || B.length === 0) return 0;
  const pool = new Map<string, number>();
  for (const g of A) pool.set(g, (pool.get(g) ?? 0) + 1);
  let hits = 0;
  for (const g of B) {
    const n = pool.get(g) ?? 0;
    if (n > 0) {
      hits += 1;
      pool.set(g, n - 1);
    }
  }
  return (2 * hits) / (A.length + B.length);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 3)}...`;
}

/* ---- the registry of built-ins ------------------------------------------- */

interface DocCursor {
  docId: string;
  keyword: string;
  matches: number[];
  next: number;
}

const KPI_METRICS = ["arr", "mrr", "churn_rate", "nrr", "gross_margin", "cac_payback_months"] as const;
type KpiMetric = (typeof KPI_METRICS)[number];

const KPI_UNITS: Record<KpiMetric, { unit: string; decimals: number }> = {
  arr: { unit: "USD", decimals: 0 },
  mrr: { unit: "USD", decimals: 0 },
  churn_rate: { unit: "%", decimals: 2 },
  nrr: { unit: "%", decimals: 2 },
  gross_margin: { unit: "%", decimals: 2 },
  cac_payback_months: { unit: "months", decimals: 1 },
};

const TABLE_FIELDS = {
  revenue: ["month", "segment", "mrr", "customers", "churned"],
  tickets: ["id", "opened", "severity", "region", "resolvedHours"],
  headcount: ["quarter", "dept", "headcount", "costUsd"],
} as const;

type TableName = keyof typeof TABLE_FIELDS;
type WhereOp = "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "contains";
const WHERE_OPS: WhereOp[] = ["eq", "ne", "lt", "lte", "gt", "gte", "contains"];

export function builtinTools(opts: BuiltinToolOptions): ToolDef[] {
  const fx = opts.fixtures;

  // Keyed by runId rather than held as one value, so a registry that outlives
  // a run (the MCP route serves many) cannot leak one run's open document
  // into another's lookup.
  const cursors = new Map<string, DocCursor>();

  const revenueCoverage = (): { first: string; last: string } => {
    const months = [...new Set(fx.revenue.map((r) => r.month))].sort();
    return { first: months[0] ?? "(none)", last: months[months.length - 1] ?? "(none)" };
  };

  const stats = docStats(fx.docs);

  /* -- kpi ---------------------------------------------------------------- */

  const kpi: ToolDef = {
    name: "kpi",
    title: "Company KPI",
    description:
      "Return an audited company KPI for a period from the fixed revenue table, with the formula used to compute it.",
    inputSchema: {
      type: "object",
      properties: {
        metric: {
          type: "string",
          description: "Which KPI to compute.",
          enum: [...KPI_METRICS],
        },
        period: {
          type: "string",
          description: "A quarter as YYYYQn, or a month as YYYY-MM.",
        },
        segment: {
          type: "string",
          description: "Customer segment, or all for the whole book.",
          enum: ["all", "smb", "mid", "enterprise"],
          default: "all",
        },
      },
      required: ["metric", "period"],
    },
    deterministic: true,
    annotations: annotationsFor("kpi"),
    timeoutMs: LOCAL_TIMEOUT_MS,
    example: `kpi[{"metric":"arr","period":"2026Q1","segment":"enterprise"}]`,
    run: async (args) => {
      const metric = args.metric as KpiMetric;
      const period = String(args.period);
      const segment = String(args.segment ?? "all");

      const expanded = expandPeriod(period);
      if (!expanded.ok) {
        return fail(`Cannot compute ${metric}: ${expanded.error}.`, expanded.error, "invalid_args");
      }

      const cover = revenueCoverage();
      const pick = (months: string[]) =>
        fx.revenue.filter(
          (r) => months.includes(r.month) && (segment === "all" || r.segment === (segment as Segment)),
        );

      const missing = expanded.months.filter(
        (m) => !fx.revenue.some((r) => r.month === m && (segment === "all" || r.segment === (segment as Segment))),
      );
      if (missing.length > 0) {
        // Returning a figure computed from a partial period is exactly the
        // failure this tool exists to prevent: it is plausible, auditable-
        // looking and wrong.
        const error =
          `fixtures ${fx.version} hold no revenue rows for ${missing.join(", ")} ` +
          `(segment ${segment}). Coverage is ${cover.first} to ${cover.last}`;
        return fail(`Cannot compute ${metric} for ${period}: ${error}. Ask for a period inside that range.`, error);
      }

      const rows = pick(expanded.months);
      const sumMrr = rows.reduce((a, r) => a + r.mrr, 0);
      const sumCustomers = rows.reduce((a, r) => a + r.customers, 0);
      const sumChurned = rows.reduce((a, r) => a + r.churned, 0);
      const ratioFor = (seg: Segment): number =>
        fx.unitEconomics.find((u) => u.segment === seg)?.costOfDeliveryRatio ?? 0;
      const cacFor = (seg: Segment): number => fx.unitEconomics.find((u) => u.segment === seg)?.cacUsd ?? 0;
      const deliveryCost = rows.reduce((a, r) => a + r.mrr * ratioFor(r.segment), 0);

      let raw: number;
      let formula: string;

      switch (metric) {
        case "arr":
          raw = sumMrr * 12;
          formula = "sum(mrr) * 12";
          break;
        case "mrr":
          raw = sumMrr;
          formula = "sum(mrr)";
          break;
        case "churn_rate": {
          if (sumCustomers === 0) {
            const error = "sum(customers) is 0, so a churn rate has no denominator";
            return fail(`Cannot compute churn_rate for ${period}: ${error}. Widen the segment or the period.`, error);
          }
          raw = (sumChurned / sumCustomers) * 100;
          formula = "sum(churned) / sum(customers) * 100";
          break;
        }
        case "nrr": {
          const prior = priorPeriod(period);
          const priorExpanded = prior ? expandPeriod(prior) : null;
          const priorRows = priorExpanded && priorExpanded.ok ? pick(priorExpanded.months) : [];
          const expectedPriorMonths = priorExpanded && priorExpanded.ok ? priorExpanded.months.length : 0;
          const priorMonthsFound = new Set(priorRows.map((r) => r.month)).size;
          if (!prior || priorMonthsFound !== expectedPriorMonths || expectedPriorMonths === 0) {
            const error =
              `nrr compares against the prior period ${prior ?? "(unknown)"}, which is not in fixtures ` +
              `${fx.version} (coverage ${cover.first} to ${cover.last})`;
            return fail(
              `Cannot compute nrr for ${period}: ${error}. Ask for a period whose predecessor is also covered.`,
              error,
            );
          }
          const priorMrr = priorRows.reduce((a, r) => a + r.mrr, 0);
          if (priorMrr === 0) {
            const error = `sum(mrr) for ${prior} is 0, so nrr has no denominator`;
            return fail(`Cannot compute nrr for ${period}: ${error}. Widen the segment.`, error);
          }
          raw = (sumMrr / priorMrr) * 100;
          formula = `sum(mrr) / sum(mrr in ${prior}) * 100`;
          break;
        }
        case "gross_margin": {
          if (sumMrr === 0) {
            const error = "sum(mrr) is 0, so a margin has no denominator";
            return fail(`Cannot compute gross_margin for ${period}: ${error}. Widen the period.`, error);
          }
          raw = ((sumMrr - deliveryCost) / sumMrr) * 100;
          formula = "(sum(mrr) - sum(mrr * cost_of_delivery)) / sum(mrr) * 100";
          break;
        }
        case "cac_payback_months": {
          if (sumCustomers === 0 || sumMrr === 0) {
            const error = "sum(customers) or sum(mrr) is 0, so payback has no denominator";
            return fail(
              `Cannot compute cac_payback_months for ${period}: ${error}. Widen the segment or the period.`,
              error,
            );
          }
          const arpa = sumMrr / sumCustomers;
          const marginRatio = (sumMrr - deliveryCost) / sumMrr;
          if (marginRatio <= 0) {
            const error = "gross margin is zero or negative, so the investment never pays back";
            return fail(`Cannot compute cac_payback_months for ${period}: ${error}.`, error);
          }
          const weightedCac = rows.reduce((a, r) => a + cacFor(r.segment) * r.customers, 0) / sumCustomers;
          raw = weightedCac / (arpa * marginRatio);
          formula = "weighted_cac / (arpa * gross_margin_ratio)";
          break;
        }
      }

      const spec = KPI_UNITS[metric];
      const value = roundTo(raw, spec.decimals);
      const months = expanded.months.length;
      const observation =
        `${metric} ${period} ${segment} = ${groupDigits(value, spec.decimals)} ${spec.unit} ` +
        `(${formula} over ${months} month${months === 1 ? "" : "s"}, ${rows.length} row${rows.length === 1 ? "" : "s"}, ` +
        `fixtures ${fx.version})`;

      return ok(observation, {
        metric,
        period,
        segment,
        value,
        unit: spec.unit,
        formula,
        rows: rows.length,
        fixtureVersion: fx.version,
      });
    },
  };

  /* -- calc --------------------------------------------------------------- */

  const calc: ToolDef = {
    name: "calc",
    title: "Arithmetic",
    description:
      "Evaluate an arithmetic expression over + - * / % ^ and brackets. Use it instead of doing arithmetic in prose.",
    inputSchema: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "Numbers and the operators + - * / % ^ with round brackets. Nothing else is accepted.",
        },
      },
      required: ["expression"],
    },
    deterministic: true,
    annotations: annotationsFor("calc"),
    timeoutMs: LOCAL_TIMEOUT_MS,
    example: `calc[{"expression":"(385500 - 348500) / 348500 * 100"}]`,
    run: async (args) => {
      const expression = String(args.expression);
      const result = evaluateExpression(expression);
      if (!result.ok) {
        const error = result.error;
        return fail(
          `Cannot evaluate ${JSON.stringify(expression)}: ${error}. ` +
            `calc accepts only numbers and the operators + - * / % ^ with round brackets; ` +
            `rewrite the expression using those and call again.`,
          error,
          "invalid_args",
        );
      }
      const { value, text } = formatCalcValue(result.value);
      return ok(`= ${text}`, { expression, value });
    },
  };

  /* -- table_query -------------------------------------------------------- */

  const tableQuery: ToolDef = {
    name: "table_query",
    title: "Table query",
    description:
      "Filter and aggregate one of the fixed tables (revenue, tickets, headcount). Use it instead of summing rows in prose.",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Which table to read.", enum: ["revenue", "tickets", "headcount"] },
        where: {
          type: "array",
          description: `Filters as [{"field":"severity","op":"eq","value":"sev1"}]. ops: ${WHERE_OPS.join(", ")}.`,
        },
        select: { type: "array", description: "Field names to show.", items: { type: "string" } },
        agg: { type: "string", description: "Aggregate instead of listing rows.", enum: ["count", "sum", "avg", "min", "max"] },
        aggField: { type: "string", description: "The numeric field to aggregate. Required unless agg is count." },
        limit: { type: "integer", description: "Maximum rows to return." },
      },
      required: ["table"],
    },
    deterministic: true,
    annotations: annotationsFor("table_query"),
    timeoutMs: LOCAL_TIMEOUT_MS,
    example: `table_query[{"table":"tickets","where":[{"field":"severity","op":"eq","value":"sev1"}],"agg":"sum","aggField":"resolvedHours"}]`,
    run: async (args) => {
      const table = String(args.table) as TableName;
      const fields: readonly string[] = TABLE_FIELDS[table];
      const source: Array<Record<string, unknown>> =
        table === "revenue"
          ? (fx.revenue as unknown as Array<Record<string, unknown>>)
          : table === "tickets"
            ? (fx.tickets as unknown as Array<Record<string, unknown>>)
            : (fx.headcount as unknown as Array<Record<string, unknown>>);

      const whereRaw = Array.isArray(args.where) ? args.where : [];
      const clauses: Array<{ field: string; op: WhereOp; value: string | number | boolean }> = [];
      for (let i = 0; i < whereRaw.length; i += 1) {
        const c = whereRaw[i];
        if (typeof c !== "object" || c === null || Array.isArray(c)) {
          const error = `where[${i}] must be an object like {"field":"...","op":"eq","value":"..."}`;
          return fail(`Invalid filter: ${error}.`, error, "invalid_args");
        }
        const rec = c as Record<string, unknown>;
        const field = rec.field;
        const op = rec.op;
        const value = rec.value;
        if (typeof field !== "string" || !fields.includes(field)) {
          const error = `where[${i}].field ${JSON.stringify(field)} is not a field of ${table}`;
          return fail(`Invalid filter: ${error}. Fields of ${table}: ${fields.join(", ")}.`, error, "invalid_args");
        }
        if (typeof op !== "string" || !WHERE_OPS.includes(op as WhereOp)) {
          const error = `where[${i}].op ${JSON.stringify(op)} is not an operator`;
          return fail(`Invalid filter: ${error}. Operators: ${WHERE_OPS.join(", ")}.`, error, "invalid_args");
        }
        if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
          const error = `where[${i}].value must be a string, number or boolean`;
          return fail(`Invalid filter: ${error}.`, error, "invalid_args");
        }
        clauses.push({ field, op: op as WhereOp, value });
      }

      const selectRaw = Array.isArray(args.select) ? (args.select as unknown[]) : null;
      let select: string[] = [...fields];
      if (selectRaw) {
        const bad = selectRaw.filter((s) => typeof s !== "string" || !fields.includes(s));
        if (bad.length > 0) {
          const error = `select names ${bad.map((b) => JSON.stringify(b)).join(", ")}, which ${table} does not have`;
          return fail(`Invalid select: ${error}. Fields of ${table}: ${fields.join(", ")}.`, error, "invalid_args");
        }
        select = selectRaw as string[];
      }

      const matches: Array<Record<string, unknown>> = [];
      for (const row of source) {
        let keep = true;
        for (const c of clauses) {
          const cell = row[c.field];
          if (c.op === "contains") {
            if (typeof cell !== "string" || typeof c.value !== "string") {
              const error = `"contains" needs a text field and a text value; ${c.field} is ${typeName(cell)}`;
              return fail(`Invalid filter: ${error}. Use eq for numbers.`, error, "invalid_args");
            }
            keep = cell.toLowerCase().includes(c.value.toLowerCase());
          } else if (c.op === "eq" || c.op === "ne") {
            if (typeof cell !== typeof c.value) {
              const error =
                `${c.field} holds ${typeName(cell)} but the filter value is ${typeName(c.value)}; ` +
                `a mismatched comparison would silently match nothing`;
              return fail(`Invalid filter: ${error}.`, error, "invalid_args");
            }
            keep = c.op === "eq" ? cell === c.value : cell !== c.value;
          } else {
            if (typeof cell !== typeof c.value || (typeof cell !== "number" && typeof cell !== "string")) {
              const error =
                `${c.op} needs ${c.field} and the value to be both numbers or both text; ` +
                `got ${typeName(cell)} and ${typeName(c.value)}`;
              return fail(`Invalid filter: ${error}.`, error, "invalid_args");
            }
            const a = cell as number | string;
            const b = c.value as number | string;
            keep =
              c.op === "lt" ? a < b : c.op === "lte" ? a <= b : c.op === "gt" ? a > b : a >= b;
          }
          if (!keep) break;
        }
        if (keep) matches.push(row);
      }

      const agg = typeof args.agg === "string" ? args.agg : null;
      if (agg) {
        if (agg === "count") {
          const observation = `count = ${matches.length} of ${source.length} rows in ${table}.`;
          return ok(observation, { rows: [], count: matches.length, agg: matches.length });
        }
        const aggField = typeof args.aggField === "string" ? args.aggField : null;
        if (!aggField || !fields.includes(aggField)) {
          const error = `agg "${agg}" needs aggField to name a numeric field of ${table}`;
          return fail(`Cannot aggregate: ${error}. Fields of ${table}: ${fields.join(", ")}.`, error, "invalid_args");
        }
        const values = matches.map((r) => r[aggField]).filter((v): v is number => typeof v === "number");
        if (values.length !== matches.length) {
          const error = `${aggField} is not numeric in every matched row of ${table}`;
          return fail(`Cannot aggregate: ${error}. Pick a numeric field.`, error, "invalid_args");
        }
        if (values.length === 0) {
          // A sum over zero rows is 0, and 0 is exactly the kind of plausible
          // figure this layer exists to keep out of a board deck. Say
          // "undefined", loudly, and name the way forward.
          const observation =
            `No rows in ${table} matched the filter, so ${agg}(${aggField}) is undefined over 0 of ` +
            `${source.length} rows. Widen or drop a filter, or check the field values with a plain query first.`;
          return ok(observation, { rows: [], count: 0, agg: null });
        }
        const sum = values.reduce((a, b) => a + b, 0);
        const value =
          agg === "sum"
            ? roundTo(sum, 6)
            : agg === "avg"
              ? roundTo(sum / values.length, 6)
              : agg === "min"
                ? Math.min(...values)
                : Math.max(...values);
        const observation =
          `${agg}(${aggField}) = ${value} over ${matches.length} of ${source.length} rows in ${table}.`;
        return ok(observation, { rows: [], count: matches.length, agg: value });
      }

      const limitRaw = typeof args.limit === "number" ? args.limit : null;
      if (limitRaw !== null && limitRaw < 1) {
        const error = `limit must be at least 1, received ${limitRaw}`;
        return fail(`Invalid limit: ${error}.`, error, "invalid_args");
      }
      const limited = limitRaw === null ? matches : matches.slice(0, limitRaw);

      if (limited.length === 0) {
        const observation =
          `No rows in ${table} matched the filter (0 of ${source.length}). ` +
          `Widen or drop a filter, or list a few rows without a filter to see the values that exist.`;
        return ok(observation, { rows: [], count: 0, agg: null });
      }

      const shown = limited.slice(0, MAX_TABLE_RENDER_ROWS);
      // Cells are rendered unformatted: a grouped "4,182,000" cannot be fed
      // back into calc, and the model will try.
      const cell = (row: Record<string, unknown>, field: string): string => String(row[field] ?? "");
      const widths = select.map((f) => Math.max(f.length, ...shown.map((r) => cell(r, f).length)));
      const line = (cells: string[]) =>
        cells.map((c, i) => c.padEnd(widths[i] ?? c.length)).join("  ").trimEnd();
      const body = [line(select), ...shown.map((r) => line(select.map((f) => cell(r, f))))];
      const footer = `(${shown.length} of ${matches.length} matched rows; ${source.length} rows in ${table})`;

      return ok([...body, footer].join("\n"), { rows: limited, count: matches.length, agg: null });
    },
  };

  /* -- policy_check ------------------------------------------------------- */

  const policyCheck: ToolDef = {
    name: "policy_check",
    title: "Policy check",
    description:
      "Decide whether an action is allowed by the fixed rule table, and return the rule id a person can audit.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "What is being proposed, in plain words." },
        amount: { type: "number", description: "Amount in USD, or a percentage for a discount." },
        region: { type: "string", description: "Region the action touches.", enum: ["eu", "us", "apac"] },
      },
      required: ["action"],
    },
    deterministic: true,
    annotations: annotationsFor("policy_check"),
    timeoutMs: LOCAL_TIMEOUT_MS,
    example: `policy_check[{"action":"export customer data to the US","region":"eu"}]`,
    run: async (args) => {
      const action = String(args.action);
      const amount = typeof args.amount === "number" ? args.amount : null;
      const region = typeof args.region === "string" ? args.region : null;
      const words = new Set(tokenizeText(action).concat(action.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)));

      const keywordHits: PolicyRule[] = fx.policy.filter((r) => r.keywords.some((k) => words.has(k)));

      const matched = keywordHits.find((r) => {
        if (r.region !== undefined && r.region !== region) return false;
        const bounded = r.minAmount !== undefined || r.maxAmount !== undefined;
        if (bounded) {
          if (amount === null) return false;
          if (r.minAmount !== undefined && amount < r.minAmount) return false;
          if (r.maxAmount !== undefined && amount > r.maxAmount) return false;
        }
        return true;
      });

      if (matched) {
        return ok(`${matched.decision} (rule ${matched.id}): ${matched.rationale}`, {
          decision: matched.decision,
          ruleId: matched.id,
          rationale: matched.rationale,
        });
      }

      // Default to review, never to allow, and say precisely what was missing —
      // "no rule matched" on its own costs the model a whole step guessing.
      const decision: PolicyDecision = "review";
      const needsAmount = keywordHits.some((r) => r.minAmount !== undefined || r.maxAmount !== undefined);
      const needsRegion = keywordHits.some((r) => r.region !== undefined && r.region !== region);
      let rationale: string;
      if (keywordHits.length === 0) {
        rationale =
          `no rule in fixtures ${fx.version} covers "${action}", so a named person decides; ` +
          `policy_check never guesses a decision.`;
      } else if (needsAmount && amount === null) {
        rationale =
          `${keywordHits.length} rule(s) cover this action but each is bounded by amount, and no amount was ` +
          `given; call again with "amount" to get a decision.`;
      } else if (needsRegion && region === null) {
        rationale =
          `${keywordHits.length} rule(s) cover this action but apply to a named region, and no region was ` +
          `given; call again with "region" to get a decision.`;
      } else {
        rationale =
          `${keywordHits.length} rule(s) cover this action but none matches the amount and region given; ` +
          `a named person decides.`;
      }
      return ok(`${decision} (rule DEFAULT-00): ${rationale}`, {
        decision,
        ruleId: "DEFAULT-00",
        rationale,
      });
    },
  };

  /* -- date_math ---------------------------------------------------------- */

  const dateMath: ToolDef = {
    name: "date_math",
    title: "Date arithmetic",
    description: "Add days or months to a date, or convert one, using the run's own clock rather than today's.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: `A date as YYYY-MM-DD, or "now" for the run's clock.` },
        addDays: { type: "integer", description: "Days to add; negative subtracts." },
        addMonths: { type: "integer", description: "Months to add; negative subtracts. Applied before days." },
        format: { type: "string", description: "Shape of the returned value.", enum: ["iso", "quarter", "month"], default: "iso" },
      },
      required: ["from"],
    },
    deterministic: true,
    annotations: annotationsFor("date_math"),
    timeoutMs: LOCAL_TIMEOUT_MS,
    example: `date_math[{"from":"2026-04-15","addDays":45}]`,
    run: async (args, ctx) => {
      const from = String(args.from);
      // The clock is injected, never read from Date.now(): a tool that reads
      // the wall clock makes its own trace unreplayable, and a date-dependent
      // golden task would start failing on a calendar boundary.
      const startMs = from === "now" ? parseIsoDate(toIsoDate(ctx.now())) : parseIsoDate(from);
      if (startMs === null) {
        const error = `"${from}" is not a date`;
        return fail(
          `Cannot compute: ${error}. Pass a calendar date as YYYY-MM-DD (for example 2026-04-15) or "now".`,
          error,
          "invalid_args",
        );
      }
      const addMonths = typeof args.addMonths === "number" ? args.addMonths : 0;
      const addDays = typeof args.addDays === "number" ? args.addDays : 0;
      const format = String(args.format ?? "iso");

      const afterMonths = addMonths === 0 ? startMs : addMonthsUtc(startMs, addMonths);
      const endMs = afterMonths + addDays * 86_400_000;
      const iso = toIsoDate(endMs);
      const month = iso.slice(0, 7);
      const quarter = monthQuarter(month);
      const output = format === "quarter" ? quarter : format === "month" ? month : iso;

      const ops: string[] = [];
      if (addMonths !== 0) ops.push(`${addMonths > 0 ? "+" : "-"} ${Math.abs(addMonths)}m`);
      if (addDays !== 0) ops.push(`${addDays > 0 ? "+" : "-"} ${Math.abs(addDays)}d`);
      const lhs = ops.length > 0 ? `${toIsoDate(startMs)} ${ops.join(" ")}` : toIsoDate(startMs);

      return ok(`${lhs} = ${output} (${quarter})`, {
        input: toIsoDate(startMs),
        output,
        iso,
        month,
        quarter,
      });
    },
  };

  /* -- search_docs -------------------------------------------------------- */

  const searchDocs: ToolDef = {
    name: "search_docs",
    title: "Search documents",
    description:
      "Lexical search over the document corpus. It matches words, not meaning, so a near miss is normal: reformulate and search again.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to match. One distinctive noun usually beats a sentence." },
        limit: { type: "integer", description: "How many hits to return, 1 to 10.", default: 5 },
      },
      required: ["query"],
    },
    deterministic: true,
    annotations: annotationsFor("search_docs"),
    timeoutMs: LOCAL_TIMEOUT_MS,
    example: `search_docs[{"query":"refund authority"}]`,
    run: async (args) => {
      const query = String(args.query);
      const limitRaw = typeof args.limit === "number" ? args.limit : 5;
      if (limitRaw < 1 || limitRaw > 10) {
        const error = `limit must be between 1 and 10, received ${limitRaw}`;
        return fail(`Invalid limit: ${error}. Use the default of 5 if unsure.`, error, "invalid_args");
      }
      const terms = [...new Set(tokenizeText(query))];
      const N = stats.length;

      const scored = stats.map((s) => {
        let score = 0;
        for (const term of terms) {
          const df = stats.filter((d) => (d.counts.get(term) ?? 0) > 0).length;
          if (df === 0) continue;
          const tf = (s.counts.get(term) ?? 0) / (s.length || 1);
          if (tf === 0) continue;
          score += tf * Math.log(1 + N / df);
        }
        return { s, score: roundTo(score, 6) };
      });

      const hits = scored
        .filter((h) => h.score > 0)
        // Id ascending is the tie-break, so two documents with the same score
        // never swap places between runs.
        .sort((a, b) => (b.score - a.score) || (a.s.doc.id < b.s.doc.id ? -1 : 1))
        .slice(0, limitRaw);

      if (hits.length === 0) {
        const error = `no document contains any of the terms searched`;
        const observation =
          `No documents matched ${JSON.stringify(query)}. Terms searched: [${terms.join(", ")}]. ` +
          `The corpus holds ${N} documents and matches words, not meaning: try a single distinctive noun, ` +
          `or a different word for the same idea.`;
        return ok(observation, { hits: [], terms, error });
      }

      const value = hits.map((h) => {
        const best =
          h.s.doc.sentences
            .map((sentence) => ({
              sentence,
              n: terms.reduce((a, t) => a + (sentence.toLowerCase().includes(t) ? 1 : 0), 0),
            }))
            .sort((a, b) => b.n - a.n)[0]?.sentence ?? h.s.doc.sentences[0] ?? "";
        return {
          id: h.s.doc.id,
          title: h.s.doc.title,
          score: roundTo(h.score, 4),
          snippet: truncate(best, SNIPPET_CHARS),
        };
      });

      const observation = value
        .map((v, i) => `${i + 1}. ${v.id} — ${v.title} (${v.score.toFixed(2)})\n   "${v.snippet}"`)
        .join("\n");

      return ok(observation, { hits: value, terms });
    },
  };

  /* -- read_doc ----------------------------------------------------------- */

  const readDoc: ToolDef = {
    name: "read_doc",
    title: "Read document",
    description:
      "Open a document by id and return the first five sentences. Use lookup to move through the rest of it.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The document id, as returned by search_docs." },
      },
      required: ["id"],
    },
    deterministic: true,
    annotations: annotationsFor("read_doc"),
    timeoutMs: LOCAL_TIMEOUT_MS,
    example: `read_doc[{"id":"doc_refunds"}]`,
    run: async (args, ctx) => {
      const id = String(args.id);
      const doc = fx.docs.find((d) => d.id === id);
      if (!doc) {
        const similar = fx.docs
          .map((d) => ({ id: d.id, score: Math.max(diceSimilarity(id, d.id), diceSimilarity(id, d.title)) }))
          .sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : 1))
          .slice(0, 3)
          .map((d) => d.id);
        const error = `no document has id "${id}"`;
        return fail(
          `Could not find ${id}. Similar: [${similar.join(", ")}]. ` +
            `Open one of those, or run search_docs to get an exact id.`,
          error,
        );
      }

      cursors.set(ctx.runId, { docId: doc.id, keyword: "", matches: [], next: 0 });

      const window = doc.sentences.slice(0, WINDOW_SENTENCES);
      const observation =
        `${doc.id} — ${doc.title}\n${window.join(" ")}\n` +
        `(${window.length} of ${doc.sentences.length} sentences — use lookup[keyword] to move)`;

      return ok(observation, {
        id: doc.id,
        title: doc.title,
        window: window.join(" "),
        sentences: window,
        total: doc.sentences.length,
      });
    },
  };

  /* -- lookup ------------------------------------------------------------- */

  const lookup: ToolDef = {
    name: "lookup",
    title: "Lookup in the open document",
    description:
      "Find the next sentence containing a keyword in the document read_doc opened. Call it again with the same keyword for the next hit.",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "A word or phrase to find in the open document." },
      },
      required: ["keyword"],
    },
    // NOT deterministic, and that is the honest label: the cursor is state, so
    // the same arguments return a different sentence on the next call. Marking
    // it deterministic would also let the memo answer from a stale hit and
    // freeze the cursor where it stood.
    deterministic: false,
    annotations: annotationsFor("lookup"),
    timeoutMs: LOCAL_TIMEOUT_MS,
    example: `lookup[{"keyword":"renewal"}]`,
    run: async (args, ctx) => {
      const keyword = String(args.keyword);
      const cursor = cursors.get(ctx.runId);
      if (!cursor) {
        const error = `no document is open in this run`;
        return fail(
          `Cannot look up "${keyword}": ${error}. Call read_doc[{"id":"..."}] first; search_docs returns the ids.`,
          error,
        );
      }
      const doc = fx.docs.find((d) => d.id === cursor.docId);
      if (!doc) {
        const error = `the open document "${cursor.docId}" is no longer in the corpus`;
        return fail(`Cannot look up "${keyword}": ${error}. Call read_doc again.`, error);
      }

      if (cursor.keyword !== keyword) {
        const needle = keyword.toLowerCase();
        const matches: number[] = [];
        doc.sentences.forEach((s, i) => {
          if (s.toLowerCase().includes(needle)) matches.push(i);
        });
        cursor.keyword = keyword;
        cursor.matches = matches;
        cursor.next = 0;
      }

      if (cursor.matches.length === 0) {
        const observation =
          `No results for "${keyword}" in ${doc.title} (${doc.sentences.length} sentences). ` +
          `Try another word from the text, or read_doc another id.`;
        return ok(observation, { result: 0, of: 0, sentence: "" });
      }

      if (cursor.next >= cursor.matches.length) {
        // The exact phrase matters: it is what the exemplars teach the model
        // to read as "stop asking and use what you have".
        return ok("No more results.", { result: cursor.matches.length, of: cursor.matches.length, sentence: "" });
      }

      const index = cursor.matches[cursor.next] ?? 0;
      const sentence = doc.sentences[index] ?? "";
      const result = cursor.next + 1;
      const of = cursor.matches.length;
      cursor.next += 1;

      // The "(Result n / m)" prefix is generated, not decorative: it is the
      // only way the model learns that more hits exist.
      return ok(`(Result ${result} / ${of}) ${sentence}`, { result, of, sentence });
    },
  };

  /* -- write_artifact ----------------------------------------------------- */

  const writeArtifact: ToolDef = {
    name: "write_artifact",
    title: "Write artifact",
    description:
      "Write a file into this run's own directory. Give a plain file name; the directory is chosen for you.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: `A plain file name such as "summary.md". No directories.` },
        content: { type: "string", description: "The file body." },
      },
      required: ["name", "content"],
    },
    deterministic: true,
    annotations: annotationsFor("write_artifact"),
    timeoutMs: IO_TIMEOUT_MS,
    example: `write_artifact[{"name":"summary.md","content":"# Findings\\n..."}]`,
    run: async (args, ctx) => {
      const name = String(args.name);
      const content = String(args.content);

      // The path is FORCED under the run's directory and the name must be a
      // bare file name. A model-supplied path is a traversal waiting to
      // happen, and "sanitise the path the model sent" is a game nobody wins;
      // refusing anything that is not a plain name is the version with no
      // clever bypass.
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) || name.includes("..")) {
        const error = `"${name}" is not a plain file name`;
        return fail(
          `Refused: ${error}. write_artifact writes inside this run's own directory ` +
            `(/harness/runs/${ctx.runId}/) and takes a name of letters, digits, dot, dash and underscore only, ` +
            `up to 64 characters — for example "summary.md". Directories and ".." are not accepted.`,
          error,
          "denied",
        );
      }

      if (content.length > MAX_ARTIFACT_CHARS) {
        const error = `the content is ${content.length} characters; the limit is ${MAX_ARTIFACT_CHARS}`;
        return fail(`Refused: ${error}. Write a shorter summary, or split it across two files.`, error, "denied");
      }

      const path = `/harness/runs/${ctx.runId}/${name}`;
      const writer = opts.writeArtifact;
      if (!writer) {
        const error = `no filesystem is bound in this environment`;
        return fail(
          `Cannot write ${path}: ${error}. Put the content in your final answer instead.`,
          error,
          "denied",
        );
      }

      const res = await writer(path, content);
      if (!res.ok) {
        const error = res.error ?? "the write failed without a reason";
        return fail(`Could not write ${path}: ${error}. Try a different file name, or answer without the file.`, error);
      }

      const bytes = utf8Bytes(content);
      return ok(`Wrote ${res.path} (${groupDigits(bytes, 0)} bytes).`, { path: res.path, bytes });
    },
  };

  /* -- think -------------------------------------------------------------- */

  const think: ToolDef = {
    name: "think",
    title: "Think",
    description:
      "Record a step of reasoning without touching anything. Use it when the next move needs working out first.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The reasoning to record." },
      },
      required: ["text"],
    },
    // A no-op that makes reasoning a first-class turn: the transcript builder
    // then needs no special case, and the trace shows a thought as a span like
    // every other action.
    deterministic: true,
    annotations: annotationsFor("think"),
    timeoutMs: LOCAL_TIMEOUT_MS,
    example: `think[{"text":"Q1 covers three months, so I need the sum before the multiplier."}]`,
    run: async () => ok("OK.", {}),
  };

  return [kpi, calc, tableQuery, policyCheck, dateMath, searchDocs, readDoc, lookup, writeArtifact, think];
}

export { FIXTURE_VERSION };
