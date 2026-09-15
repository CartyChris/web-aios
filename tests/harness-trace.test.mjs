/**
 * The receipt layer.
 *
 * A trace that cannot explain an outcome is a bug in the trace, so every test
 * here asserts on a computed number or an exact string, never on "it did not
 * throw". Each heuristic gets two tests: the case it exists to catch, and a
 * healthy trace it must stay silent on. A checker that flags everything is
 * worse than no checker, because it is the one people switch off.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  startSpan, endSpan, spanTree, rollUp, spanTotals, maxDepth, capSpans,
  checkTrace, redact, traceToMarkdown, traceToJson, REDACTED,
} from "../.test-build/harness/trace.js";
import { TRACE_LIMITS } from "../.test-build/harness/config.js";

/* ── fixtures ────────────────────────────────────────────────────────────── */

function mkSpan(o) {
  return {
    id: o.id,
    parentId: o.parentId ?? null,
    name: o.name ?? o.id,
    kind: o.kind ?? "app",
    role: o.role,
    runId: "run_1",
    startedAt: o.startedAt ?? 0,
    ...(o.endedAt === undefined ? {} : { endedAt: o.endedAt }),
    ...(o.tokensIn === undefined ? {} : { tokensIn: o.tokensIn }),
    ...(o.tokensOut === undefined ? {} : { tokensOut: o.tokensOut }),
    ...(o.costUsd === undefined ? {} : { costUsd: o.costUsd }),
    ...(o.error === undefined ? {} : { error: o.error }),
    ...(o.stepIndex === undefined ? {} : { stepIndex: o.stepIndex }),
    ...(o.attrs === undefined ? {} : { attrs: o.attrs }),
  };
}

function mkLlm(spanId) {
  return {
    spanId, provider: "openrouter", model: "anthropic/claude-opus-5",
    system: "sys", prompt: "prompt", stop: [], temperature: 0, maxTokens: 400,
    output: "out", tokensIn: 10, tokensOut: 5, costUsd: 0.001, ms: 100, attempt: 1,
  };
}

function mkStep(o) {
  return {
    index: o.index,
    thought: o.thought ?? "",
    action: o.action ?? null,
    observation: o.observation ?? "",
    outcome: o.outcome ?? "acted",
    llm: mkLlm(`llm_${o.index}`),
    startedAt: 0,
    ms: 10,
    costUsd: 0.001,
    ...(o.parseError === undefined ? {} : { parseError: o.parseError }),
  };
}

function act(raw) {
  return { verb: raw.split("[")[0], raw, args: {} };
}

/** A trace with nothing wrong with it. Every negative control uses this. */
function healthy() {
  const spans = [
    mkSpan({ id: "s0", role: "run", kind: "app", startedAt: 0, endedAt: 1000 }),
    mkSpan({ id: "s1", parentId: "s0", role: "step", stepIndex: 1, startedAt: 10, endedAt: 500 }),
    mkSpan({ id: "s2", parentId: "s1", role: "llm", kind: "model", stepIndex: 1, startedAt: 10, endedAt: 200, tokensIn: 100, tokensOut: 50, costUsd: 0.010 }),
    mkSpan({ id: "s3", parentId: "s1", role: "tool", kind: "tool", stepIndex: 1, name: "kpi", startedAt: 210, endedAt: 300 }),
    mkSpan({ id: "s4", parentId: "s0", role: "step", stepIndex: 2, startedAt: 510, endedAt: 900 }),
    mkSpan({ id: "s5", parentId: "s4", role: "llm", kind: "model", stepIndex: 2, startedAt: 510, endedAt: 700, tokensIn: 200, tokensOut: 60, costUsd: 0.012 }),
    mkSpan({ id: "s6", parentId: "s4", role: "context", kind: "system", stepIndex: 2, name: "context", startedAt: 700, endedAt: 705, attrs: { withheld: 0 } }),
  ];
  const steps = [
    mkStep({ index: 1, thought: "Look up annual recurring revenue for the first quarter.", action: act('kpi[{"metric":"arr"}]'), observation: "arr = 4210000", outcome: "acted" }),
    mkStep({ index: 2, thought: "The figure is in hand, so state it and stop.", action: act("finish[arr is 4210000]"), observation: "done", outcome: "finished" }),
  ];
  return { spans, steps };
}

