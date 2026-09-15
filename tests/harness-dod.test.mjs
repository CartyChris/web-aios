/**
 * The definition of done, and the two ways it fails silently.
 *
 * A DoD that cannot fail passes every positive test ever written for it, so
 * every check here is paired with a negative control proving the check can
 * still say no: a vacuous criterion is rejected AND the same criterion with a
 * real value is accepted; a failing run is named AND a passing one is not.
 *
 * The second silent failure is a run claiming "pass" while a person's sign-off
 * is still outstanding. The agent advises; a named person decides. An unsigned
 * human criterion must block the pass, an unnamed signer must be refused, and
 * both have tests below.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dodValidate, evaluateFixedCriteria, evaluateDod, applyHumanDecision, verdictReason,
} from "../.test-build/harness/dod.js";
import { DOD_EXPLORATORY } from "../.test-build/harness/config.js";

/* ── fixtures ───────────────────────────────────────────────────────────── */

const TOTALS = {
  steps: 0, llmCalls: 0, repairCalls: 0, toolCalls: 0, toolErrors: 0,
  tokensIn: 0, tokensOut: 0, costUsd: 0, ms: 0,
};

function llm(i) {
  return {
    spanId: `span_${i}`, provider: "test", model: "test/model", system: "", prompt: "",
    stop: [], temperature: 0, maxTokens: 400, output: "", tokensIn: 0, tokensOut: 0,
    costUsd: 0, ms: 1, attempt: 1,
  };
}

function call(tool, value, status = "ok") {
  return {
    spanId: `span_t_${tool}`, tool, args: {},
    result: { status, observation: `${tool} ran`, value, ms: 1 }, ms: 1,
  };
}

function step(index, tool) {
  return {
    index, thought: "thinking", action: null, observation: "obs",
    outcome: tool ? "acted" : "thought", llm: llm(index), tool,
    startedAt: 0, ms: 1, costUsd: 0,
  };
}

function run(patch = {}) {
  return {
    runId: "run_1", configId: "default", agentId: null,
    objective: "Report Q1 ARR for enterprise.",
    trigger: { triggerId: "t1", kind: "manual", at: 0, payload: null, dedupeKey: "k" },
    status: "finished", answer: "", steps: [], transcript: "", spans: [],
    verdict: null, flags: [], totals: { ...TOTALS }, startedAt: 1000, endedAt: 2000,
    fingerprint: "fp", ...patch,
  };
}

function crit(id, check, patch = {}) {
  return {
    id, label: id, expectation: "A person can observe this in the answer.",
    check, by: "fixed", weight: 1, required: true, ...patch,
  };
}

function dod(criteria, patch = {}) {
  return { id: "dod_1", label: "Test DoD", criteria, passThreshold: 1, owner: "chris", ...patch };
}

/* ── dodValidate: the vacuous DoD is the whole point ─────────────────────── */

test("a DoD with no criteria is rejected, a DoD with one real criterion is not", () => {
  const empty = dodValidate(dod([]));
  assert.equal(empty.ok, false);
  assert.ok(empty.reasons.some((r) => r.includes("no criteria")), empty.reasons.join(" | "));

  // Negative control: the check can still say yes.
  assert.deepEqual(dodValidate(dod([crit("a", { kind: "contains", value: "4,182,000" })])), { ok: true });
});

test("a DoD where every criterion is advisory is rejected", () => {
  const v = dodValidate(dod([crit("a", { kind: "contains", value: "x" }, { required: false })]));
  assert.equal(v.ok, false);
  assert.ok(v.reasons.some((r) => r.includes("no required criterion")), v.reasons.join(" | "));

  const withRequired = dodValidate(dod([
    crit("a", { kind: "contains", value: "x" }, { required: false }),
    crit("b", { kind: "contains", value: "y" }),
  ]));
  assert.deepEqual(withRequired, { ok: true });
});

