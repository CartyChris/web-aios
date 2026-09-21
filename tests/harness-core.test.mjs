/**
 * The harness core: parser, loop, tools, context, resilience, evals.
 *
 * The emphasis is on the paths a reimplementation skips — a malformed action,
 * a hallucinated verb, a tool that errors, a loop that repeats itself, a run
 * that hits its cap. Those decide whether a harness is honest about what
 * happened or quietly reports success it did not achieve.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseAction, splitThoughtAction, buildToolBlock, renderTranscript, stopSequences } from "../.test-build/harness/protocol.js";
import { runReAct, detectLoop, jaccard, shingles, canonicalArgs } from "../.test-build/harness/loop.js";
import { createRegistry, builtinTools, runTool, validateArgs } from "../.test-build/harness/tools.js";
import { FIXTURES } from "../.test-build/harness/fixtures.js";
import { assembleContext, createFactStore } from "../.test-build/harness/context.js";
import { classifyError, backoffDelay, parseRetryAfter, createBreaker, repairJson } from "../.test-build/harness/resilience.js";
import { validateTask, fingerprint, taskFromFailure } from "../.test-build/harness/evals.js";
import { DEFAULT_LOOP_CONFIG, DOD_EXPLORATORY, mergeConfig } from "../.test-build/harness/config.js";

const CLOCK = 1_700_000_000_000;
const written = [];
const TOOL_LIST = builtinTools({
  fixtures: FIXTURES,
  writeArtifact: async (path, content) => { written.push({ path, content }); return { ok: true, path }; },
});
const TOOLS = createRegistry();
for (const t of TOOL_LIST) TOOLS.register(t);

/** Drive the loop with a scripted model so every branch is reachable offline. */
const deps = (replies, over = {}) => {
  let i = 0, uidN = 0;
  return {
    llm: async () => {
      const text = replies[Math.min(i, replies.length - 1)];
      i++;
      return { text, tokensIn: 10, tokensOut: 5, costUsd: 0.001, ms: 5, provider: "test", model: "test", spanId: `s${i}` };
    },
    tools: TOOLS,
    facts: createFactStore([]),
    span: () => {},
    now: () => CLOCK,
    uid: (p) => `${p}_${uidN++}`,
    signal: new AbortController().signal,
    spend: () => 0,
    approve: async () => "tester",
    fingerprint: "test",
    ...over,
  };
};
/** A fresh dedupe key per run. The harness refuses a repeat of the same key
 *  inside config.dedupeMs — correct behaviour, and it silently aborts every
 *  test after the first if they all share one. */
let triggerN = 0;
const trigger = { id: "t1", kind: "manual", source: "test", at: CLOCK, dedupeKey: "k", payload: {} };
const freshTrigger = () => ({ ...trigger, id: `t${++triggerN}`, dedupeKey: `k${triggerN}` });
const dodContains = (value) => ({
  id: "d1", label: "test", owner: "tester", passThreshold: 1,
  criteria: [{ id: "c1", label: "says it", expectation: `answer contains "${value}"`, check: { kind: "contains", value }, by: "fixed", weight: 1, required: true }],
});
const run = (replies, over = {}, dod = dodContains("done")) =>
  runReAct("test objective", mergeConfig(DEFAULT_LOOP_CONFIG, over.config ?? {}), dod, freshTrigger(), deps(replies, over));

/* ── Action parsing ────────────────────────────────────────────────────── */

test("an action's argument may contain brackets — the LAST ] closes it", () => {
  // indexOf("]") is the classic bug: every JSON argument contains one.
  const r = parseAction('calc[{"expression":"max([1,2])"}]', TOOL_LIST);
  assert.equal(r.ok, true);
  assert.equal(r.action.verb, "calc");
  assert.equal(r.action.args.expression, "max([1,2])");
});

test("a bare argument fills the tool's single required string field", () => {
  const r = parseAction("search_docs[pricing policy]", TOOL_LIST);
  assert.equal(r.action.args.query, "pricing policy");
});

test("verb case is normalised, because prompts show Search[ and tools are lowercase", () => {
  assert.equal(parseAction("Calc[1+1]", TOOL_LIST).action.verb, "calc");
});