/* ── tree and roll-up ────────────────────────────────────────────────────── */

const nested = [
  mkSpan({ id: "s0", role: "run", startedAt: 0, endedAt: 1000 }),
  mkSpan({ id: "s1", parentId: "s0", role: "step", startedAt: 10, endedAt: 500 }),
  mkSpan({ id: "s2", parentId: "s1", role: "llm", kind: "model", startedAt: 10, endedAt: 200, tokensIn: 100, tokensOut: 50, costUsd: 0.010 }),
  mkSpan({ id: "s3", parentId: "s1", role: "tool", kind: "tool", startedAt: 210, endedAt: 300 }),
  mkSpan({ id: "s3a", parentId: "s3", role: "tool", kind: "tool", startedAt: 220, endedAt: 280, tokensIn: 5, costUsd: 0.001 }),
  mkSpan({ id: "s4", parentId: "s0", role: "step", startedAt: 510, endedAt: 900 }),
  mkSpan({ id: "s5", parentId: "s4", role: "llm", kind: "model", startedAt: 510, endedAt: 700, tokensIn: 200, tokensOut: 60, costUsd: 0.020 }),
  mkSpan({ id: "s6", parentId: "s4", role: "llm_repair", kind: "model", startedAt: 700, endedAt: 750, tokensIn: 50, tokensOut: 10, costUsd: 0.005 }),
  mkSpan({ id: "s7", parentId: "s4", role: "tool", kind: "tool", name: "sql", startedAt: 760, endedAt: 800, error: "boom" }),
];

test("spanTree nests by parentId and promotes orphans rather than losing them", () => {
  const roots = spanTree(nested);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].span.id, "s0");
  assert.deepStrictEqual(roots[0].children.map((c) => c.span.id), ["s1", "s4"]);
  assert.deepStrictEqual(roots[0].children[0].children.map((c) => c.span.id), ["s2", "s3"]);
  assert.deepStrictEqual(roots[0].children[0].children[1].children.map((c) => c.span.id), ["s3a"]);

  const orphaned = [...nested, mkSpan({ id: "sX", parentId: "does_not_exist", role: "tool", startedAt: 5, endedAt: 6 })];
  const orphanRoots = spanTree(orphaned).map((r) => r.span.id);
  assert.deepStrictEqual(orphanRoots, ["s0", "sX"]);
});

test("totals roll up through a nested tree, and a sibling's cost does not leak into it", () => {
  const [root] = rollUp(nested);

  assert.equal(root.subtotal.costUsd, 0.036);
  assert.equal(root.subtotal.tokensIn, 355);
  assert.equal(root.subtotal.tokensOut, 120);
  assert.equal(root.subtotal.steps, 2);
  assert.equal(root.subtotal.llmCalls, 2);
  assert.equal(root.subtotal.repairCalls, 1);
  assert.equal(root.subtotal.toolCalls, 3);
  assert.equal(root.subtotal.toolErrors, 1);

  // Three levels down is genuinely included, not just the direct children.
  const step1 = root.children[0];
  assert.equal(step1.span.id, "s1");
  assert.equal(step1.subtotal.costUsd, 0.011);
  assert.equal(step1.subtotal.toolCalls, 2);

  // NEGATIVE CONTROL: step 1 must not inherit step 2's spend or its failure.
  assert.notEqual(step1.subtotal.costUsd, root.subtotal.costUsd);
  assert.equal(step1.subtotal.tokensIn, 105);
  assert.equal(step1.subtotal.toolErrors, 0);
  assert.equal(step1.subtotal.repairCalls, 0);
});