test("total weight 0 is rejected: the score would have no denominator", () => {
  const v = dodValidate(dod([crit("a", { kind: "contains", value: "x" }, { weight: 0 })]));
  assert.equal(v.ok, false);
  assert.ok(v.reasons.some((r) => r.includes("total weight 0")), v.reasons.join(" | "));

  assert.deepEqual(
    dodValidate(dod([crit("a", { kind: "contains", value: "x" }, { weight: 0.25 })])),
    { ok: true },
  );
});

test("an expectation under ten characters is rejected", () => {
  const v = dodValidate(dod([crit("a", { kind: "contains", value: "x" }, { expectation: "works" })]));
  assert.equal(v.ok, false);
  assert.ok(v.reasons.some((r) => r.includes("under 10 characters")), v.reasons.join(" | "));

  assert.deepEqual(
    dodValidate(dod([crit("a", { kind: "contains", value: "x" }, { expectation: "The answer quotes the ARR figure." })])),
    { ok: true },
  );
});

test("a DoD nobody owns is rejected", () => {
  const v = dodValidate(dod([crit("a", { kind: "contains", value: "x" })], { owner: "  " }));
  assert.equal(v.ok, false);
  assert.ok(v.reasons.some((r) => r.includes("no owner")), v.reasons.join(" | "));

  assert.deepEqual(
    dodValidate(dod([crit("a", { kind: "contains", value: "x" })], { owner: "chris" })),
    { ok: true },
  );
});

test("criteria that cannot possibly fail are rejected, one reason each", () => {
  const cases = [
    [{ kind: "contains", value: "" }, "matches every answer"],
    [{ kind: "not_contains", value: "" }, "matches every answer"],
    [{ kind: "regex", pattern: ".*" }, "matches every answer"],
    [{ kind: "regex", pattern: "" }, "matches every answer"],
    [{ kind: "number_within", expected: 5, tolerance: Infinity }, "tolerance"],
    [{ kind: "tool_called", tool: "kpi", times: 0 }, "times 0"],
  ];
  for (const [check, needle] of cases) {
    const v = dodValidate(dod([crit("a", check)]));
    assert.equal(v.ok, false, `${JSON.stringify(check)} should be rejected`);
    assert.ok(
      v.reasons.some((r) => r.includes(needle)),
      `${JSON.stringify(check)} -> ${v.reasons.join(" | ")}`,
    );
  }

  // Negative controls: the same shapes with real values are accepted.
  for (const check of [
    { kind: "contains", value: "4,182,000" },
    { kind: "not_contains", value: "approximately" },
    { kind: "regex", pattern: "\\$\\d" },
    { kind: "number_within", expected: 5, tolerance: 0.5 },
    { kind: "tool_called", tool: "kpi", times: 2 },
  ]) {
    assert.deepEqual(dodValidate(dod([crit("a", check)])), { ok: true }, JSON.stringify(check));
  }
});

test("a regex that does not compile, and a fixed criterion no code can run, are rejected", () => {
  const bad = dodValidate(dod([crit("a", { kind: "regex", pattern: "([unclosed" })]));
  assert.equal(bad.ok, false);
  assert.ok(bad.reasons.some((r) => r.includes("does not compile")), bad.reasons.join(" | "));

  const incoherent = dodValidate(dod([
    crit("a", { kind: "human", question: "Is this good enough to ship?" }, { by: "fixed" }),
  ]));
  assert.equal(incoherent.ok, false);
  assert.ok(incoherent.reasons.some((r) => r.includes("no code can ever evaluate it")), incoherent.reasons.join(" | "));

  // Negative control: the same criterion routed to a person is fine.
  assert.deepEqual(
    dodValidate(dod([crit("a", { kind: "human", question: "Is this good enough to ship?" }, { by: "human" })])),
    { ok: true },
  );
});

test("duplicate criterion ids are rejected: one outcome would overwrite the other", () => {
  const v = dodValidate(dod([
    crit("same", { kind: "contains", value: "a" }),
    crit("same", { kind: "contains", value: "b" }),
  ]));
  assert.equal(v.ok, false);
  assert.ok(v.reasons.some((r) => r.includes("duplicate id")), v.reasons.join(" | "));
});