test("a hallucinated verb is refused with the list of real ones, not a crash", () => {
  const r = parseAction("teleport[mars]", TOOL_LIST);
  assert.equal(r.ok, false);
  assert.match(r.reason, /unknown verb/i);
  assert.match(r.reason, /calc/, "it must name what IS available so the model can recover");
});

test("an action with no brackets is refused and says why", () => {
  assert.match(parseAction("I will now search the documents", TOOL_LIST).reason, /bracket/i);
});

test("splitThoughtAction separates the lines, and reports when it cannot", () => {
  const ok = splitThoughtAction("Thought 1: I should look it up.\nAction 1: search_docs[pricing]", 1);
  assert.equal(ok.ok, true);
  assert.match(ok.action, /search_docs/);

  // NEGATIVE CONTROL: prose with no Action line must not yield a phantom action.
  const bad = splitThoughtAction("Thought 1: I think the answer is probably four.", 1);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /Action 1/);
});

test("the stop sequence is the next Observation label, so the model cannot write its own", () => {
  assert.ok(stopSequences(3).some((s) => s.includes("Observation 3")));
});

test("the tool block lists every registered tool", () => {
  const block = buildToolBlock(TOOL_LIST);
  for (const t of ["kpi", "calc", "search_docs", "read_doc", "lookup", "policy_check"]) {
    assert.ok(block.includes(t), `${t} missing from the tool block`);
  }
});

test("a rendered transcript keeps order and never invents an observation", () => {
  const out = renderTranscript([{ index: 1, thought: "Thought 1: T", action: { verb: "calc", raw: "calc[1+1]", args: {} }, observation: "= 2", outcome: "acted", spans: [], costUsd: 0, ms: 1 }]);
  assert.match(out, /Action 1:/);
  assert.match(out, /Observation 1: = 2/);
});

/* ── Loop detection ────────────────────────────────────────────────────── */

test("jaccard is 1 for identical text and 0 for disjoint text", () => {
  assert.equal(jaccard(shingles("the quick brown fox jumps over"), shingles("the quick brown fox jumps over")), 1);
  assert.equal(jaccard(shingles("alpha beta gamma delta epsilon"), shingles("zulu yankee xray whiskey victor")), 0);
});

test("detectLoop fires on repetition and stays silent on progress", () => {
  let n = 0;
  const step = (raw) => ({
    index: ++n,
    thought: `Thought ${n}: I should look up the ${raw} information in the documents so I can answer this properly, because the objective needs the exact figure and I have not yet found a passage that states it directly anywhere.`,
    action: { verb: "search_docs", raw, args: { query: raw } },
    observation: `Results for ${raw} with several matching passages listed in order of score.`,
    outcome: "acted", spans: [], costUsd: 0, ms: 1,
  });
  const repeating = [step("search_docs[pricing policy]"), step("search_docs[pricing policy]"), step("search_docs[pricing policy]")];
  n = 0;
  assert.ok(detectLoop(repeating, 0.62, 3), "three identical actions must be detected");

  // NEGATIVE CONTROL: a detector that fires on healthy progress is useless.
  const progressing = [step("search_docs[pricing tiers]"), step("read_doc[doc_security]"), step("lookup[retention window]")];
  assert.equal(detectLoop(progressing, 0.62, 3), null);
});

test("canonicalArgs is order-independent, so the tool cache keys on meaning", () => {
  assert.equal(canonicalArgs({ b: 2, a: 1 }), canonicalArgs({ a: 1, b: 2 }));
});

/* ── The loop's stop conditions ────────────────────────────────────────── */

test("a run that finishes returns the answer and passes a DoD it satisfies", async () => {
  const r = await run(["Thought 1: Simple.\nAction 1: finish[all done]"]);
  assert.equal(r.status, "finished");
  assert.equal(r.answer, "all done");
  assert.equal(r.verdict.pass, true);
});

test("a run that exhausts its cap answers EMPTY and therefore FAILS its DoD", async () => {
  // The point: no fabricated best-guess at the cap. An empty answer fails the
  // DoD, which is the truth about what happened.
  const r = await run(["Thought 1: Thinking.\nAction 1: think[still working]"], { config: { maxSteps: 3 } });
  assert.equal(r.status, "cap_exhausted");
  assert.equal(r.answer, "");
  assert.equal(r.verdict.pass, false);
  assert.ok(r.flags.some((f) => f.code === "cap_exhausted"));
});