test("spanTotals reports wall time, not the sum of overlapping spans", () => {
  const t = spanTotals(nested);
  assert.equal(t.ms, 1000);

  // NEGATIVE CONTROL: summing every span's duration double-counts the nested
  // ones and must come out strictly larger than the wall clock. Asserting the
  // property rather than pinning the sum — the exact figure is a fact about
  // this fixture, not about the code.
  const naiveSum = nested.reduce((a, s) => a + ((s.endedAt ?? s.startedAt) - s.startedAt), 0);
  assert.ok(naiveSum > t.ms, `a naive sum (${naiveSum}) must exceed wall time (${t.ms})`);

  assert.equal(t.costUsd, 0.036);
  assert.equal(spanTotals([]).ms, 0);
  assert.equal(spanTotals([]).costUsd, 0);
});

test("maxDepth counts nesting levels", () => {
  assert.equal(maxDepth(nested), 4);
  assert.equal(maxDepth([mkSpan({ id: "a", role: "run" })]), 1);
  assert.equal(maxDepth([]), 0);
});

test("capSpans keeps the head and the tail and reports what went", () => {
  const many = Array.from({ length: 20 }, (_, i) => mkSpan({ id: `n${i}`, role: "tool" }));
  const { spans, dropped } = capSpans(many, 6);
  assert.equal(dropped, 14);
  assert.deepStrictEqual(spans.map((s) => s.id), ["n0", "n1", "n2", "n17", "n18", "n19"]);
  // NEGATIVE CONTROL: under the limit, nothing is touched.
  assert.deepStrictEqual(capSpans(many, 50), { spans: many, dropped: 0 });
});

/* ── heuristics: one positive and one negative control each ──────────────── */

function codes(flags) {
  return flags.map((f) => f.code);
}

test("a healthy trace raises no flags at all", () => {
  const { spans, steps } = healthy();
  assert.deepStrictEqual(codes(checkTrace(spans, steps)), []);
});

test("circular fires on a repeated step and stays quiet on distinct ones", () => {
  const { spans } = healthy();
  const repeated = "Look up annual recurring revenue for the first quarter of the year.";
  const steps = [
    mkStep({ index: 1, thought: repeated, action: act('kpi[{"metric":"arr"}]'), observation: "arr = 1", outcome: "acted" }),
    mkStep({ index: 2, thought: repeated, action: act('kpi[{"metric":"arr"}]'), observation: "arr = 1", outcome: "finished" }),
  ];
  const flags = checkTrace(spans, steps);
  assert.ok(codes(flags).includes("circular"));
  const circular = flags.find((f) => f.code === "circular");
  assert.match(circular.detail, /steps 1 and 2 are 100% similar/);
  assert.ok(circular.spanIds.length > 0, "a flag must name its evidence");

  // NEGATIVE CONTROL
  assert.ok(!codes(checkTrace(spans, healthy().steps)).includes("circular"));
});

test("circular still catches SHORT repeated steps (the floor is on text length, not shingle count)", () => {
  const { spans } = healthy();
  // "retry" normalises to 5 characters: too short for meaningful 5-gram
  // Jaccard, which is exactly the case a shingle-count floor would drop.
  const short = [
    mkStep({ index: 1, thought: "retry", action: null, observation: "x", outcome: "acted" }),
    mkStep({ index: 2, thought: "retry", action: null, observation: "y", outcome: "finished" }),
  ];
  assert.ok(codes(checkTrace(spans, short)).includes("circular"));

  // NEGATIVE CONTROL: short but different.
  const differ = [
    mkStep({ index: 1, thought: "retry", action: null, observation: "x", outcome: "acted" }),
    mkStep({ index: 2, thought: "stop", action: null, observation: "y", outcome: "finished" }),
  ];
  assert.ok(!codes(checkTrace(spans, differ)).includes("circular"));
});