test("the shipped exploratory DoD is itself not vacuous", () => {
  assert.deepEqual(dodValidate(DOD_EXPLORATORY), { ok: true });
  assert.equal(DOD_EXPLORATORY.criteria.filter((c) => c.required).length, 1);
});

/* ── fixed criteria: every kind, each with a negative control ────────────── */

test("contains and not_contains read the answer, case-insensitively by default", () => {
  const r = run({ answer: "Q1 enterprise ARR is 4,182,000 USD." });
  const outcomes = evaluateFixedCriteria(
    dod([
      crit("hit", { kind: "contains", value: "4,182,000" }),
      crit("miss", { kind: "contains", value: "9,000,000" }),
      crit("case", { kind: "contains", value: "arr" }),
      crit("cased", { kind: "contains", value: "arr", caseSensitive: true }),
      crit("clean", { kind: "not_contains", value: "approximately" }),
      crit("dirty", { kind: "not_contains", value: "USD" }),
    ]),
    r,
  );
  assert.deepEqual(outcomes.map((o) => [o.criterionId, o.met]), [
    ["hit", true], ["miss", false], ["case", true], ["cased", false],
    ["clean", true], ["dirty", false],
  ]);
  assert.ok(outcomes[1].observed.includes("does not contain"), outcomes[1].observed);
});

test("number_within measures the nearest number, and says no when it is outside tolerance", () => {
  const near = evaluateFixedCriteria(
    dod([crit("n", { kind: "number_within", expected: 4182000, tolerance: 1000 })]),
    run({ answer: "ARR is 4,181,500 USD." }),
  );
  assert.equal(near[0].met, true);
  assert.ok(near[0].observed.includes("4181500"), near[0].observed);

  const far = evaluateFixedCriteria(
    dod([crit("n", { kind: "number_within", expected: 4182000, tolerance: 1000 })]),
    run({ answer: "ARR is 3,900,000 USD." }),
  );
  assert.equal(far[0].met, false);
  assert.ok(far[0].observed.includes("delta 282000"), far[0].observed);

  const none = evaluateFixedCriteria(
    dod([crit("n", { kind: "number_within", expected: 5, tolerance: 1 })]),
    run({ answer: "I could not find the figure." }),
  );
  assert.equal(none[0].met, false);
  assert.ok(none[0].observed.includes("no number"), none[0].observed);
});

test("tool_called counts calls and tool_not_called catches the forbidden one", () => {
  const twice = run({ steps: [step(1, call("search_docs", {})), step(2, call("search_docs", {})), step(3, call("kpi", {}))] });
  const once = run({ steps: [step(1, call("search_docs", {}))] });
  const d = dod([
    crit("reformulated", { kind: "tool_called", tool: "search_docs", times: 2 }),
    crit("no_writes", { kind: "tool_not_called", tool: "write_artifact" }),
  ]);

  assert.deepEqual(evaluateFixedCriteria(d, twice).map((o) => o.met), [true, true]);
  // Negative control: the times-2 criterion must fail a run that hit first try.
  const single = evaluateFixedCriteria(d, once);
  assert.equal(single[0].met, false);
  assert.ok(single[0].observed.includes("called 1x (need >= 2)"), single[0].observed);

  const wrote = run({ steps: [step(1, call("write_artifact", { path: "/harness/runs/run_1/x.md" }))] });
  assert.equal(evaluateFixedCriteria(d, wrote)[1].met, false);
});

test("tool_value_equals reads the machine value, not the prose", () => {
  const good = run({ steps: [step(1, call("policy_check", { decision: "deny", ruleId: "EU-PII-03" }))] });
  const bad = run({ steps: [step(1, call("policy_check", { decision: "allow", ruleId: "EU-PII-03" }))] });
  const errored = run({ steps: [step(1, call("policy_check", { decision: "deny" }, "error"))] });
  const d = dod([crit("denied", { kind: "tool_value_equals", tool: "policy_check", path: "decision", equals: "deny" })]);

  assert.equal(evaluateFixedCriteria(d, good)[0].met, true);
  assert.equal(evaluateFixedCriteria(d, bad)[0].met, false);
  // An errored call carries no trustworthy value, so it cannot satisfy the check.
  assert.equal(evaluateFixedCriteria(d, errored)[0].met, false);
  assert.ok(evaluateFixedCriteria(d, errored)[0].observed.includes("no ok result"), "names why");
});