test("a run stops on budget before dispatching, not by throwing mid-step", async () => {
  const r = await run(["Thought 1: x\nAction 1: think[x]"], { spend: () => 99 });
  assert.equal(r.status, "budget_stopped");
});

test("an aborted signal ends the run as aborted, not as a failure", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  assert.equal((await run(["Thought 1: x\nAction 1: think[x]"], { signal: ctrl.signal })).status, "aborted");
});

test("a bad argument does NOT count as a tool error — it is our parse, not the tool's fault", async () => {
  // The distinction matters: cascading on argument mistakes would abandon a run
  // that is recovering perfectly well from its own typos.
  const r = await run(["Thought 1: go\nAction 1: read_doc[no_such_doc]"], { config: { maxSteps: 4, maxToolErrors: 2 } });
  assert.equal(r.status, "cap_exhausted");
  assert.ok(r.steps.length > 2, "an argument mistake must not end the run early");
});

test("a hallucinated verb is fed back and the run RECOVERS on the next step", async () => {
  const r = await run([
    "Thought 1: I will teleport.\nAction 1: teleport[mars]",
    "Thought 2: Not a tool. Answer directly.\nAction 2: finish[done]",
  ]);
  assert.equal(r.status, "finished");
  assert.equal(r.steps[0].outcome, "invalid_action");
  assert.match(r.steps[0].observation, /Invalid action|unknown verb/i);
});

test("an unparseable reply is repaired by a second call, counted separately", async () => {
  const r = await run([
    "Thought 1: I will describe my plan at length with no action line.",
    "finish[done]",
  ], { config: { maxRepairsPerRun: 2 } });
  assert.ok(r.totals.repairCalls >= 1, "repair must be counted, not folded into the first call");
});

test("with no repair budget an unparseable reply becomes a parse_error observation", async () => {
  const r = await run(["Thought 1: rambling with no action line at all"], { config: { maxRepairsPerRun: 0, maxSteps: 2 } });
  assert.equal(r.steps[0].outcome, "parse_error");
});

test("a denied approval is recorded and the run continues rather than dying", async () => {
  const r = await run([
    'Thought 1: Write it.\nAction 1: write_artifact[{"name":"x.md","content":"hi"}]',
    "Thought 2: Denied. Answer instead.\nAction 2: finish[done]",
  ], { approve: async () => null, config: { approvals: "always" } });
  assert.equal(r.steps[0].outcome, "denied");
  assert.equal(r.status, "finished");
});

test("a run refuses to start without a definition of done that can fail", async () => {
  const vacuous = { id: "v", label: "none", owner: "x", passThreshold: 1, criteria: [] };
  const r = await run(["Thought 1: x\nAction 1: finish[done]"], {}, vacuous);
  assert.equal(r.status, "failed");
  assert.ok(r.flags.length > 0, "it must say why it refused");
});

/* ── Deterministic tools ───────────────────────────────────────────────── */

const ctx = () => ({
  runId: "r1", stepIndex: 1, signal: new AbortController().signal,
  facts: createFactStore([]), span: () => {}, parentSpanId: "p1",
  now: () => CLOCK, cache: new Map(),
});
const call = (name, args) => runTool(TOOLS.get(name), args, ctx());

test("every deterministic tool returns a byte-identical observation for the same args", async () => {
  for (const [name, args] of [
    ["calc", { expression: "(2+3)*4" }],
    ["table_query", { table: "revenue", agg: "sum", aggField: "mrr" }],
    ["policy_check", { action: "export customer data", region: "eu" }],
    ["date_math", { from: "2026-04-15", addDays: 45 }],
    ["search_docs", { query: "pricing" }],
  ]) {
    const a = await call(name, args);
    const b = await call(name, args);
    assert.equal(a.observation, b.observation, `${name} is not deterministic`);
    assert.equal(a.status, "ok", `${name} failed: ${a.observation}`);
  }
});

test("calc computes correctly and refuses code rather than evaluating it", async () => {
  assert.match((await call("calc", { expression: "(2+3)*4" })).observation, /20/);
  // NEGATIVE CONTROL: the whole reason this is a parser and not eval().
  assert.notEqual((await call("calc", { expression: "process.exit(1)" })).status, "ok");
});

test("write_artifact refuses a path that escapes the run's own directory", async () => {
  const bad = await call("write_artifact", { name: "../../etc/passwd", content: "x" });
  assert.notEqual(bad.status, "ok", "a model-supplied traversal must not be honoured");
});

