/* System One harness: schema, compile, parse, gate, the run-state machine,
 * the emulated decider's parser, the router, and the zip it can produce.
 * Design after HarnessRouter/SystemOneHarness (Apache-2.0).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { validateActionSpace } from "../.test-build/s1/schema.js";
import { compileQuestions, toJevRequest, encodeState, ACTION_Q, GOAL_Q, paramQ } from "../.test-build/s1/compile.js";
import { parseAnswers, decide, gate, DEFAULT_THRESHOLDS } from "../.test-build/s1/parse.js";
import { runSystemOne, MAX_REFUSALS } from "../.test-build/s1/run.js";
import { parseEmulatedReply, buildEmulatedPrompt } from "../.test-build/s1/emulated.js";
import { createOrderDesk, scriptedOrderDecider, ORDER_ACTIONS, ORDER_DESK_GOAL } from "../.test-build/s1/orderdesk.js";
import { routerQuestions, planRoute, fitQ, savePlan, parseCombinedFiles, safePath, slugify } from "../.test-build/s1/router.js";
import { makeZip, crc32 } from "../.test-build/zip.js";

const clock = () => { let t = 1000; return () => (t += 7); };

/* ── schema ──────────────────────────────────────────────────────────────── */

test("free-text parameters are refused at load time", () => {
  const r = validateActionSpace([{ name: "send_email", description: "Send", risk: "write", params: [{ name: "body", kind: "text", description: "the body" }] }]);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /free text is refused/);
});

test("the order desk action space is valid", () => {
  assert.equal(validateActionSpace(ORDER_ACTIONS).ok, true);
});