test("artifact_exists matches the run-scoped path the tool actually wrote", () => {
  const wrote = run({ steps: [step(1, call("write_artifact", { path: "/harness/runs/run_1/summary.md", bytes: 12 }))] });
  const d = dod([crit("art", { kind: "artifact_exists", path: "summary.md" })]);
  assert.equal(evaluateFixedCriteria(d, wrote)[0].met, true);

  const wroteOther = run({ steps: [step(1, call("write_artifact", { path: "/harness/runs/run_1/notes.md", bytes: 12 }))] });
  assert.equal(evaluateFixedCriteria(d, wroteOther)[0].met, false);
  assert.equal(evaluateFixedCriteria(d, run())[0].met, false);
});

test("max_steps and max_cost_usd take the honest number", () => {
  const d = dod([
    crit("steps", { kind: "max_steps", value: 3 }),
    crit("cost", { kind: "max_cost_usd", value: 0.02 }),
  ]);
  const cheap = run({ steps: [step(1), step(2)], totals: { ...TOTALS, steps: 2, costUsd: 0.01 } });
  assert.deepEqual(evaluateFixedCriteria(d, cheap).map((o) => o.met), [true, true]);

  // totals under-reports; the step list is the larger count and must be the one used,
  // or the criterion passes exactly the wandering run it exists to fail.
  const wandered = run({
    steps: [step(1), step(2), step(3), step(4)],
    totals: { ...TOTALS, steps: 0, costUsd: 0.05 },
  });
  const out = evaluateFixedCriteria(d, wandered);
  assert.equal(out[0].met, false);
  assert.ok(out[0].observed.includes("used 4 steps"), out[0].observed);
  assert.equal(out[1].met, false);
});

test("no_flag fails and names the flag it found", () => {
  const d = dod([crit("clean", { kind: "no_flag", code: "loop_detected" })]);
  assert.equal(evaluateFixedCriteria(d, run())[0].met, true);

  const looped = run({
    flags: [{ code: "loop_detected", severity: "error", stepIndex: 4, detail: "jaccard 0.91 vs step 3" }],
  });
  const out = evaluateFixedCriteria(d, looped)[0];
  assert.equal(out.met, false);
  assert.ok(out.observed.includes("jaccard 0.91"), out.observed);
});

test("stable_across_repeats is NOT met when there are no repeats to compare", () => {
  const d = dod([crit("stable", { kind: "stable_across_repeats", field: "answer" })]);
  const base = run({ answer: "4,182,000 USD" });

  const unobserved = evaluateFixedCriteria(d, base, [])[0];
  assert.equal(unobserved.met, false, "stability never observed is not stability");
  assert.ok(unobserved.observed.includes("no repeat runs"), unobserved.observed);

  assert.equal(evaluateFixedCriteria(d, base, [run({ answer: "4,182,000 USD" })])[0].met, true);
  const drifted = evaluateFixedCriteria(d, base, [run({ answer: "about 4.2M USD" })])[0];
  assert.equal(drifted.met, false);
  assert.ok(drifted.observed.includes("differed in 1 of 1"), drifted.observed);
});

test("stable_across_repeats compares the tool sequence when asked to", () => {
  const d = dod([crit("seq", { kind: "stable_across_repeats", field: "tool_sequence" })]);
  const base = run({ steps: [step(1, call("search_docs", {})), step(2, call("read_doc", {}))] });
  const same = run({ steps: [step(1, call("search_docs", {})), step(2, call("read_doc", {}))], answer: "different prose" });
  const other = run({ steps: [step(1, call("kpi", {}))] });

  assert.equal(evaluateFixedCriteria(d, base, [same])[0].met, true);
  assert.equal(evaluateFixedCriteria(d, base, [other])[0].met, false);
});