test("read_doc on a miss names a way forward instead of failing blankly", async () => {
  const r = await call("read_doc", { id: "doc_does_not_exist" });
  assert.notEqual(r.status, "ok");
  assert.ok(r.observation.length > 20);
});

test("a tool called with the wrong argument shape says which field is wrong", () => {
  const bad = validateArgs(TOOLS.get("kpi").inputSchema, { metric: "not_a_metric" });
  assert.equal(bad.ok, false);
});

/* ── Context ───────────────────────────────────────────────────────────── */

const fact = (id, text, volatile) => ({ id, source: `/facts/${id}`, sourceKind: "vfs", text, weight: 1, updatedAt: CLOCK, volatile, tags: [] });

test("the stable context prefix does not move when volatile content changes", () => {
  const base = [fact("policy", "Personal data may not leave the EU region.", false)];
  const a = assembleContext(base, { maxChars: 4000, query: "one" });
  const b = assembleContext([...base, fact("now", "The clock now reads 12:01.", true)], { maxChars: 4000, query: "two" });
  // A prefix that shifts destroys prompt caching and quietly multiplies cost.
  assert.equal(a.stable, b.stable);
});

test("anything dropped from context is accounted for in the withheld ledger", () => {
  const many = Array.from({ length: 40 }, (_, i) => fact(`f${i}`, `fact ${i} ${"x".repeat(400)}`, true));
  const c = assembleContext(many, { maxChars: 1200, query: "anything" });
  assert.ok(c.withheld.length > 0, "something must have been dropped at this budget");
  for (const w of c.withheld) assert.ok(w.reason && w.id, "every drop needs an id and a reason");
});

/* ── Resilience ────────────────────────────────────────────────────────── */

test("a rate limit is retryable and a bad request is not", () => {
  assert.equal(classifyError("Too Many Requests", 429).retryable, true);
  // NEGATIVE CONTROL: retrying a 400 just spends money to fail identically.
  assert.equal(classifyError("Bad Request", 400).retryable, false);
});

test("backoff grows with the attempt and stays bounded", () => {
  const rand = () => 1;
  assert.ok(backoffDelay(4, 1000, 60_000, 0, rand) >= backoffDelay(1, 1000, 60_000, 0, rand));
  assert.ok(backoffDelay(20, 1000, 60_000, 0, rand) <= 60_000);
});

test("Retry-After is honoured, and its absence is not treated as a delay", () => {
  assert.equal(parseRetryAfter("2", CLOCK), 2000);
  assert.equal(parseRetryAfter(null, CLOCK), 0);
});

test("the breaker opens on repeated failure and a success clears it", () => {
  const mk = () => createBreaker({ threshold: 3, cooldownMs: 10_000, now: () => CLOCK });
  const b = mk();
  b.onFailure(); b.onFailure(); b.onFailure();
  assert.notEqual(b.state(), "closed");
  // NEGATIVE CONTROL: a breaker that never recovers is a kill switch.
  const c = mk();
  c.onFailure(); c.onSuccess(); c.onFailure(); c.onFailure();
  assert.equal(c.state(), "closed");
});

test("repairJson climbs its ladder, and refuses to invent a value", () => {
  assert.deepEqual(repairJson('{"a": 1,}').value, { a: 1 });
  assert.deepEqual(repairJson('```json\n{"a":1}\n```').value, { a: 1 });
  // NEGATIVE CONTROL: a repairer that always returns something invents data.
  assert.equal(repairJson("this is not json at all").ok, false);
});

/* ── Evals ─────────────────────────────────────────────────────────────── */

test("a task with no way to fail is rejected — a check that cannot fail is decoration", () => {
  assert.equal(validateTask({ id: "t", label: "t", objective: "o", dod: { id: "d", label: "d", owner: "o", passThreshold: 1, criteria: [] }, tags: [] }).ok, false);
});

test("a fingerprint is stable for the same inputs and moves when one changes", () => {
  const base = { toolSignature: "a", promptFingerprint: "b", fixtureVersion: "v1", configDigest: "c" };
  assert.equal(fingerprint(base), fingerprint({ ...base }));
  assert.notEqual(fingerprint(base), fingerprint({ ...base, fixtureVersion: "v2" }));
});

