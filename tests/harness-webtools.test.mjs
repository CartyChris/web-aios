/* Live tools — the free-services catalogue as harness tools.
 *
 * The property under test throughout is that these tools tell the truth about
 * WHICH KIND of nothing they got. A transport failure, an unreadable reply and
 * a genuinely empty result are three different facts, and an agent that cannot
 * tell them apart concludes "the subject does not exist" from a 502.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { webTools, toolNameFor, DEFAULT_WEB_TOOLS } from "../.test-build/harness/webtools.js";
import { SERVICES } from "../.test-build/services.js";
import { createRegistry, runTool, toolCatalogueText } from "../.test-build/harness/tools.js";
import { createFactStore } from "../.test-build/harness/context.js";
import { runReAct } from "../.test-build/harness/loop.js";
import { DEFAULT_LOOP_CONFIG, mergeConfig } from "../.test-build/harness/config.js";

/** A ToolContext that records nothing and blocks nothing. */
function ctx(overrides = {}) {
  return {
    runId: "run_test",
    stepIndex: 0,
    signal: new AbortController().signal,
    facts: createFactStore([]),
    span: () => {},
    parentSpanId: "sp_root",
    now: () => 1_776_254_400_000,
    cache: new Map(),
    ...overrides,
  };
}

const serving = (body) => async () => body;
const failing = (message) => async () => { throw new Error(message); };

function only(id, fetchText) {
  const [tool] = webTools({ fetchText, only: [id] });
  assert.ok(tool, `no tool built for service ${id}`);
  return tool;
}

/* ── shape ───────────────────────────────────────────────────────────────── */

test("one tool is built per service and every name matches the action parser", () => {
  const tools = webTools({ fetchText: serving("{}") });
  assert.equal(tools.length, SERVICES.length);
  for (const t of tools) {
    assert.match(t.name, /^[a-z][a-z0-9_]{1,39}$/, `${t.name} is not callable by the action parser`);
  }
  assert.equal(new Set(tools.map((t) => t.name)).size, tools.length, "duplicate tool name");
});

test("every live tool is marked non-deterministic, and the catalogue says so out loud", () => {
  const tools = webTools({ fetchText: serving("{}"), only: ["wikipedia"] });
  assert.equal(tools[0].deterministic, false);
  const text = toolCatalogueText(tools);
  assert.match(text, /NOT deterministic/);
  assert.match(text, /do not quote it as a fixed figure/);
});

test("every live tool is read-only, non-destructive and flagged open-world", () => {
  for (const t of webTools({ fetchText: serving("{}") })) {
    assert.equal(t.annotations.readOnly, true, `${t.name} is not read-only`);
    assert.equal(t.annotations.destructive, false, `${t.name} is marked destructive`);
    assert.equal(t.annotations.openWorld, true, `${t.name} is not flagged open-world`);
  }
});

test("the description names the provider and the licence, so attribution survives into the prompt", () => {
  const t = only("wikipedia", serving("{}"));
  assert.match(t.description, /Wikimedia Foundation/);
  assert.match(t.description, /CC BY-SA 4\.0/);
});

test("the default subset is a real subset of the catalogue", () => {
  const ids = new Set(SERVICES.map((s) => s.id));
  for (const id of DEFAULT_WEB_TOOLS) assert.ok(ids.has(id), `${id} is in DEFAULT_WEB_TOOLS but not in the catalogue`);
  assert.ok(DEFAULT_WEB_TOOLS.length < SERVICES.length);
});

test("`only` filters by service id and an unknown id yields nothing rather than everything", () => {
  assert.equal(webTools({ fetchText: serving("{}"), only: ["wikipedia", "arxiv"] }).length, 2);
  // A filter that falls back to the whole catalogue on a typo is the failure
  // mode worth pinning: the agent silently gains 24 open-world tools.
  assert.equal(webTools({ fetchText: serving("{}"), only: ["no_such_service"] }).length, 0);
});

test("toolNameFor is stable and prefixed", () => {
  assert.equal(toolNameFor("wikipedia"), "web_wikipedia");
  assert.ok(toolNameFor("a".repeat(60)).length <= 40);
});

/* ── the happy path ──────────────────────────────────────────────────────── */

test("a successful call returns rows, the provider and the licence in its value", async () => {
  const body = JSON.stringify({ query: { pages: { "1": { title: "Eigenstate", extract: "A state…", fullurl: "https://en.wikipedia.org/wiki/Eigenstate" } } } });
  const t = only("wikipedia", serving(body));
  const r = await t.run({ query: "eigenstate" }, ctx());
  assert.equal(r.status, "ok");
  assert.equal(r.value.rows.length, 1);
  assert.equal(r.value.provider, "Wikimedia Foundation");
  assert.equal(r.value.licence, "CC BY-SA 4.0");
  assert.match(r.observation, /Eigenstate/);
  assert.match(r.observation, /<https:\/\/en\.wikipedia\.org\/wiki\/Eigenstate>/);
});

