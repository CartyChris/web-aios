/**
 * Regressions for the defects the 2026-09-25 review confirmed (2 of 3
 * skeptics) and that were recovered from the workflow's saved output after
 * its fix agents died at the session limit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DshContext } from "../.test-build/dsh/context.js";
import { DshLog, deriveMessages } from "../.test-build/dsh/session.js";
import { runTurn } from "../.test-build/dsh/loop.js";
import { approvalPlugin, skillsPlugin } from "../.test-build/dsh/policy.js";

let t = 0;
const clock = () => (t += 10);
const TOOLS = [
  { name: "write_file", description: "write", risk: "write", parameters: { type: "object", properties: {} }, run: async () => "ok" },
];
const deps = (ctx, log, model, extra = {}) => ({ ctx, log, model, tools: () => TOOLS, system: () => "SYS", clock, ...extra });

test("Stop in the middle of a two-call step: every call still gets a result", async () => {
  const ctx = new DshContext();
  const ac = new AbortController();
  // Approving the first call is where the user presses Stop.
  ctx.plugin(approvalPlugin({ preset: () => "ask", approve: async () => { ac.abort(); return true; } }));
  const log = new DshLog(clock);
  const replies = [{ text: "", toolCalls: [{ id: "a", name: "write_file", args: "{}" }, { id: "b", name: "write_file", args: "{}" }] }];
  const r = await runTurn("go", deps(ctx, log, async () => replies.shift(), { signal: ac.signal }));
  assert.equal(r.reason, "cancelled");
  const answered = new Set(log.events.filter((e) => e.type === "tool/result").map((e) => e.data.callId));
  assert.ok(answered.has("a") && answered.has("b"), "call b was left without a result");
  const { messages } = deriveMessages(log.events);
  for (const m of messages.filter((x) => x.toolCalls)) for (const c of m.toolCalls) assert.ok(answered.has(c.id));
});

test("deriveMessages drops empty assistant replies and unanswered calls", () => {
  const log = new DshLog(clock);
  log.append("turn/start", {});
  log.append("user/message", { text: "hi" });
  log.append("assistant/message", { text: "" });
  log.append("assistant/message", { text: "", toolCalls: [{ id: "lost", name: "write_file", args: "{}" }] });
  log.append("turn/end", { reason: "done" });
  const roles = deriveMessages(log.events).messages.map((m) => m.role);
  assert.deepEqual(roles, ["user"]);
});

test("reasoning goes back only for tool-call turns inside the current turn (DeepSeek)", () => {
  const log = new DshLog(clock);
  log.append("turn/start", {});
  log.append("assistant/message", { text: "", reasoning: "old", toolCalls: [{ id: "x", name: "write_file", args: "{}" }] });
  log.append("tool/result", { callId: "x", name: "write_file", content: "ok" });
  log.append("turn/end", {});
  log.append("turn/start", {});
  log.append("assistant/message", { text: "", reasoning: "new", toolCalls: [{ id: "y", name: "write_file", args: "{}" }] });
  log.append("tool/result", { callId: "y", name: "write_file", content: "ok" });
  const asst = deriveMessages(log.events).messages.filter((m) => m.role === "assistant");
  assert.equal(asst[0].reasoning, undefined);
  assert.equal(asst[1].reasoning, "new");
});

test("a message that starts with a file path is not rejected as an unknown skill", async () => {
  const ctx = new DshContext();
  ctx.plugin(skillsPlugin(() => [{ name: "review", body: "Review carefully." }]));
  const seen = [];
  const run = (input) => runTurn(input, deps(ctx, new DshLog(clock), async (req) => { seen.push(req.messages.at(-1).content); return { text: "ok" }; }));
  assert.equal((await run("/Documents/plan.md add a deadline")).reason, "done");
  assert.equal(seen.at(-1), "/Documents/plan.md add a deadline");
  assert.equal((await run("/nosuch do it")).reason, "done", "unknown names pass through");
  await run("/review this");
  assert.match(seen.at(-1), /^\[Skill: review\]/);
});