test("empty_step fires on a blank step and on a blank observation", () => {
  const { spans } = healthy();
  const blank = [mkStep({ index: 1, thought: "   ", action: null, observation: "nothing", outcome: "parse_error" })];
  assert.ok(codes(checkTrace(spans, blank)).includes("empty_step"));

  const blankObs = [mkStep({ index: 1, thought: "Call the tool and read the number back.", action: act("kpi[{}]"), observation: "", outcome: "acted" })];
  assert.ok(codes(checkTrace(spans, blankObs)).includes("empty_step"));

  // NEGATIVE CONTROL: a step with no action but a real thought is fine.
  const thinking = [mkStep({ index: 1, thought: "I should check the fixture before I guess.", action: null, observation: "", outcome: "thought" })];
  assert.ok(!codes(checkTrace(spans, thinking)).includes("empty_step"));
});

test("all_tool_no_answer fires when tools ran and nothing finished", () => {
  const { spans, steps } = healthy();
  const unfinished = steps.map((s) => ({ ...s, outcome: "acted" }));
  assert.ok(codes(checkTrace(spans, unfinished)).includes("all_tool_no_answer"));

  // NEGATIVE CONTROL: the same spans, with a finishing step.
  assert.ok(!codes(checkTrace(spans, steps)).includes("all_tool_no_answer"));
  // NEGATIVE CONTROL: no tools ran at all, so there is nothing to have wasted.
  const noTools = spans.filter((s) => s.role !== "tool");
  assert.ok(!codes(checkTrace(noTools, unfinished)).includes("all_tool_no_answer"));
});

test("error_cascade fires at three failed tool spans and not at two", () => {
  const { spans, steps } = healthy();
  const fail = (id) => mkSpan({ id, parentId: "s4", role: "tool", kind: "tool", name: "sql", startedAt: 800, endedAt: 810, error: "timeout" });

  const two = [...spans, fail("e1"), fail("e2")];
  assert.ok(!codes(checkTrace(two, steps)).includes("error_cascade"), "two failures is not a cascade");

  const three = [...two, fail("e3")];
  const flags = checkTrace(three, steps);
  assert.ok(codes(flags).includes("error_cascade"));
  assert.equal(flags.find((f) => f.code === "error_cascade").spanIds.length, 3);
});

test("runaway_depth fires above eight levels and not at eight", () => {
  const chain = (n) => Array.from({ length: n }, (_, i) =>
    mkSpan({ id: `d${i}`, parentId: i === 0 ? null : `d${i - 1}`, role: "tool", kind: "tool", startedAt: 0, endedAt: 1 }));

  assert.equal(maxDepth(chain(8)), 8);
  assert.ok(!codes(checkTrace(chain(8), [])).includes("runaway_depth"));
  assert.ok(codes(checkTrace(chain(9), [])).includes("runaway_depth"));
});

test("cost_spike needs BOTH the 4x ratio and the absolute floor", () => {
  const { steps } = healthy();
  const cheap = (id, cost) => mkSpan({ id, role: "llm", kind: "model", startedAt: 0, endedAt: 1, costUsd: cost });

  // Positive: 0.001, 0.001, 0.001, 0.050 -> mean 0.01325, 4x = 0.053... not enough.
  const spiky = [cheap("a", 0.001), cheap("b", 0.001), cheap("c", 0.001), cheap("d", 0.200)];
  assert.ok(codes(checkTrace(spiky, steps)).includes("cost_spike"));

  // NEGATIVE CONTROL 1: uniform spend, no spike however expensive.
  const uniform = [cheap("a", 0.05), cheap("b", 0.05), cheap("c", 0.05), cheap("d", 0.05)];
  assert.ok(!codes(checkTrace(uniform, steps)).includes("cost_spike"));

  // NEGATIVE CONTROL 2: a 100x ratio that is still under a cent is noise.
  const tiny = [cheap("a", 0.00001), cheap("b", 0.00001), cheap("c", 0.00001), cheap("d", 0.001)];
  assert.ok(!codes(checkTrace(tiny, steps)).includes("cost_spike"));

  // NEGATIVE CONTROL 3: a single costed span is its own mean.
  assert.ok(!codes(checkTrace([cheap("a", 5)], steps)).includes("cost_spike"));
});