test("the observation is capped at twelve rows and says how many were withheld", async () => {
  const pages = {};
  for (let i = 0; i < 30; i++) pages[String(i)] = { title: `Page ${String(i).padStart(2, "0")}`, extract: "x" };
  const t = only("wikipedia", serving(JSON.stringify({ query: { pages } })));
  const r = await t.run({ query: "x" }, ctx());
  assert.equal(r.value.rows.length, 30, "the machine value keeps everything");
  assert.match(r.observation, /\(\+18 more not shown\)/);
  assert.equal(r.observation.split("\n").filter((l) => /^\d+\. /.test(l)).length, 12);
});

test("numeric arguments reach the URL as plain numbers", async () => {
  let seen = "";
  const t = only("weather", async (url) => {
    seen = url;
    return JSON.stringify({ current: { temperature_2m: 1 }, daily: { time: [], temperature_2m_max: [], temperature_2m_min: [], precipitation_sum: [] } });
  });
  await t.run({ latitude: 64.146, longitude: -21.94 }, ctx());
  assert.match(seen, /latitude=64\.146/);
  assert.match(seen, /longitude=-21\.94/);
  assert.doesNotMatch(seen, /object%20Object|NaN|undefined/);
});

test("a declared default is applied when the caller omits the argument", async () => {
  let seen = "";
  const t = only("fx", async (url) => { seen = url; return JSON.stringify({ base: "USD", date: "2026-01-01", rates: { EUR: 0.9 } }); });
  const r = await t.run({}, ctx());
  assert.equal(r.status, "ok");
  assert.match(seen, /base=USD/);
});

test("the reach of the service is handed to the transport, so the caller knows whether to proxy", async () => {
  const seen = [];
  const tools = webTools({ fetchText: async (url, o) => { seen.push(o.reach); return "{}"; }, only: ["wikipedia", "arxiv"] });
  await tools[0].run({ query: "x" }, ctx()).catch(() => {});
  await tools[1].run({ query: "x" }, ctx()).catch(() => {});
  assert.deepEqual(seen, ["direct", "proxy"]);
});

test("the abort signal is passed through to the transport", async () => {
  const controller = new AbortController();
  let got = null;
  const t = only("wikipedia", async (_u, o) => { got = o.signal; return "{}"; });
  await t.run({ query: "x" }, ctx({ signal: controller.signal })).catch(() => {});
  assert.equal(got, controller.signal);
});

/* ── the three kinds of nothing ──────────────────────────────────────────── */

test("a transport failure is reported as a failure, explicitly NOT as an empty result", async () => {
  const t = only("wikipedia", failing("fetch failed: ENOTFOUND"));
  const r = await t.run({ query: "eigenstate" }, ctx());
  assert.equal(r.status, "error");
  assert.match(r.observation, /transport failure, not an empty result/);
  assert.match(r.observation, /ENOTFOUND/);
  assert.equal(r.value, undefined, "a failed call must not carry rows");
});

test("an unreadable reply is reported as unreadable, and warns against reading it as no results", async () => {
  const t = only("wikipedia", serving("<html>502 Bad Gateway</html>"));
  const r = await t.run({ query: "x" }, ctx());
  assert.equal(r.status, "error");
  assert.match(r.observation, /could not read the reply/);
  assert.match(r.observation, /Do not treat this as "no results"/);
});

test("a genuine miss is reported as a miss and says the service answered normally", async () => {
  const t = only("wikipedia", serving(JSON.stringify({ batchcomplete: "" })));
  const r = await t.run({ query: "asdkjhaskdjh" }, ctx());
  assert.equal(r.status, "ok");
  assert.equal(r.value.empty, true);
  assert.match(r.observation, /no results for those arguments/);
  assert.match(r.observation, /answered normally/);
});

test("the three outcomes are mutually distinguishable from the observation alone", async () => {
  const outcomes = await Promise.all([
    only("wikipedia", failing("boom")).run({ query: "x" }, ctx()),
    only("wikipedia", serving("<html>")).run({ query: "x" }, ctx()),
    only("wikipedia", serving(JSON.stringify({ batchcomplete: "" }))).run({ query: "x" }, ctx()),
  ]);
  const texts = outcomes.map((o) => o.observation);
  assert.equal(new Set(texts).size, 3, "two different failures produced the same observation");
  for (const o of outcomes) assert.notEqual(o.observation.trim(), "", "empty observation");
});

/* ── argument validation ─────────────────────────────────────────────────── */

test("a missing required argument is refused before any request is made", async () => {
  let called = false;
  const t = only("wikipedia", async () => { called = true; return "{}"; });
  const r = await t.run({}, ctx());
  assert.equal(r.status, "invalid_args");
  assert.equal(called, false, "the transport was called despite a missing required argument");
  assert.match(r.observation, /needs query/);
  // The way forward, not just the complaint.
  assert.match(r.observation, /Call it again as query=/);
});

