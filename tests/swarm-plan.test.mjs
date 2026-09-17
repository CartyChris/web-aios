/* Planning a swarm.
 *
 * The failure this module exists to prevent is a run that starts nothing and
 * says nothing about why. So most of these tests are refusals — a cycle, a
 * dependency on a switched-off agent, a router that invented a model — and
 * each asserts that the reason names the thing at fault.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  planWaves, resolveModel, modelSpread, clampTokens, criticalPath,
  upstreamBlock, routerPrompt, parseRouterPlan, applyRouterPlan,
  MAX_TOKENS_CEILING, MIN_TOKENS, DEFAULT_MAX_TOKENS, UPSTREAM_CHARS,
} from "../.test-build/swarm-plan.js";

const agent = (id, patch = {}) => ({
  id, name: id.toUpperCase(), role: `the ${id}`, dependsOn: [], enabled: true, ...patch,
});

const DEFAULTS = { provider: "openai", model: "gpt-5.2", maxTokens: 4000, temperature: 0.7 };
const CATALOGUE = [
  { provider: "openai", model: "gpt-5.2", note: "strong" },
  { provider: "deepseek", model: "deepseek-chat", note: "cheap" },
  { provider: "groq", model: "llama-3.3-70b", note: "fast" },
];

/* ── token ceiling ───────────────────────────────────────────────────────── */

test("the ceiling is far above the old 4,000 slider bound", () => {
  // The old bound truncated any agent actually asked to write something.
  assert.ok(MAX_TOKENS_CEILING >= 32_000, `ceiling is only ${MAX_TOKENS_CEILING}`);
  assert.equal(clampTokens(50_000), 50_000);
});

test("clampTokens holds the floor and the ceiling and survives junk", () => {
  assert.equal(clampTokens(10), MIN_TOKENS);
  assert.equal(clampTokens(999_999), MAX_TOKENS_CEILING);
  assert.equal(clampTokens(undefined), DEFAULT_MAX_TOKENS);
  assert.equal(clampTokens(NaN), DEFAULT_MAX_TOKENS);
  assert.equal(clampTokens(1234.7), 1234);
  assert.equal(clampTokens(undefined, 9000), 9000);
});

/* ── model resolution: one model for all, or one each ────────────────────── */

test("an agent naming no model inherits the swarm default", () => {
  const r = resolveModel(agent("a"), DEFAULTS);
  assert.equal(r.provider, "openai");
  assert.equal(r.model, "gpt-5.2");
  assert.equal(r.inherited, true, "the UI must be able to show that this was inherited");
});

test("an agent naming its own model overrides the default", () => {
  const r = resolveModel(agent("a", { provider: "deepseek", model: "deepseek-chat" }), DEFAULTS);
  assert.equal(r.provider, "deepseek");
  assert.equal(r.model, "deepseek-chat");
  assert.equal(r.inherited, false);
});

test("a half-specified agent falls back rather than failing at request time", () => {
  // A model with no provider is unusable: nothing knows where to send it.
  assert.equal(resolveModel(agent("a", { model: "deepseek-chat" }), DEFAULTS).inherited, true);
  assert.equal(resolveModel(agent("a", { provider: "deepseek" }), DEFAULTS).inherited, true);
});

test("a per-agent token override is clamped, not trusted", () => {
  assert.equal(resolveModel(agent("a", { maxTokens: 999_999 }), DEFAULTS).maxTokens, MAX_TOKENS_CEILING);
  assert.equal(resolveModel(agent("a", { maxTokens: 12_000 }), DEFAULTS).maxTokens, 12_000);
  assert.equal(resolveModel(agent("a"), DEFAULTS).maxTokens, 4000, "falls back to the swarm default");
});

test("modelSpread reports one model when every agent inherits", () => {
  const roster = [agent("a"), agent("b"), agent("c")];
  assert.deepEqual(modelSpread(roster, DEFAULTS), ["openai/gpt-5.2"]);
});