test("stalled fires on an open span older than the step timeout", () => {
  const open = mkSpan({ id: "o1", role: "tool", kind: "tool", name: "sql", startedAt: 0 });
  const closed = mkSpan({ id: "c1", role: "tool", kind: "tool", startedAt: 0, endedAt: 90_000 });
  const flags = checkTrace([open, closed], [], { stepTimeoutMs: 60_000 });
  assert.ok(codes(flags).includes("stalled"));
  assert.deepStrictEqual(flags.find((f) => f.code === "stalled").spanIds, ["o1"]);

  // NEGATIVE CONTROL: open, but not yet late.
  const fresh = mkSpan({ id: "c2", role: "tool", kind: "tool", startedAt: 0, endedAt: 5_000 });
  assert.ok(!codes(checkTrace([open, fresh], [], { stepTimeoutMs: 60_000 })).includes("stalled"));
});

test("context_drop fires only when the context layer actually withheld something", () => {
  const { spans, steps } = healthy();
  const dropped = spans.map((s) => (s.role === "context" ? { ...s, attrs: { withheld: 3 } } : s));
  const flags = checkTrace(dropped, steps);
  assert.ok(codes(flags).includes("context_drop"));
  assert.match(flags.find((f) => f.code === "context_drop").detail, /withheld 3 fact/);

  // NEGATIVE CONTROL: withheld 0 is the healthy fixture, already asserted silent.
  assert.ok(!codes(checkTrace(spans, steps)).includes("context_drop"));
});

/* ── redaction ───────────────────────────────────────────────────────────── */

test("redact catches key shapes and leaves ordinary prose byte-identical", () => {
  const anthropic = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const openrouter = "sk-or-v1-0123456789abcdef0123456789abcdef";
  const google = "AIzaSyA0123456789abcdefghijklmnopqrstuvw";
  const aws = "AKIAIOSFODNN7EXAMPLE";
  const github = "ghp_0123456789abcdefghijklmnopqrstuvwx";

  for (const key of [anthropic, openrouter, google, aws, github]) {
    const out = redact(`the call failed with key ${key} attached`);
    assert.ok(!out.includes(key), `${key} survived redaction`);
    assert.ok(out.includes(REDACTED));
  }

  assert.equal(redact("authorization: Bearer abcdefghijklmnopqrstuvwxyz"), `authorization: ${REDACTED}`);
  assert.equal(redact('{"api_key":"0f9a8b7c6d5e4f3a2b1c"}'), `{"api_key":"${REDACTED}"}`);

  // NEGATIVE CONTROL: the check must still be able to say no.
  const prose = "The agent read the quarterly report and returned a summary. Cost was 12 dollars.";
  assert.equal(redact(prose), prose);
  const nearMiss = 'task-1234 finished; sk- is not a key and {"status":"ok"} is not a secret.';
  assert.equal(redact(nearMiss), nearMiss);
});

test("an explicit secret is redacted, but a too-short one is refused rather than shredding the trace", () => {
  assert.equal(redact("the password is hunter2000 today", ["hunter2000"]), `the password is ${REDACTED} today`);

  // NEGATIVE CONTROL: a 2-character "secret" would blank half the alphabet.
  const text = "an abstract analysis of an abacus";
  assert.equal(redact(text, ["ab"]), text);
  assert.equal(redact(text, [""]), text);
});

test("redaction happens BEFORE truncation, so a key cannot survive as a fragment", () => {
  const span = startSpan({ id: "s", parentId: null, name: "llm", kind: "model", role: "llm", runId: "r", at: 0 });
  const straddling = "x".repeat(TRACE_LIMITS.text - 10) + "sk-ant-api03-" + "B".repeat(40);
  const ended = endSpan(span, { at: 1, text: straddling });

  assert.ok(!ended.text.includes("sk-ant-api"), "a truncation-first implementation leaves this fragment");
  assert.equal(ended.text, "x".repeat(TRACE_LIMITS.text - 10) + REDACTED);
});