test("a malformed check is not met, and says why instead of passing quietly", () => {
  const out = evaluateFixedCriteria(dod([crit("vacuous", { kind: "contains", value: "" })]), run({ answer: "anything" }));
  assert.equal(out[0].met, false);
  assert.ok(out[0].observed.includes("unusable"), out[0].observed);
});

test("evaluateFixedCriteria reports only the fixed criteria", () => {
  const d = dod([
    crit("fixed", { kind: "contains", value: "x" }),
    crit("model", { kind: "judge", question: "Is the answer well sourced?" }, { by: "model" }),
    crit("human", { kind: "human", question: "Is this good enough to ship?" }, { by: "human" }),
  ]);
  assert.deepEqual(evaluateFixedCriteria(d, run({ answer: "x" })).map((o) => o.criterionId), ["fixed"]);
});

/* ── evaluateDod ────────────────────────────────────────────────────────── */

test("a run that meets every criterion passes, with score 1", async () => {
  const d = dod([
    crit("figure", { kind: "contains", value: "4,182,000" }, { label: "quotes the figure" }),
    crit("sourced", { kind: "tool_called", tool: "kpi" }, { label: "used the KPI tool" }),
  ]);
  const v = await evaluateDod(d, run({
    answer: "Q1 enterprise ARR is 4,182,000 USD.",
    steps: [step(1, call("kpi", { value: 4182000 }))],
  }), null);

  assert.equal(v.pass, true);
  assert.equal(v.score, 1);
  assert.deepEqual(v.pendingHuman, []);
  assert.equal(v.dodId, "dod_1");
  assert.ok(v.reason.startsWith("2/2 criteria met (score 1.00, threshold 1.00)."), v.reason);
});

test("one failing criterion fails the run and the reason names WHICH one", async () => {
  const d = dod([
    crit("figure", { kind: "contains", value: "4,182,000" }, { label: "quotes the figure" }),
    crit("sourced", { kind: "tool_called", tool: "kpi" }, { label: "used the KPI tool" }),
  ]);
  const v = await evaluateDod(d, run({
    answer: "ARR is roughly four million.",
    steps: [step(1, call("kpi", { value: 4182000 }))],
  }), null);

  assert.equal(v.pass, false);
  assert.equal(v.score, 0.5);
  assert.ok(v.reason.includes('FAILED (required) "quotes the figure"'), v.reason);
  assert.ok(!v.reason.includes('FAILED (required) "used the KPI tool"'), v.reason);
  assert.equal(v.outcomes.find((o) => o.criterionId === "figure").met, false);
  assert.equal(v.outcomes.find((o) => o.criterionId === "sourced").met, true);
});

test("a DoD with no criteria cannot report pass", async () => {
  const v = await evaluateDod(dod([], { passThreshold: 0 }), run({ answer: "anything at all" }), null);
  assert.equal(v.pass, false, "an empty DoD must not manufacture a pass");
  assert.equal(v.score, 0);
});

test("the verdict is stamped from the run, so the same run evaluates identically twice", async () => {
  const d = dod([crit("figure", { kind: "contains", value: "4,182,000" })]);
  const r = run({ answer: "ARR 4,182,000", endedAt: 987654 });
  const a = await evaluateDod(d, r, null);
  const b = await evaluateDod(d, r, null);
  assert.equal(a.decidedAt, 987654);
  assert.deepEqual(a, b);
});

/* ── the judge ──────────────────────────────────────────────────────────── */

test("the judge is not called once a required fixed criterion has already failed", async () => {
  let calls = 0;
  const judge = async () => { calls += 1; return { met: true, observed: "looks fine" }; };
  const d = dod([
    crit("figure", { kind: "contains", value: "4,182,000" }),
    crit("quality", { kind: "judge", question: "Is the answer well sourced?" }, { by: "model" }),
  ]);

  const failed = await evaluateDod(d, run({ answer: "no figure here" }), judge);
  assert.equal(calls, 0, "a judge call on an already-failed run is pure spend");
  assert.equal(failed.pass, false);
  assert.equal(failed.outcomes.find((o) => o.criterionId === "quality").met, null);

  // Negative control: with the fixed criterion met, the judge does run.
  const ok = await evaluateDod(d, run({ answer: "ARR is 4,182,000 USD" }), judge);
  assert.equal(calls, 1);
  assert.equal(ok.outcomes.find((o) => o.criterionId === "quality").met, true);
  assert.equal(ok.pass, true);
});

