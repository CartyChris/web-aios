/* ────────────────────────────────────────────────────────────────────────────
   Layer 6 — the receipt.

   A trace exists so that a bad outcome can be explained: read the trace, find
   the wrong step, change the harness so it never repeats. Every decision in
   this file follows from that. Spans are immutable (endSpan returns a copy),
   because a viewer holding an old reference must keep showing what it showed.
   Truncation and redaction happen at WRITE time, not at display time: the file
   on disk is the artefact people paste into bug reports, and a key redacted
   only in the UI has already leaked by then. Every heuristic here is local —
   no model call — because a checker that costs money per run is a checker that
   gets switched off on exactly the long, expensive runs that need it.
   ──────────────────────────────────────────────────────────────────────────── */

import { DEFAULT_LOOP_CONFIG, TRACE_LIMITS } from "./config";
import type { RunResult, RunTotals, Span, SpanKind, SpanRole, Step, TraceFlag } from "./types";

export const REDACTED = "[redacted]";

/** Below this, a secret supplied by the caller is refused rather than applied.
 *  A 2-character "secret" turns redaction into shredding: the guard would
 *  destroy the very trace it exists to protect. */
export const MIN_SECRET_CHARS = 4;

/** Character n-gram width for the circular-reasoning comparison. */
const SHINGLE_K = 5;

/** Texts shorter than this are compared by equality, not by Jaccard.
 *  Flooring on SHINGLE COUNT instead would be the classic inverted guard: a
 *  two-word step yields zero 5-grams, Jaccard of two empty sets is 0/0, and the
 *  detector silently stops detecting the shortest, most obviously repeated
 *  steps. Floor on the length of the text itself. */
const MIN_COMPARE_CHARS = 12;

const RUNAWAY_DEPTH = 8;
const ERROR_CASCADE_MIN = 3;
const COST_SPIKE_FACTOR = 4;
const COST_SPIKE_FLOOR_USD = 0.01;

/* ── Redaction ───────────────────────────────────────────────────────────── */

/** Provider key shapes, most specific first: the generic `sk-` rule cannot
 *  cross a hyphen, so `sk-ant-…` must be consumed by its own rule before it
 *  reaches the generic one. */