test("endSpan truncates text, input and error at write time and says how much it cut", () => {
  const span = startSpan({ id: "s", parentId: null, name: "llm", kind: "model", role: "llm", runId: "r", at: 0, input: "i".repeat(TRACE_LIMITS.input + 500) });
  assert.equal(span.input.length, TRACE_LIMITS.input + `... [+500 chars truncated]`.length);
  assert.match(span.input, /\[\+500 chars truncated\]$/);

  const ended = endSpan(span, { at: 5, text: "t".repeat(TRACE_LIMITS.text + 1), error: "e".repeat(TRACE_LIMITS.error + 7) });
  assert.match(ended.text, /\[\+1 chars truncated\]$/);
  assert.match(ended.error, /\[\+7 chars truncated\]$/);
  assert.equal(ended.endedAt, 5);

  // NEGATIVE CONTROL: short content is untouched, and the original is unmutated.
  const short = endSpan(startSpan({ id: "t", parentId: null, name: "n", kind: "tool", role: "tool", runId: "r", at: 0 }), { at: 1, text: "ok" });
  assert.equal(short.text, "ok");
  assert.equal(span.endedAt, undefined, "endSpan must not mutate the span a viewer is holding");
});

/* ── receipts ────────────────────────────────────────────────────────────── */

function mkRun(overrides = {}) {
  const { spans, steps } = healthy();
  return {
    runId: "run_1", configId: "default", agentId: null,
    objective: "Report ARR for 2026Q1",
    trigger: { triggerId: "trg_1", kind: "manual", at: 0, payload: null, dedupeKey: "k" },
    status: "finished",
    answer: "ARR is 4210000",
    steps, transcript: "…", spans,
    verdict: null, flags: [],
    totals: spanTotals(spans),
    startedAt: 0, endedAt: 1000, fingerprint: "fp_abc",
    ...overrides,
  };
}

test("traceToMarkdown states the outcome, the totals and the span tree, and carries no key", () => {
  const key = "sk-ant-api03-SECRETSECRETSECRETSECRET";
  const run = mkRun({ answer: `ARR is 4210000 (fetched with ${key})` });
  const md = traceToMarkdown(run);

  assert.ok(md.startsWith("# Run run_1"));
  assert.ok(md.includes("Report ARR for 2026Q1"));
  assert.ok(md.includes("| cost | $0.0220 |"));
  assert.ok(md.includes("| tokens in | 300 |"));
  assert.ok(md.includes("- run s0 [1000ms $0.0220 300/110tok]"));
  assert.ok(md.includes("  - llm s2 [190ms $0.0100 100/50tok]"));
  assert.ok(md.includes("### Step 2 - finished"));
  assert.ok(!md.includes(key));
  assert.ok(md.includes(REDACTED));
  assert.ok(md.includes("## Flags\n\nNone."));
});

test("traceToMarkdown says so plainly when there was no answer, rather than printing a placeholder", () => {
  const md = traceToMarkdown(mkRun({ answer: "", status: "cap_exhausted" }));
  assert.ok(md.includes("_No answer was produced._"));
  assert.ok(md.includes("Status: cap_exhausted"));
});

test("traceToJson round-trips and redacts every nested string", () => {
  const key = "sk-or-v1-0123456789abcdef0123456789abcdef";
  const run = mkRun({ objective: `use ${key}`, transcript: `Observation: ${key}` });
  const json = traceToJson(run);
  assert.ok(!json.includes(key));

  const parsed = JSON.parse(json);
  assert.equal(parsed.runId, "run_1");
  assert.equal(parsed.objective, `use ${REDACTED}`);
  assert.equal(parsed.transcript, `Observation: ${REDACTED}`);
  assert.equal(parsed.spansDropped, 0);
  assert.equal(parsed.spans.length, 7);
  // NEGATIVE CONTROL: numbers are not mangled by the string pass.
  assert.equal(parsed.totals.tokensIn, 300);
});