test("choices need two options and levels need 2..10", () => {
  const r = validateActionSpace([
    { name: "a", description: "x", risk: "read", params: [{ name: "p", kind: "choices", description: "d", choices: { only: "one" } }] },
    { name: "b", description: "x", risk: "read", params: [{ name: "q", kind: "levels", description: "d", levels: ["one"] }] },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 2);
});

/* ── compile ─────────────────────────────────────────────────────────────── */

test("actions with no candidates are not offered", () => {
  const q = compileQuestions(ORDER_ACTIONS, { text: "", candidates: { order: {} } });
  assert.deepEqual(Object.keys(q[ACTION_Q].criteria), ["done"]);
  assert.ok(q[GOAL_Q]);
});

test("the Jev request carries typed questions in either wire form", () => {
  const q = { g: { type: "noul", instructions: "i" } };
  assert.deepEqual(toJevRequest("s", q).questions.g, { type: "noul", instructions: "i" });
  assert.deepEqual(toJevRequest("s", q, "nested").questions.g, { noul: { instructions: "i" } });
});

test("the encoded state keeps only the last N history lines", () => {
  const history = Array.from({ length: 10 }, (_, i) => ({ n: i + 1, action: `a${i + 1}`, verdict: "pass", result: "ok" }));
  const s = encodeState({ goal: "g", obs: { text: "o" }, history, window: 3 });
  assert.match(s, /last 3 of 10/);
  assert.ok(!s.includes("a7 "));
  assert.ok(s.includes("a10"));
});

/* ── parse: the un-offered option ────────────────────────────────────────── */

test("an un-offered action is discarded, never chosen", () => {
  const questions = compileQuestions(ORDER_ACTIONS, { text: "", candidates: { order: { A1: "lamp" } } });
  const raw = { answers: {
    [ACTION_Q]: { choice: "refund_everything", probabilities: { refund_everything: 0.9, ship_cheapest: 0.1 } },
    [paramQ("ship_cheapest", "order")]: { choice: "Z9", probabilities: { Z9: 0.7, A1: 0.3 } },
    [GOAL_Q]: { noul: 0.1 },
  } };
  const { answers, discarded } = parseAnswers(raw, questions);
  assert.equal(answers[ACTION_Q].choice, "ship_cheapest");
  assert.deepEqual(discarded[ACTION_Q], ["refund_everything"]);
  assert.deepEqual(discarded[paramQ("ship_cheapest", "order")], ["Z9"]);
  // Not renormalised: the discarded mass lowers confidence rather than vanishing.
  assert.equal(answers[ACTION_Q].probabilities.ship_cheapest, 0.1);
  const d = decide(answers, ORDER_ACTIONS);
  assert.equal(d.action, "ship_cheapest");
  assert.equal(d.params.order, "A1");
  assert.equal(gate(d, ORDER_ACTIONS).pass, false);
});

test("a reply naming only un-offered options yields no answer at all", () => {
  const questions = { pick: { type: "choice", instructions: "", criteria: { a: "", b: "" } } };
  const r = parseAnswers({ pick: { choice: "c", probabilities: { c: 1 } } }, questions);
  assert.equal(r.answers.pick, undefined);
  assert.deepEqual(r.discarded.pick, ["c"]);
  assert.equal(r.problems.length, 1);
});

/* ── gate ────────────────────────────────────────────────────────────────── */

test("the gate refuses when the weakest required probability is below the risk threshold", () => {
  const answers = {
    [ACTION_Q]: { type: "choice", choice: "cancel_fraud", probabilities: { cancel_fraud: 0.95 }, discarded: [] },
    [paramQ("cancel_fraud", "order")]: { type: "choice", choice: "B2", probabilities: { B2: 0.79 }, discarded: [] },
  };
  const d = decide(answers, ORDER_ACTIONS);
  assert.equal(d.weakest.question, paramQ("cancel_fraud", "order"));
  const g = gate(d, ORDER_ACTIONS);
  assert.equal(g.threshold, DEFAULT_THRESHOLDS.destructive);
  assert.equal(g.pass, false);
  // The same numbers pass a write-level gate: the threshold is per risk.
  assert.equal(gate(d, ORDER_ACTIONS, { ...DEFAULT_THRESHOLDS, destructive: 0.6 }).pass, true);
});

test("finishing is gated on the goal check too", () => {
  const answers = { [ACTION_Q]: { type: "choice", choice: "done", probabilities: { done: 0.99 }, discarded: [] }, [GOAL_Q]: { type: "noul", p: 0.2 } };
  const d = decide(answers, ORDER_ACTIONS);
  assert.equal(d.weakest.question, GOAL_Q);
  assert.equal(gate(d, ORDER_ACTIONS).pass, false);
});

/* ── run-state machine ───────────────────────────────────────────────────── */

test("the scripted decider completes the order desk with no mistakes", async () => {
  const env = createOrderDesk();
  const r = await runSystemOne({ goal: ORDER_DESK_GOAL, env, decider: scriptedOrderDecider(), now: clock() });
  assert.equal(r.status, "completed");
  assert.equal(r.steps.length, 4);
  assert.deepEqual(env.mistakes(), []);
  assert.deepEqual(env.processed(), { A1: "ship_fastest_gift", B2: "cancel_fraud", C3: "ship_cheapest" });
  assert.ok(r.steps.every((s) => s.latencyMs === 7 && s.decider === "scripted"));
});

test("three consecutive refusals end the run as no_confident_action", async () => {
  const env = createOrderDesk();
  // 0.55 clears nothing above write (0.6), so every step is refused.
  const r = await runSystemOne({ goal: ORDER_DESK_GOAL, env, decider: scriptedOrderDecider(undefined, 0.55), now: clock() });
  assert.equal(r.status, "incomplete");
  assert.equal(r.reason, "no_confident_action");
  assert.equal(r.steps.length, MAX_REFUSALS);
  assert.deepEqual(r.steps.map((s) => s.verdict), ["refused", "refused", "denied"]);
  assert.ok(r.handoff && r.handoff.questions[ACTION_Q] && r.handoff.answers[ACTION_Q]);
  assert.deepEqual(env.processed(), {}, "nothing was executed");
});

test("a human approval on escalation executes and resets the refusal count", async () => {
  const env = createOrderDesk();
  let asked = 0;
  const r = await runSystemOne({ goal: ORDER_DESK_GOAL, env, decider: scriptedOrderDecider(undefined, 0.55), now: clock(), maxSteps: 6, escalate: async () => { asked++; return "approve"; } });
  assert.equal(asked, 2);
  assert.deepEqual(r.steps.map((s) => s.verdict), ["refused", "refused", "approved", "refused", "refused", "approved"]);
  assert.equal(r.status, "incomplete");
  assert.equal(r.reason, "max_steps");
});

test("a decider error fails the run and an abort cancels it", async () => {
  const bad = { kind: "jev", label: "x", decide: async () => { throw new Error("HTTP 401"); } };
  const r = await runSystemOne({ goal: "g", env: createOrderDesk(), decider: bad, now: clock() });
  assert.equal(r.status, "failed");
  assert.match(r.reason, /HTTP 401/);
  const ac = new AbortController(); ac.abort();
  const c = await runSystemOne({ goal: "g", env: createOrderDesk(), decider: scriptedOrderDecider(), now: clock(), signal: ac.signal });
  assert.equal(c.status, "cancelled");
});

/* ── emulated decider ────────────────────────────────────────────────────── */

test("a messy emulated reply still parses", () => {
  const reply = "Sure! Here is my assessment:\n```json\n{\n  “answers”: {\n    \"action\": {\"choice\": \"ship_cheapest\", \"probabilities\": {\"ship_cheapest\": 70, \"done\": 20, \"teleport\": 10},},\n    \"goal_met\": {\"noul\": \"0.1\"},\n    \"note\": \"a } inside a string\",\n  }\n}\n```\nLet me know if you need anything else.";
  const raw = parseEmulatedReply(reply);
  assert.ok(raw);
  const questions = { action: { type: "choice", instructions: "", criteria: { ship_cheapest: "", done: "" } }, goal_met: { type: "noul", instructions: "" } };
  const { answers, discarded } = parseAnswers(raw, questions);
  assert.equal(answers.action.choice, "ship_cheapest");
  assert.equal(answers.action.probabilities.ship_cheapest, 0.7);
  assert.deepEqual(discarded.action, ["teleport"]);
  assert.equal(answers.goal_met.p, 0.1);
});

test("an unparseable emulated reply is null, not a guess", () => {
  assert.equal(parseEmulatedReply("I think you should ship it."), null);
  assert.equal(parseEmulatedReply("{ not json"), null);
});

test("the emulated prompt lists every option key", () => {
  const p = buildEmulatedPrompt("S", routerQuestions());
  for (const k of ["agent_loop", "react", "aios_chat", "system_one", "direct", "zip", "fit__direct"]) assert.ok(p.includes(k), k);
});

/* ── router ──────────────────────────────────────────────────────────────── */

test("the router discards an un-offered harness and picks by fit", () => {
  const q = routerQuestions();
  const raw = { answers: {
    [fitQ("agent_loop")]: { noul: 0.8 }, [fitQ("react")]: { noul: 0.6 }, [fitQ("aios_chat")]: { noul: 0.1 },
    [fitQ("system_one")]: { noul: 0.05 }, [fitQ("direct")]: { noul: 0.7 },
    primary: { choice: "gpt_magic", probabilities: { gpt_magic: 0.5, agent_loop: 0.45, direct: 0.05 } },
    difficulty: { score: 2.4, probabilities: [0, 0.1, 0.5, 0.3, 0.1] },
    shape: { choice: "zip", probabilities: { zip: 0.8, folder: 0.2 } },
  } };
  const plan = planRoute(raw, q);
  assert.equal(plan.primary.id, "agent_loop");
  assert.deepEqual(plan.discarded.primary, ["gpt_magic"]);
  assert.deepEqual(plan.selected.map((s) => s.id), ["agent_loop", "direct", "react"]);
  assert.equal(plan.difficulty.label, "moderate");
  assert.equal(plan.shape.shape, "zip");
});

test("a low-confidence primary falls back to direct", () => {
  const plan = planRoute({ primary: { choice: "react", probabilities: { react: 0.3, direct: 0.2 } } }, routerQuestions());
  assert.equal(plan.primary.id, "direct");
  assert.match(plan.fallback, /falling back/);
});

test("combined files parse, and paths cannot escape the folder", () => {
  const text = "Summary.\n<<<FILE index.html>>>\n<h1>Hi</h1>\n<<<END>>>\n<<<FILE ../etc/passwd>>>\nx\n<<<END>>>\n<<<FILE src/app.js>>>\nconsole.log(1)\n<<<END>>>";
  assert.deepEqual(parseCombinedFiles(text).map((f) => f.path), ["index.html", "src/app.js"]);
  assert.equal(safePath("a/../b"), null);
  assert.equal(slugify("  Build me: a Todo App!  "), "build-me-a-todo-app");
});

test("save plans put each shape where it belongs", () => {
  assert.equal(savePlan("Hello there", "answer", "# Hi").primaryPath, "/router/hello-there.md");
  const files = "<<<FILE README.md>>>\nr\n<<<END>>>\n<<<FILE index.html>>>\n<p>x</p>\n<<<END>>>";
  const app = savePlan("my app", "app", files);
  assert.equal(app.primaryPath, "/router/my-app/index.html");
  assert.equal(app.zip.name, "my-app.zip");
  assert.deepEqual(app.zip.entries.map((e) => e.path), ["my-app/README.md", "my-app/index.html"]);
  assert.equal(savePlan("one", "file", files).writes.length, 1);
  assert.equal(savePlan("f", "folder", files).zip, null);
});

test("the router zip is a stored archive with correct signatures and CRCs", () => {
  const plan = savePlan("zip me", "zip", "<<<FILE a.txt>>>\n123456789\n<<<END>>>");
  const z = makeZip(plan.zip.entries, new Date(2026, 8, 23, 12, 0, 0));
  const u16 = (o) => z[o] | (z[o + 1] << 8);
  const u32 = (o) => (z[o] | (z[o + 1] << 8) | (z[o + 2] << 16) | (z[o + 3] << 24)) >>> 0;
  assert.deepEqual([...z.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  assert.equal(u16(8), 0, "method 0 = stored");
  // CRC-32 of "123456789" is the published check value.
  assert.equal(u32(14), 0xcbf43926);
  assert.equal(u32(14), crc32(new TextEncoder().encode("123456789")));
  assert.deepEqual([...z.slice(z.length - 22, z.length - 18)], [0x50, 0x4b, 0x05, 0x06]);
});