const KEY_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /sk-or-v1-[A-Za-z0-9_-]{16,}/g,
  /sk-proj-[A-Za-z0-9_-]{16,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /AIza[A-Za-z0-9_-]{30,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /ghp_[A-Za-z0-9]{28,}/g,
  /gho_[A-Za-z0-9]{28,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /hf_[A-Za-z0-9]{30,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
];

/** A key carried in a named field survives every shape rule above, because the
 *  value itself may be an opaque hex blob with no recognisable prefix. Match on
 *  the FIELD NAME instead and blank whatever it holds. */
const SECRET_FIELD =
  /("?(?:api[-_]?key|apikey|api[-_]?secret|access[-_]?token|auth[-_]?token|authorization|password|passwd|secret|token)"?\s*[:=]\s*)("?)(?!\[redacted\])([^\s"',&}\]]{8,})\2/gi;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Strips key-shaped text and any caller-supplied secrets.
 *  Ordinary prose is left alone: every rule demands either a known key prefix
 *  or a named secret field, never "this looks random". */
export function redact(text: string, secrets: string[] = []): string {
  // Field rule first, shape rules second. The other order lets the shape rule
  // rewrite a value to "[redacted]" and the field rule then redact THAT,
  // producing "[redacted]]" — a cosmetic bug that makes a reader think the
  // redactor is unreliable, which is the one thing it cannot afford to look.
  // The negative lookahead makes the mistake impossible in either order.
  let out = text.replace(SECRET_FIELD, (_m, head: string, quote: string) => `${head}${quote}${REDACTED}${quote}`);
  for (const re of KEY_PATTERNS) out = out.replace(re, REDACTED);
  for (const s of secrets) {
    if (typeof s !== "string" || s.length < MIN_SECRET_CHARS) continue;
    out = out.replace(new RegExp(escapeRegExp(s), "g"), REDACTED);
  }
  return out;
}

/** Redact BEFORE truncating. The other order can slice a key in half and leave
 *  a fragment that no pattern recognises but a reader can still recombine with
 *  a second trace. */
function seal(text: string | undefined, limit: number, secrets: string[]): string | undefined {
  if (text === undefined) return undefined;
  const clean = redact(text, secrets);
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit)}... [+${clean.length - limit} chars truncated]`;
}

/* ── Span lifecycle ──────────────────────────────────────────────────────── */

export interface SpanInit {
  id: string;
  parentId: string | null;
  name: string;
  kind: SpanKind;
  role: SpanRole;
  runId: string;
  stepIndex?: number;
  input?: string;
  attrs?: Span["attrs"];
  /** Injected clock reading. Pure modules never call Date.now(). */
  at: number;
  secrets?: string[];
}

export function startSpan(init: SpanInit): Span {
  const secrets = init.secrets ?? [];
  const span: Span = {
    id: init.id,
    parentId: init.parentId,
    name: init.name,
    kind: init.kind,
    role: init.role,
    runId: init.runId,
    startedAt: init.at,
  };
  if (init.stepIndex !== undefined) span.stepIndex = init.stepIndex;
  const input = seal(init.input, TRACE_LIMITS.input, secrets);
  if (input !== undefined) span.input = input;
  if (init.attrs !== undefined) span.attrs = { ...init.attrs };
  return span;
}

export function endSpan(span: Span, patch: Partial<Span> & { at: number; secrets?: string[] }): Span {
  const { at, secrets: patchSecrets, ...rest } = patch;
  const secrets = patchSecrets ?? [];
  const merged: Span = { ...span, ...rest, endedAt: at };
  const text = seal(merged.text, TRACE_LIMITS.text, secrets);
  if (text === undefined) delete merged.text;
  else merged.text = text;
  const input = seal(merged.input, TRACE_LIMITS.input, secrets);
  if (input === undefined) delete merged.input;
  else merged.input = input;
  const error = seal(merged.error, TRACE_LIMITS.error, secrets);
  if (error === undefined) delete merged.error;
  else merged.error = error;
  return merged;
}

/* ── Tree ────────────────────────────────────────────────────────────────── */

/** The spec wrote this as `Array<{ span; children: ReturnType<typeof spanTree> }>`,
 *  which TypeScript rejects as a self-referential annotation. A named interface
 *  is the same shape. */
export interface SpanNode {
  span: Span;
  children: SpanNode[];
}

export interface RolledSpan {
  span: Span;
  children: RolledSpan[];
  /** This span plus everything beneath it. */
  subtotal: RunTotals;
}

/** Orphans (parentId naming a span that is not in the array) become roots.
 *  Dropping them would make the receipt quietly incomplete, which is the one
 *  failure mode a trace may not have. */
export function spanTree(spans: Span[]): SpanNode[] {
  const present = new Set(spans.map((s) => s.id));
  const nodes = new Map<string, SpanNode>();
  for (const span of spans) nodes.set(span.id, { span, children: [] });

  const roots: SpanNode[] = [];
  for (const span of spans) {
    const node = nodes.get(span.id);
    if (!node) continue;
    const parentId = span.parentId;
    if (parentId !== null && parentId !== span.id && present.has(parentId)) {
      const parent = nodes.get(parentId);
      if (parent) {
        parent.children.push(node);
        continue;
      }
    }
    roots.push(node);
  }

  // A parentId cycle would have consumed every node into the cycle and left no
  // roots at all; surfacing the cycle's members as roots keeps the receipt
  // readable instead of returning an empty tree.
  if (roots.length === 0 && spans.length > 0) {
    const reachable = new Set<string>();
    const walk = (n: SpanNode): void => {
      if (reachable.has(n.span.id)) return;
      reachable.add(n.span.id);
      for (const c of n.children) walk(c);
    };
    const first = nodes.get(spans[0]!.id);
    if (first) {
      walk(first);
      roots.push(first);
    }
    for (const span of spans) {
      if (!reachable.has(span.id)) {
        const n = nodes.get(span.id);
        if (n) {
          walk(n);
          roots.push(n);
        }
      }
    }
  }
  return roots;
}

function emptyTotals(): RunTotals {
  return {
    steps: 0, llmCalls: 0, repairCalls: 0, toolCalls: 0, toolErrors: 0,
    tokensIn: 0, tokensOut: 0, costUsd: 0, ms: 0,
  };
}

/** Float addition prints $0.035000000000000003 in a receipt and makes a reader
 *  doubt a number that is in fact correct. Round at the point of reporting. */
function round(n: number): number {
  return Math.round(n * 1e10) / 1e10;
}

function ownTotals(span: Span): RunTotals {
  const t = emptyTotals();
  if (span.role === "step") t.steps = 1;
  if (span.role === "llm") t.llmCalls = 1;
  if (span.role === "llm_repair") t.repairCalls = 1;
  if (span.role === "tool") {
    t.toolCalls = 1;
    if (span.error) t.toolErrors = 1;
  }
  t.tokensIn = span.tokensIn ?? 0;
  t.tokensOut = span.tokensOut ?? 0;
  t.costUsd = span.costUsd ?? 0;
  t.ms = span.endedAt !== undefined ? Math.max(0, span.endedAt - span.startedAt) : 0;
  return t;
}

/** Roll-up rule: a node's subtotal is its own recorded values plus the
 *  subtotals of its children. The convention that makes this safe is that
 *  container spans (role "run", "step") never carry costUsd or tokens
 *  themselves — only the leaf that actually spent does. `ms` is the exception:
 *  it is the node's OWN elapsed wall time, because adding a parent's elapsed
 *  time to its children's would count the same seconds two or three times. */
export function rollUp(spans: Span[]): RolledSpan[] {
  const build = (node: SpanNode): RolledSpan => {
    const children = node.children.map(build);
    const subtotal = ownTotals(node.span);
    for (const c of children) {
      subtotal.steps += c.subtotal.steps;
      subtotal.llmCalls += c.subtotal.llmCalls;
      subtotal.repairCalls += c.subtotal.repairCalls;
      subtotal.toolCalls += c.subtotal.toolCalls;
      subtotal.toolErrors += c.subtotal.toolErrors;
      subtotal.tokensIn += c.subtotal.tokensIn;
      subtotal.tokensOut += c.subtotal.tokensOut;
      subtotal.costUsd += c.subtotal.costUsd;
    }
    subtotal.costUsd = round(subtotal.costUsd);
    return { span: node.span, children, subtotal };
  };
  return spanTree(spans).map(build);
}

/** Totals for a whole run. `ms` is wall time (last end minus first start), not
 *  a sum: nested spans overlap by construction and summing them reports a
 *  90-second run as four minutes. */
export function spanTotals(spans: Span[]): RunTotals {
  const t = emptyTotals();
  if (spans.length === 0) return t;
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const span of spans) {
    const own = ownTotals(span);
    t.steps += own.steps;
    t.llmCalls += own.llmCalls;
    t.repairCalls += own.repairCalls;
    t.toolCalls += own.toolCalls;
    t.toolErrors += own.toolErrors;
    t.tokensIn += own.tokensIn;
    t.tokensOut += own.tokensOut;
    t.costUsd += own.costUsd;
    first = Math.min(first, span.startedAt);
    last = Math.max(last, span.endedAt ?? span.startedAt);
  }
  t.costUsd = round(t.costUsd);
  t.ms = Math.max(0, last - first);
  return t;
}

export function maxDepth(spans: Span[]): number {
  const depth = (n: SpanNode, d: number): number =>
    n.children.length === 0 ? d : Math.max(...n.children.map((c) => depth(c, d + 1)));
  const roots = spanTree(spans);
  return roots.length === 0 ? 0 : Math.max(...roots.map((r) => depth(r, 1)));
}

/** Keeps the head and the tail and says how much of the middle went. A run
 *  that blows the span quota is usually one whose beginning (what it was asked)
 *  and end (where it stopped) are the two parts you actually need. */
export function capSpans(spans: Span[], limit: number = TRACE_LIMITS.spansPerRun): { spans: Span[]; dropped: number } {
  if (spans.length <= limit) return { spans, dropped: 0 };
  const head = Math.ceil(limit / 2);
  const tail = limit - head;
  const kept = tail > 0 ? [...spans.slice(0, head), ...spans.slice(spans.length - tail)] : spans.slice(0, head);
  return { spans: kept, dropped: spans.length - kept.length };
}

/* ── Local heuristics ────────────────────────────────────────────────────── */

export interface CheckTraceOptions {
  /** Jaccard above which two steps count as the same reasoning. */
  similarity?: number;
  stepTimeoutMs?: number;
  /** Reference "now". Defaults to the latest timestamp in the trace itself —
   *  checkTrace is pure and has no clock of its own. */
  now?: number;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

function shingles(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE_K <= s.length; i++) out.add(s.slice(i, i + SHINGLE_K));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  return inter / (a.size + b.size - inter);
}

function spanIdsForStep(spans: Span[], index: number): string[] {
  return spans.filter((s) => s.stepIndex === index).map((s) => s.id);
}

export function checkTrace(spans: Span[], steps: Step[], opts: CheckTraceOptions = {}): TraceFlag[] {
  const similarity = opts.similarity ?? DEFAULT_LOOP_CONFIG.loopSimilarity;
  const stepTimeoutMs = opts.stepTimeoutMs ?? DEFAULT_LOOP_CONFIG.stepTimeoutMs;
  const flags: TraceFlag[] = [];

  /* 1. circular — the same reasoning twice. Compare only pairs that share at
     least one shingle; all-pairs Jaccard is quadratic and a checker that gets
     slow on long traces is one that gets disabled on exactly the traces that
     need it. */
  const texts = steps.map((s) => normalize(`${s.thought} ${s.action ? s.action.raw : ""}`));
  const longIdx: number[] = [];
  const shortByText = new Map<string, number[]>();
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i] ?? "";
    if (t.length >= MIN_COMPARE_CHARS) longIdx.push(i);
    else if (t.length > 0) shortByText.set(t, [...(shortByText.get(t) ?? []), i]);
  }
  const grams = new Map<number, Set<string>>();
  const postings = new Map<string, number[]>();
  for (const i of longIdx) {
    const g = shingles(texts[i] ?? "");
    grams.set(i, g);
    for (const s of g) postings.set(s, [...(postings.get(s) ?? []), i]);
  }
  const candidates = new Set<string>();
  for (const list of postings.values()) {
    if (list.length < 2) continue;
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) candidates.add(`${list[a]}:${list[b]}`);
    }
  }
  const circularPairs: Array<[number, number, number]> = [];
  for (const key of candidates) {
    const [as, bs] = key.split(":");
    const i = Number(as);
    const j = Number(bs);
    const sim = jaccard(grams.get(i) ?? new Set(), grams.get(j) ?? new Set());
    if (sim >= similarity) circularPairs.push([i, j, sim]);
  }
  for (const idxs of shortByText.values()) {
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) circularPairs.push([idxs[a]!, idxs[b]!, 1]);
    }
  }
  circularPairs.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  if (circularPairs.length > 0) {
    const pair = circularPairs[0]!;
    const si = steps[pair[0]]?.index ?? pair[0] + 1;
    const sj = steps[pair[1]]?.index ?? pair[1] + 1;
    flags.push({
      code: "circular",
      severity: "error",
      label: "Circular reasoning",
      detail: `steps ${si} and ${sj} are ${(pair[2] * 100).toFixed(0)}% similar (threshold ${(similarity * 100).toFixed(0)}%); ${circularPairs.length} repeated pair(s) in total`,
      spanIds: [...spanIdsForStep(spans, si), ...spanIdsForStep(spans, sj)],
    });
  }

  /* 2. empty_step — a step that taught nobody anything: no thought and no
     action, or an action whose observation came back blank. An empty
     observation is worse than an error, because the model reasons from the
     silence and repeats the action. */
  const empties = steps.filter(
    (s) => (s.action === null && s.thought.trim() === "") || (s.action !== null && s.observation.trim() === ""),
  );
  if (empties.length > 0) {
    flags.push({
      code: "empty_step",
      severity: "warn",
      label: "Empty step",
      detail: `step(s) ${empties.map((s) => s.index).join(", ")} produced neither a thought nor an observation`,
      spanIds: empties.flatMap((s) => spanIdsForStep(spans, s.index)),
    });
  }

  /* 3. all_tool_no_answer — work was done and nothing was returned. */
  const toolSpans = spans.filter((s) => s.role === "tool");
  const finished = steps.some((s) => s.outcome === "finished");
  if (toolSpans.length > 0 && !finished) {
    flags.push({
      code: "all_tool_no_answer",
      severity: "error",
      label: "Tools ran, no answer",
      detail: `${toolSpans.length} tool call(s) and no step with outcome "finished"`,
      spanIds: toolSpans.map((s) => s.id),
    });
  }

  /* 4. error_cascade */
  const failedTools = toolSpans.filter((s) => Boolean(s.error));
  if (failedTools.length >= ERROR_CASCADE_MIN) {
    flags.push({
      code: "error_cascade",
      severity: "error",
      label: "Tool error cascade",
      detail: `${failedTools.length} failed tool span(s): ${failedTools.map((s) => s.name).join(", ")}`,
      spanIds: failedTools.map((s) => s.id),
    });
  }

  /* 5. runaway_depth */
  const depth = maxDepth(spans);
  if (depth > RUNAWAY_DEPTH) {
    flags.push({
      code: "runaway_depth",
      severity: "warn",
      label: "Runaway nesting",
      detail: `span tree is ${depth} deep (limit ${RUNAWAY_DEPTH})`,
      spanIds: spans.filter((s) => s.parentId !== null).slice(-1).map((s) => s.id),
    });
  }

  /* 6. cost_spike — both conditions, deliberately. The ratio alone fires on a
     trace of three-cent calls where one costs four cents, which is noise; the
     absolute floor alone fires on every expensive-but-uniform run. */
  const costed = spans.filter((s) => typeof s.costUsd === "number" && s.costUsd > 0);
  if (costed.length > 1) {
    const total = costed.reduce((a, s) => a + (s.costUsd ?? 0), 0);
    // LEAVE-ONE-OUT baseline, and this is not a refinement. Against the mean of
    // ALL spans the baseline moves WITH the outlier: one span of cost x among n
    // gives a mean of roughly x/n, so `x > 4 * mean` needs n > 4 and the check
    // is mathematically incapable of firing on a four-span run — a guard whose
    // threshold moves in the same direction as the thing it is detecting. The
    // absolute floor stays because a 100x ratio on tenth-of-a-cent calls is
    // noise, not a spike.
    const spikes = costed.filter((s) => {
      const cost = s.costUsd ?? 0;
      const othersMean = (total - cost) / (costed.length - 1);
      return cost > COST_SPIKE_FACTOR * othersMean && cost > COST_SPIKE_FLOOR_USD;
    });
    if (spikes.length > 0) {
      const baseline = (id: string): number => {
        const c = costed.find((s) => s.id === id)?.costUsd ?? 0;
        return (total - c) / (costed.length - 1);
      };
      flags.push({
        code: "cost_spike",
        severity: "warn",
        label: "Cost spike",
        detail: spikes
          .map((s) => `${s.name} $${(s.costUsd ?? 0).toFixed(4)} against $${baseline(s.id).toFixed(4)} for the other ${costed.length - 1} span(s)`)
          .join("; "),
        spanIds: spikes.map((s) => s.id),
      });
    }
  }

  /* 7. stalled */
  let latest = Number.NEGATIVE_INFINITY;
  for (const s of spans) latest = Math.max(latest, s.endedAt ?? s.startedAt);
  const now = opts.now ?? (latest === Number.NEGATIVE_INFINITY ? 0 : latest);
  const stalled = spans.filter((s) => s.endedAt === undefined && now - s.startedAt > stepTimeoutMs);
  if (stalled.length > 0) {
    flags.push({
      code: "stalled",
      severity: "warn",
      label: "Stalled span",
      detail: `${stalled.map((s) => `${s.name} open ${now - s.startedAt}ms`).join(", ")} against a step timeout of ${stepTimeoutMs}ms`,
      spanIds: stalled.map((s) => s.id),
    });
  }

  /* 8. context_drop — the trusted-context layer withheld facts. The type union
     reserves this code and nothing else in the harness emits a TraceFlag, so it
     is raised here from the context span's own attrs. An agent that silently
     loses context produces confident wrong answers and no way to see why. */
  const dropped = spans.filter(
    (s) => s.role === "context" && typeof s.attrs?.withheld === "number" && s.attrs.withheld > 0,
  );
  if (dropped.length > 0) {
    flags.push({
      code: "context_drop",
      severity: "warn",
      label: "Context withheld",
      detail: dropped.map((s) => `${s.name} withheld ${String(s.attrs?.withheld)} fact(s)`).join(", "),
      spanIds: dropped.map((s) => s.id),
    });
  }

  return flags;
}

/* ── Receipts ────────────────────────────────────────────────────────────── */

function deepRedact(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") return redact(value, secrets);
  if (Array.isArray(value)) return value.map((v) => deepRedact(v, secrets));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = deepRedact(v, secrets);
    return out;
  }
  return value;
}

export function traceToJson(run: RunResult, secrets: string[] = []): string {
  const { spans, dropped } = capSpans(run.spans);
  const shaped = { ...run, spans, spansDropped: dropped };
  return JSON.stringify(deepRedact(shaped, secrets), null, 2);
}

function fence(body: string): string {
  return ["```", body, "```"].join("\n");
}

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

/** The receipt a person reads. Ordered the way a post-mortem is actually
 *  conducted: what happened, what it cost, what looks wrong, then the steps. */
export function traceToMarkdown(run: RunResult, secrets: string[] = []): string {
  const red = (s: string): string => redact(s, secrets);
  const { spans, dropped } = capSpans(run.spans);
  const totals = run.totals;
  const out: string[] = [];

  out.push(`# Run ${run.runId}`);
  out.push("");
  out.push(`- Objective: ${red(run.objective)}`);
  out.push(`- Status: ${run.status}`);
  out.push(`- Config: ${run.configId}${run.agentId ? ` / agent ${run.agentId}` : ""}`);
  out.push(`- Trigger: ${run.trigger.kind} (${run.trigger.triggerId})`);
  out.push(`- Fingerprint: ${run.fingerprint}`);
  out.push(`- Elapsed: ${run.endedAt - run.startedAt}ms`);
  out.push("");

  out.push("## Answer");
  out.push("");
  out.push(run.answer.trim() === "" ? "_No answer was produced._" : red(run.answer));
  out.push("");

  out.push("## Totals");
  out.push("");
  out.push("| metric | value |");
  out.push("| --- | --- |");
  out.push(`| steps | ${totals.steps} |`);
  out.push(`| llm calls | ${totals.llmCalls} |`);
  out.push(`| repair calls | ${totals.repairCalls} |`);
  out.push(`| tool calls | ${totals.toolCalls} |`);
  out.push(`| tool errors | ${totals.toolErrors} |`);
  out.push(`| tokens in | ${totals.tokensIn} |`);
  out.push(`| tokens out | ${totals.tokensOut} |`);
  out.push(`| cost | ${usd(totals.costUsd)} |`);
  out.push(`| wall time | ${totals.ms}ms |`);
  out.push("");

  if (run.verdict) {
    out.push("## Verdict");
    out.push("");
    out.push(`- ${run.verdict.pass ? "PASS" : "FAIL"} against ${run.verdict.dodId}, score ${run.verdict.score.toFixed(2)}`);
    out.push(`- Reason: ${red(run.verdict.reason)}`);
    if (run.verdict.decidedBy) out.push(`- Decided by: ${red(run.verdict.decidedBy)}`);
    for (const o of run.verdict.outcomes) {
      const mark = o.met === null ? "pending" : o.met ? "met" : "not met";
      out.push(`  - ${o.criterionId} (${o.by}): ${mark} - ${red(o.observed)}`);
    }
    out.push("");
  }

  const traceFlags = checkTrace(spans, run.steps);
  out.push("## Flags");
  out.push("");
  if (run.flags.length === 0 && traceFlags.length === 0) {
    out.push("None.");
  } else {
    for (const f of run.flags) out.push(`- [${f.severity}] ${f.code} at step ${f.stepIndex}: ${red(f.detail)}`);
    for (const f of traceFlags) out.push(`- [${f.severity}] ${f.code}: ${red(f.detail)} (${f.spanIds.length} span(s))`);
  }
  out.push("");

  out.push("## Steps");
  out.push("");
  if (run.steps.length === 0) out.push("No steps were recorded.");
  for (const s of run.steps) {
    out.push(`### Step ${s.index} - ${s.outcome} (${s.ms}ms, ${usd(s.costUsd)})`);
    out.push("");
    out.push(`**Thought:** ${s.thought.trim() === "" ? "_none_" : red(s.thought)}`);
    out.push("");
    if (s.action) {
      out.push(`**Action:** \`${red(s.action.raw)}\``);
    } else {
      out.push(`**Action:** _none_${s.parseError ? ` - parse error: ${red(s.parseError)}` : ""}`);
    }
    out.push("");
    out.push("**Observation:**");
    out.push("");
    out.push(fence(s.observation.trim() === "" ? "(empty)" : red(s.observation)));
    out.push("");
    if (s.tool) {
      out.push(`Tool \`${s.tool.tool}\` -> ${s.tool.result.status} in ${s.tool.ms}ms${s.tool.result.cached ? " (cached)" : ""}`);
      out.push("");
    }
    if (s.repair) {
      out.push(`Repair call: ${s.repair.model}, ${s.repair.tokensIn}/${s.repair.tokensOut} tokens, ${usd(s.repair.costUsd)}`);
      out.push("");
    }
  }

  out.push("## Span tree");
  out.push("");
  const lines: string[] = [];
  const walk = (node: RolledSpan, depth: number): void => {
    const s = node.span;
    const ms = s.endedAt !== undefined ? `${s.endedAt - s.startedAt}ms` : "open";
    const cost = node.subtotal.costUsd > 0 ? ` ${usd(node.subtotal.costUsd)}` : "";
    const tok = node.subtotal.tokensIn + node.subtotal.tokensOut > 0
      ? ` ${node.subtotal.tokensIn}/${node.subtotal.tokensOut}tok` : "";
    const err = s.error ? ` ERROR: ${red(s.error)}` : "";
    lines.push(`${"  ".repeat(depth)}- ${s.role ?? s.kind} ${red(s.name)} [${ms}${cost}${tok}]${err}`);
    for (const c of node.children) walk(c, depth + 1);
  };
  for (const root of rollUp(spans)) walk(root, 0);
  out.push(lines.length === 0 ? "No spans were recorded." : lines.join("\n"));
  if (dropped > 0) {
    out.push("");
    out.push(`_${dropped} middle span(s) omitted; the trace exceeded ${TRACE_LIMITS.spansPerRun} spans._`);
  }
  out.push("");

  return out.join("\n");
}