test("modelSpread reports each distinct model when agents differ", () => {
  const roster = [
    agent("a"),
    agent("b", { provider: "deepseek", model: "deepseek-chat" }),
    agent("c", { provider: "groq", model: "llama-3.3-70b" }),
  ];
  assert.deepEqual(modelSpread(roster, DEFAULTS), ["deepseek/deepseek-chat", "groq/llama-3.3-70b", "openai/gpt-5.2"]);
});

test("a disabled agent does not contribute a model to the spread", () => {
  const roster = [agent("a"), agent("b", { provider: "deepseek", model: "deepseek-chat", enabled: false })];
  assert.deepEqual(modelSpread(roster, DEFAULTS), ["openai/gpt-5.2"]);
});

/* ── waves: parallel, and chained ────────────────────────────────────────── */

test("agents with no dependencies form ONE wave — the old flat swarm still works", () => {
  const r = planWaves([agent("a"), agent("b"), agent("c")]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.waves, [["a", "b", "c"]]);
  assert.equal(criticalPath(r.waves), 1);
  assert.deepEqual(r.warnings, [], "a flat swarm should warn about nothing");
});

test("a dependency puts an agent in a later wave", () => {
  const r = planWaves([agent("red"), agent("blue"), agent("judge", { dependsOn: ["red", "blue"] })]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.waves, [["blue", "red"], ["judge"]]);
  assert.equal(criticalPath(r.waves), 2);
  assert.match(r.warnings.join(" "), /2 waves/);
});

test("a three-deep chain produces three waves", () => {
  const r = planWaves([
    agent("design"),
    agent("build", { dependsOn: ["design"] }),
    agent("review", { dependsOn: ["build"] }),
  ]);
  assert.deepEqual(r.waves, [["design"], ["build"], ["review"]]);
});

test("independent branches run in parallel even when each is deep", () => {
  const r = planWaves([
    agent("a1"), agent("a2", { dependsOn: ["a1"] }),
    agent("b1"), agent("b2", { dependsOn: ["b1"] }),
  ]);
  assert.deepEqual(r.waves, [["a1", "b1"], ["a2", "b2"]]);
  assert.equal(criticalPath(r.waves), 2, "two independent chains must not serialise into four waves");
});

test("the plan is deterministic — the same roster always plans the same way", () => {
  const roster = [agent("z"), agent("m"), agent("a", { dependsOn: ["z"] })];
  assert.deepEqual(planWaves(roster).waves, planWaves(roster).waves);
  assert.deepEqual(planWaves(roster).waves, [["m", "z"], ["a"]]);
});

/* ── the refusals ────────────────────────────────────────────────────────── */

test("a cycle is refused and its members are named", () => {
  const r = planWaves([agent("a", { dependsOn: ["b"] }), agent("b", { dependsOn: ["a"] })]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /loop/);
  assert.deepEqual(r.cycle, ["a", "b"]);
});

test("a three-way cycle is caught too", () => {
  const r = planWaves([
    agent("a", { dependsOn: ["c"] }),
    agent("b", { dependsOn: ["a"] }),
    agent("c", { dependsOn: ["b"] }),
  ]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.cycle, ["a", "b", "c"]);
});

test("self-dependency is refused with its own message", () => {
  const r = planWaves([agent("a", { dependsOn: ["a"] })]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /depends on itself/);
});

test("a dependency on an agent that does not exist is refused", () => {
  const r = planWaves([agent("a", { dependsOn: ["ghost"] })]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /ghost/);
  assert.match(r.reason, /not an agent/);
});

test("a dependency on a SWITCHED-OFF agent is refused — it would wait forever", () => {
  // The subtle one. The graph is acyclic and every id resolves, so a naive
  // planner accepts it and the dependent silently never runs.
  const r = planWaves([agent("a", { enabled: false }), agent("b", { dependsOn: ["a"] })]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /switched off/);
  assert.match(r.reason, /wait forever/);
});