test("a production failure becomes a valid golden task, and an unsigned correction is refused", () => {
  const failed = {
    runId: "r9", objective: "compute Q1 ARR", answer: "about four million", status: "finished",
    steps: [{ index: 1, thought: "Thought 1: guessing", action: { verb: "finish", raw: "finish[about four million]", args: {} }, observation: "", outcome: "finished", spans: [], costUsd: 0.02, ms: 900 }],
    spans: [], flags: [],
    totals: { steps: 3, costUsd: 0.02, ms: 900, llmCalls: 1, toolCalls: 1, repairCalls: 0, toolErrors: 0, tokensIn: 10, tokensOut: 5 },
    verdict: { pass: false, score: 0, outcomes: [], pendingHuman: false },
    startedAt: 0, endedAt: 1, trigger, config: DEFAULT_LOOP_CONFIG, dod: DOD_EXPLORATORY,
  };
  const correction = { runId: "r9", wrongStepIndex: 1, whatWasWrong: "guessed the figure", expected: "the answer cites the kpi tool", correctedBy: "chris", at: CLOCK };
  const task = taskFromFailure(failed, correction, dodContains("kpi"));
  assert.ok(task.objective.includes("Q1 ARR"));
  assert.equal(validateTask(task).ok, true, "a task made from a failure must itself be valid");

  // NEGATIVE CONTROL: an unsigned correction is an opinion, not a decision.
  assert.throws(() => taskFromFailure(failed, { ...correction, correctedBy: "" }, dodContains("kpi")));
});

test("mergeConfig refuses to let the judge share the worker's model", () => {
  const c = mergeConfig(DEFAULT_LOOP_CONFIG, { judge: { ...DEFAULT_LOOP_CONFIG.llm } });
  assert.notEqual(c.judge.model, c.llm.model);
});

/* ── context folding inside the loop ─────────────────────────────────────── */

test("a long run folds its transcript in the PROMPT but not in the receipt", async () => {
  // Every step calls the same tool and fails the same way, which is exactly the
  // shape folding exists for: forty near-identical lines become one counted one.
  const prompts = [];
  const replies = Array.from({ length: 14 }, (_, n) => `Thought ${n + 1}: trying again\nAction ${n + 1}: nosuchtool {}`);
  const r = await runReAct(
    "test objective",
    mergeConfig(DEFAULT_LOOP_CONFIG, { maxSteps: 12, maxToolErrors: 99, foldAfterSteps: 4, foldKeepRecent: 2 }),
    dodContains("done"),
    freshTrigger(),
    deps(replies, {
      llm: async (req) => {
        prompts.push(req.prompt);
        const text = replies[Math.min(prompts.length - 1, replies.length - 1)];
        return { text, tokensIn: 10, tokensOut: 5, costUsd: 0.001, ms: 5, provider: "test", model: "test", spanId: `s${prompts.length}` };
      },
    }),
  );

  const last = prompts[prompts.length - 1];
  assert.match(last, /# Earlier steps, folded/, "a long prompt must carry the ledger");
  assert.match(last, /Full detail: \/harness\/runs\//, "and point at the full trace by path");

  // The receipt keeps everything, which is the whole point of separating them.
  assert.ok(!r.transcript.includes("# Earlier steps, folded"), "the receipt is never folded");
  const thoughts = r.transcript.match(/^Thought \d+:/gm) ?? [];
  assert.ok(thoughts.length > 4, `receipt kept ${thoughts.length} steps verbatim`);
});

test("a short run is not folded at all", async () => {
  const prompts = [];
  const r = await runReAct(
    "test objective",
    mergeConfig(DEFAULT_LOOP_CONFIG, { maxSteps: 3, foldAfterSteps: 8 }),
    dodContains("done"),
    freshTrigger(),
    deps([], {
      llm: async (req) => {
        prompts.push(req.prompt);
        return { text: `Thought 1: ok\nAction 1: nosuchtool {}`, tokensIn: 1, tokensOut: 1, costUsd: 0, ms: 1, provider: "t", model: "t", spanId: "s" };
      },
    }),
  );
  assert.ok(prompts.length > 0, "the model was actually called");
  assert.ok(prompts.every((p) => !p.includes("# Earlier steps, folded")), "nothing to fold under the threshold");
  assert.ok(!r.transcript.includes("# Earlier steps, folded"));
});