test("the judge sees the question, the objective and the answer — never the transcript", async () => {
  const seen = [];
  const judge = async (question, objective, answer) => {
    seen.push({ question, objective, answer });
    return { met: false, observed: "no citation" };
  };
  const d = dod([crit("quality", { kind: "judge", question: "Is every figure cited?" }, { by: "model" })]);
  const v = await evaluateDod(d, run({
    answer: "ARR is 4,182,000 USD.",
    transcript: "Thought 1: I will guess.",
  }), judge);

  assert.deepEqual(seen, [{
    question: "Is every figure cited?",
    objective: "Report Q1 ARR for enterprise.",
    answer: "ARR is 4,182,000 USD.",
  }]);
  assert.equal(v.pass, false);
  assert.ok(v.reason.includes("no citation"), v.reason);
});

test("a judge that throws leaves the criterion not met, never pending", async () => {
  const judge = async () => { throw new Error("upstream 502"); };
  const d = dod([crit("quality", { kind: "judge", question: "Is every figure cited?" }, { by: "model" })]);
  const v = await evaluateDod(d, run({ answer: "ARR is 4,182,000 USD." }), judge);

  const o = v.outcomes[0];
  assert.equal(o.met, false);
  assert.ok(o.observed.includes("upstream 502"), o.observed);
  assert.equal(v.pass, false);
  assert.deepEqual(v.pendingHuman, []);
});

test("a model criterion with no judge configured is not observed, and blocks the pass", async () => {
  const d = dod([crit("quality", { kind: "judge", question: "Is every figure cited?" }, { by: "model" })]);
  const v = await evaluateDod(d, run({ answer: "ARR is 4,182,000 USD." }), null);
  assert.equal(v.outcomes[0].met, null);
  assert.equal(v.pass, false);
  assert.ok(v.reason.includes("NOT OBSERVED"), v.reason);
});

/* ── the human sign-off ─────────────────────────────────────────────────── */

test("an unsigned human criterion blocks the pass even when everything else is met", async () => {
  const d = dod([
    crit("figure", { kind: "contains", value: "4,182,000" }),
    crit("shipworthy", { kind: "human", question: "Is this good enough to send to the board?" }, { by: "human" }),
  ], { passThreshold: 0.5 });
  const v = await evaluateDod(d, run({ answer: "ARR is 4,182,000 USD." }), null);

  assert.equal(v.pass, false, "a run may not claim pass while a person has not signed");
  assert.deepEqual(v.pendingHuman, ["shipworthy"]);
  assert.equal(v.score, 0.5, "the fixed half still scores");
  assert.equal(v.decidedBy, null);
  assert.ok(v.reason.includes("PENDING") && v.reason.includes("chris"), v.reason);
});

test("a named person signing the human criterion is what turns it into a pass", async () => {
  const d = dod([
    crit("figure", { kind: "contains", value: "4,182,000" }),
    crit("shipworthy", { kind: "human", question: "Is this good enough to send to the board?" }, { by: "human" }),
  ]);
  const v = await evaluateDod(d, run({ answer: "ARR is 4,182,000 USD." }), null);

  const signed = applyHumanDecision(v, "shipworthy", true, "read the trace, figures check out", "chris", { dod: d, at: 5000 });
  assert.equal(signed.pass, true);
  assert.equal(signed.score, 1);
  assert.equal(signed.decidedBy, "chris");
  assert.equal(signed.decidedAt, 5000);
  assert.deepEqual(signed.pendingHuman, []);
  assert.ok(signed.outcomes.find((o) => o.criterionId === "shipworthy").observed.startsWith("chris: "));

  // Negative control: the same person saying no fails it, and names them.
  const refused = applyHumanDecision(v, "shipworthy", false, "the segment is wrong", "chris", { dod: d });
  assert.equal(refused.pass, false);
  assert.ok(refused.reason.includes('FAILED (required) "shipworthy"'), refused.reason);
  assert.equal(v.pass, false, "the original verdict is not mutated");
});