test("a disabled agent with no dependents is simply skipped — the negative control", () => {
  // The disabled check must not refuse a roster that is perfectly runnable.
  const r = planWaves([agent("a", { enabled: false }), agent("b")]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.waves, [["b"]]);
});

test("an empty roster is refused rather than planning zero waves", () => {
  assert.equal(planWaves([]).ok, false);
  assert.equal(planWaves([agent("a", { enabled: false })]).ok, false);
});

/* ── inherited context ───────────────────────────────────────────────────── */

const OUTPUTS = [
  { agentId: "red", agentName: "Red Team", role: "argue against", text: "The index rebuild dominates cost." },
  { agentId: "blue", agentName: "Blue Team", role: "argue for", text: "It amortises over a week." },
  { agentId: "other", agentName: "Other", role: "unrelated", text: "Nobody asked for this." },
];

test("an agent sees only the upstreams it actually depends on", () => {
  // Passing the transitive closure would hand a late agent the whole run —
  // expensive, and it homogenises the panel a panel exists to avoid.
  const block = upstreamBlock(agent("judge", { dependsOn: ["red", "blue"] }), OUTPUTS);
  assert.match(block, /Red Team/);
  assert.match(block, /Blue Team/);
  assert.doesNotMatch(block, /Nobody asked for this/);
});

test("an agent with no dependencies gets no upstream block at all", () => {
  assert.equal(upstreamBlock(agent("a"), OUTPUTS), "");
});

test("the block tells the agent to build on the work, not restate it", () => {
  const block = upstreamBlock(agent("j", { dependsOn: ["red"] }), OUTPUTS);
  assert.match(block, /do not simply restate/i);
  assert.match(block, /brief: argue against/);
});

test("a huge upstream is truncated before it reaches the prompt", () => {
  const big = [{ agentId: "red", agentName: "R", role: "r", text: "x".repeat(50_000) }];
  const block = upstreamBlock(agent("j", { dependsOn: ["red"] }), big);
  assert.ok(block.length < UPSTREAM_CHARS + 500, `block was ${block.length} chars`);
  assert.match(block, /\[truncated\]/);
});

/* ── the router ──────────────────────────────────────────────────────────── */

const ROSTER = [agent("red"), agent("blue"), agent("judge")];

test("the router prompt lists the real agents and ONLY the real models", () => {
  const p = routerPrompt("Should we rebuild nightly?", ROSTER, CATALOGUE);
  assert.match(p, /- red: RED/);
  assert.match(p, /deepseek\/deepseek-chat \(cheap\)/);
  assert.match(p, /ONLY these/);
  assert.match(p, /Never create a loop/);
  assert.match(p, /Return ONLY a JSON object/);
});

test("a well-formed router reply is parsed", () => {
  const reply = JSON.stringify({ assignments: [
    { id: "red", provider: "deepseek", model: "deepseek-chat", maxTokens: 2000, dependsOn: [], why: "wide search" },
    { id: "judge", provider: "openai", model: "gpt-5.2", maxTokens: 8000, dependsOn: ["red"], why: "judgement" },
  ] });
  const plan = parseRouterPlan(reply, ROSTER, CATALOGUE);
  assert.equal(plan.assignments.length, 2);
  assert.deepEqual(plan.rejected, []);
  assert.equal(plan.assignments[1].dependsOn[0], "red");
});

test("a fenced reply with prose around it is still parsed", () => {
  const reply = 'Sure! Here is the plan:\n```json\n{"assignments":[{"id":"red","dependsOn":[],"why":"x"}]}\n```\nHope that helps.';
  assert.equal(parseRouterPlan(reply, ROSTER, CATALOGUE).assignments.length, 1);
});

test("an invented model is REJECTED and recorded, not passed through", () => {
  const reply = JSON.stringify({ assignments: [{ id: "red", provider: "acme", model: "supermodel-9", dependsOn: [], why: "x" }] });
  const plan = parseRouterPlan(reply, ROSTER, CATALOGUE);
  assert.equal(plan.assignments.length, 1, "the agent survives; only the bad model is dropped");
  assert.equal(plan.assignments[0].provider, undefined, "the invented model must not reach the request");
  assert.equal(plan.rejected.length, 1);
  assert.match(plan.rejected[0].reason, /not a model this deployment offers/);
});