test("a blank string counts as missing, not as a valid empty query", async () => {
  const r = await only("wikipedia", serving("{}")).run({ query: "   " }, ctx());
  assert.equal(r.status, "invalid_args");
});

test("an argument of a type no URL builder accepts is dropped rather than coerced", async () => {
  let seen = "";
  const t = only("wikipedia", async (url) => { seen = url; return JSON.stringify({ batchcomplete: "" }); });
  const r = await t.run({ query: "ok", limit: { nested: true } }, ctx());
  assert.equal(r.status, "ok");
  assert.doesNotMatch(seen, /object%20Object/);
  assert.match(seen, /gsrlimit=5/, "the declared default should stand in for the dropped value");
});

/* ── integration with the existing registry ──────────────────────────────── */

test("live tools register alongside the deterministic ones and run through runTool", async () => {
  const registry = createRegistry();
  const disposers = webTools({ fetchText: serving(JSON.stringify({ base: "USD", date: "2026-01-01", rates: { EUR: 0.9 } })), only: ["fx"] })
    .map((t) => registry.register(t));
  assert.equal(registry.list().length, 1);

  const tool = registry.get("web_fx");
  const r = await runTool(tool, { from: "USD", to: "EUR" }, ctx());
  assert.equal(r.status, "ok");
  assert.ok(r.ms >= 0, "runTool must time the call");

  for (const d of disposers) d();
  assert.equal(registry.list().length, 0, "a live tool must be removable");
  assert.equal(registry.get("web_fx"), undefined);
});

test("a non-deterministic tool is never answered from the per-run memo", async () => {
  // Two identical calls must both hit the network: memoising a live figure is
  // how a stale price ends up quoted as current later in the same run.
  let calls = 0;
  const registry = createRegistry();
  registry.register(only("fx", async () => {
    calls += 1;
    return JSON.stringify({ base: "USD", date: "2026-01-01", rates: { EUR: 0.9 + calls } });
  }));
  const shared = ctx();
  await runTool(registry.get("web_fx"), { from: "USD" }, shared);
  await runTool(registry.get("web_fx"), { from: "USD" }, shared);
  assert.equal(calls, 2, "the second identical call was served from the cache");
});

/* ── the approval gate must not defeat the feature ───────────────────────── */

test("a live tool does NOT require per-call approval, or the shipped policy denies it", async () => {
  // `annotationsFor("web_wikipedia")` recognises neither a read nor a write
  // segment, so it fails closed: destructive, requiresApproval. Correct for an
  // unknown tool, wrong for these. The next test proves what inheriting it
  // would have cost.
  for (const t of webTools({ fetchText: serving("{}") })) {
    assert.equal(t.annotations.requiresApproval, false, `${t.name} would be gated behind approval`);
    assert.equal(t.annotations.openWorld, true, `${t.name} must still declare that it reaches the open web`);
  }
});

test("under the SHIPPED config and a deny-by-default approver, a live tool actually runs", async () => {
  // The real check. An annotation assertion alone would not have caught this:
  // the denial happens inside the loop, from the interaction of the tool's
  // annotations, config.approvals and the runtime's default approve().
  const registry = createRegistry();
  registry.register(only("wikipedia", serving(JSON.stringify({
    query: { pages: { "1": { title: "Eigenstate", extract: "A state of definite value." } } },
  }))));

  let calls = 0;
  const result = await runReAct(
    "find the page",
    mergeConfig(DEFAULT_LOOP_CONFIG, {}),
    {
      id: "d", label: "t", owner: "tester", passThreshold: 1,
      criteria: [{ id: "c", label: "called it", expectation: "the live tool was actually called at least once", check: { kind: "tool_called", tool: "web_wikipedia" }, by: "fixed", weight: 1, required: true }],
    },
    { triggerId: "t", kind: "manual", at: 1, payload: {}, dedupeKey: `k${Math.random()}` },
    {
      llm: async () => {
        calls += 1;
        const text = calls === 1
          ? 'Thought 1: look it up.\nAction 1: web_wikipedia[{"query":"eigenstate"}]'
          : "Thought 2: got it.\nAction 2: finish[Eigenstate is a state of definite value.]";
        return { text, tokensIn: 1, tokensOut: 1, costUsd: 0, ms: 1, provider: "t", model: "t", spanId: "s" };
      },
      tools: registry,
      facts: createFactStore([]),
      span: () => {},
      now: () => 1_776_254_400_000,
      uid: (p) => `${p}_${calls}`,
      signal: new AbortController().signal,
      spend: () => 0,
      // Deny by default — exactly what harness-runtime.ts passes when the
      // caller supplies no approver, which is every triggered run.
      approve: async () => null,
      fingerprint: "test",
    },
  );

  const denied = result.flags.filter((f) => f.code === "approval_required");
  assert.equal(denied.length, 0, `the live tool was denied: ${denied.map((f) => f.detail).join("; ")}`);
  assert.equal(result.verdict?.pass, true, result.verdict?.reason);
  assert.match(result.answer, /Eigenstate/);
});