test("an unnamed signer, an unknown criterion and a fixed criterion are all refused", async () => {
  const d = dod([
    crit("figure", { kind: "contains", value: "4,182,000" }),
    crit("shipworthy", { kind: "human", question: "Is this good enough to send to the board?" }, { by: "human" }),
  ]);
  const v = await evaluateDod(d, run({ answer: "ARR is 4,182,000 USD." }), null);

  assert.deepEqual(applyHumanDecision(v, "shipworthy", true, "fine", "   ", { dod: d }), v, "an empty name is not a name");
  assert.deepEqual(applyHumanDecision(v, "nope", true, "fine", "chris", { dod: d }), v, "unknown criterion id");
  assert.deepEqual(
    applyHumanDecision(v, "figure", false, "I disagree with the string match", "chris", { dod: d }),
    v,
    "a signature must not overwrite a fixed check",
  );
});

test("without the DoD the sign-off falls back to the stricter rule", async () => {
  const d = dod([
    crit("figure", { kind: "contains", value: "4,182,000" }, { required: false, weight: 3 }),
    crit("shipworthy", { kind: "human", question: "Is this good enough to send to the board?" }, { by: "human" }),
  ], { passThreshold: 0.1 });

  const missed = await evaluateDod(d, run({ answer: "no figure at all" }), null);
  const signedBlind = applyHumanDecision(missed, "shipworthy", true, "ship it anyway", "chris");
  assert.equal(signedBlind.pass, false, "an unmet criterion blocks the fallback even below threshold");
  assert.equal(signedBlind.decidedBy, "chris");
  assert.deepEqual(signedBlind.pendingHuman, []);

  // With the DoD supplied, the real rule applies and this same run does pass.
  const signedExact = applyHumanDecision(missed, "shipworthy", true, "ship it anyway", "chris", { dod: d });
  assert.equal(signedExact.pass, true);
  assert.equal(signedExact.score, 0.25);
});

/* ── verdictReason ──────────────────────────────────────────────────────── */

test("verdictReason is assembled from the outcomes, not written by a model", () => {
  const d = dod([
    crit("a", { kind: "contains", value: "x" }, { label: "quotes x", weight: 2 }),
    crit("b", { kind: "contains", value: "y" }, { label: "quotes y", required: false }),
  ], { passThreshold: 0.6 });
  const outcomes = [
    { criterionId: "a", met: true, observed: "found x", by: "fixed", ms: 0 },
    { criterionId: "b", met: false, observed: "answer does not contain \"y\"", by: "fixed", ms: 0 },
  ];
  const reason = verdictReason(d, outcomes);
  assert.equal(
    reason,
    '1/2 criteria met (score 0.67, threshold 0.60). FAILED "quotes y": "answer does not contain \\"y\\"".',
  );
});

test("an ADVISORY human criterion still blocks the pass while it is unsigned", async () => {
  // The required-criterion rule would already fail a required human sign-off,
  // so the pendingHuman clause is only load-bearing here: nothing else about
  // this run is outstanding, and it must still not report pass.
  const d = dod([
    crit("figure", { kind: "contains", value: "4,182,000" }),
    crit("signoff", { kind: "human", question: "Is this good enough to send to the board?" },
      { by: "human", required: false }),
  ], { passThreshold: 0.5 });
  const v = await evaluateDod(d, run({ answer: "ARR is 4,182,000 USD." }), null);

  assert.equal(v.score, 0.5);
  assert.ok(v.score >= d.passThreshold, "the threshold is met");
  assert.equal(v.outcomes.find((o) => o.criterionId === "figure").met, true, "every required criterion is met");
  assert.deepEqual(v.pendingHuman, ["signoff"]);
  assert.equal(v.pass, false, "a pending human decision blocks the pass on its own");

  const signed = applyHumanDecision(v, "signoff", true, "checked it", "chris", { dod: d });
  assert.equal(signed.pass, true, "and releases it once a named person signs");
});