test("an unknown agent id is rejected and recorded", () => {
  const reply = JSON.stringify({ assignments: [{ id: "nobody", dependsOn: [], why: "x" }] });
  const plan = parseRouterPlan(reply, ROSTER, CATALOGUE);
  assert.deepEqual(plan.assignments, []);
  assert.match(plan.rejected[0].reason, /no agent with that id/);
});

test("a self-dependency and a phantom dependency are both stripped", () => {
  const reply = JSON.stringify({ assignments: [{ id: "red", dependsOn: ["red", "ghost", "blue"], why: "x" }] });
  const plan = parseRouterPlan(reply, ROSTER, CATALOGUE);
  assert.deepEqual(plan.assignments[0].dependsOn, ["blue"], "only the valid dependency survives");
  assert.equal(plan.rejected.length, 2);
});

test("a router token suggestion is clamped rather than trusted", () => {
  const reply = JSON.stringify({ assignments: [{ id: "red", maxTokens: 10_000_000, dependsOn: [], why: "x" }] });
  assert.equal(parseRouterPlan(reply, ROSTER, CATALOGUE).assignments[0].maxTokens, MAX_TOKENS_CEILING);
});

test("a reply that is not JSON at all is reported, not thrown", () => {
  const plan = parseRouterPlan("I think red should go first, honestly.", ROSTER, CATALOGUE);
  assert.deepEqual(plan.assignments, []);
  assert.match(plan.rejected[0].reason, /did not return JSON/);
});

test("valid JSON with no assignments array is reported", () => {
  const plan = parseRouterPlan('{"plan":"do stuff"}', ROSTER, CATALOGUE);
  assert.deepEqual(plan.assignments, []);
  assert.match(plan.rejected[0].reason, /no assignments array/);
});

test("applying a plan updates only the agents it named", () => {
  const plan = parseRouterPlan(
    JSON.stringify({ assignments: [{ id: "judge", provider: "openai", model: "gpt-5.2", dependsOn: ["red", "blue"], why: "x" }] }),
    ROSTER, CATALOGUE,
  );
  const out = applyRouterPlan(ROSTER, plan);
  assert.equal(out.ok, true);
  assert.equal(out.changed, 1);
  assert.deepEqual(out.agents.find((a) => a.id === "judge").dependsOn, ["red", "blue"]);
  assert.deepEqual(out.agents.find((a) => a.id === "red").dependsOn, [], "an unnamed agent must be left alone");
});

test("a router plan that would not run is refused WHOLESALE, leaving the roster intact", () => {
  // Partial application leaves half a routed swarm, which is the worst of both.
  const plan = {
    assignments: [
      { id: "red", dependsOn: ["blue"], why: "" },
      { id: "blue", dependsOn: ["red"], why: "" },
    ],
    rejected: [],
  };
  const out = applyRouterPlan(ROSTER, plan);
  assert.equal(out.ok, false);
  assert.match(out.reason, /router's plan was rejected/);
  assert.match(out.reason, /loop/);
});

test("an empty router plan is a no-op rather than an error", () => {
  const out = applyRouterPlan(ROSTER, { assignments: [], rejected: [] });
  assert.equal(out.ok, true);
  assert.equal(out.changed, 0);
});

test("a routed roster still plans into waves", () => {
  const plan = parseRouterPlan(
    JSON.stringify({ assignments: [{ id: "judge", dependsOn: ["red", "blue"], why: "" }] }),
    ROSTER, CATALOGUE,
  );
  const out = applyRouterPlan(ROSTER, plan);
  const waves = planWaves(out.agents);
  assert.equal(waves.ok, true);
  assert.deepEqual(waves.waves, [["blue", "red"], ["judge"]]);
});
