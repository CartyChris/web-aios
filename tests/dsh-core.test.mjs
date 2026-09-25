/**
 * dsh-lite pure core: plugin context, session log, turn/step loop, approval,
 * compaction, goals, Ralph, skills. Driven by a scripted fake model; no
 * network, no clock.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DshContext, DshWaterfallError } from "../.test-build/dsh/context.js";
import { DshLog, deriveMessages, forkSeed, repairTail, toJsonl, fromJsonl, turnBounds } from "../.test-build/dsh/session.js";
import { runTurn } from "../.test-build/dsh/loop.js";
import { approvalPlugin, validationPlugin, compactionPlugin, runGoal, runRalph, parseVerdict, skillsPlugin, planPrune, needsApproval } from "../.test-build/dsh/policy.js";

let t = 0;
const clock = () => (t += 10);

/** A model that replays scripted replies in order and records requests. */
function scripted(replies) {
  const seen = [];
  const fn = async (req) => {
    seen.push(JSON.parse(JSON.stringify({ system: req.system, messages: req.messages, tools: req.tools.map((x) => x.name) })));
    const r = replies.shift();
    if (!r) throw new Error("script exhausted");
    if (r instanceof Error) throw r;
    return r;
  };
  fn.seen = seen;
  return fn;
}

const files = new Map();
const TOOLS = [
  { name: "read_file", description: "read", risk: "read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    run: async (a) => files.get(a.path) ?? `No such file ${a.path}` },
  { name: "write_file", description: "write", risk: "write", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    run: async (a) => { files.set(a.path, a.content); return `wrote ${a.content.length} chars to ${a.path}`; } },
];
const simpleValidate = (schema, v) => (schema.required ?? []).filter((k) => !(k in v)).map((k) => `missing ${k}`);

function deps(ctx, log, model, extra = {}) {
  return { ctx, log, model, tools: () => TOOLS, system: () => "SYS", clock, ...extra };
}

test("waterfall: a listener that neither calls next() nor returns throws", async () => {
  const ctx = new DshContext();
  ctx.waterfall("x", async () => { /* forgot next() */ });
  await assert.rejects(ctx.run("x", 1, async (p) => p + 1), DshWaterfallError);
});

test("waterfall: listeners compose in order and can rewrite the payload", async () => {
  const ctx = new DshContext();
  ctx.waterfall("x", (p, next) => next(p * 10));
  ctx.waterfall("x", (p, next) => next(p + 1));
  assert.equal(await ctx.run("x", 2, async (p) => `t${p}`), "t21");
});

test("unloading a plugin unwinds every registration it made (no leaks)", async () => {
  const ctx = new DshContext();
  const base = ctx.registrationCount();
  ctx.plugin({ name: "p", description: "", apply(c) {
    c.provide("svc", { a: 1 });
    c.on("e", () => 1);
    c.waterfall("w", (p, next) => next(p));
    c.waterfall("w2", (p, next) => next(p));
  } });
  assert.equal(ctx.registrationCount(), base + 4);
  assert.equal(ctx.effectsOf("p").length, 4);
  ctx.unload("p");
  assert.equal(ctx.registrationCount(), base, "every effect was disposed");
  assert.equal(ctx.get("svc"), undefined);
  assert.deepEqual(await ctx.emit("e", 0), []);
  assert.equal(ctx.isLoaded("p"), false);
  // reload works (the service name is free again)
  ctx.plugin({ name: "p", description: "", apply(c) { c.provide("svc", 2); } });
  assert.equal(ctx.get("svc"), 2);
});

test("a plugin whose apply() throws is rolled back", () => {
  const ctx = new DshContext();
  assert.throws(() => ctx.plugin({ name: "bad", description: "", apply(c) { c.on("e", () => 1); throw new Error("boom"); } }));
  assert.equal(ctx.registrationCount(), 0);
  assert.equal(ctx.isLoaded("bad"), false);
});

test("deriveMessages: failed attempts never become model history", () => {
  const log = new DshLog(clock);
  log.append("system/message", { text: "S" });
  log.append("user/message", { text: "hi" });
  log.append("assistant/attempt", { text: "half an answer", reason: "error", error: "503" });
  log.append("assistant/message", { text: "hello" });
  const d = deriveMessages(log.events);
  assert.equal(d.system, "S");
  assert.deepEqual(d.messages.map((m) => [m.role, m.content]), [["user", "hi"], ["assistant", "hello"]]);
});

test("runTurn: tool call, result, answer - exact durable event order", async () => {
  files.clear();
  files.set("/a.txt", "alpha");
  const ctx = new DshContext();
  const log = new DshLog(clock);
  const model = scripted([
    { text: "", toolCalls: [{ id: "c1", name: "read_file", args: "{\"path\":\"/a.txt\"}" }] },
    { text: "It says alpha." },
  ]);
  const r = await runTurn("what is in a.txt", deps(ctx, log, model));
  assert.equal(r.reason, "done");
  assert.equal(r.steps, 2);
  assert.deepEqual(log.events.map((e) => e.type), [
    "turn/start", "step/start", "system/message", "user/message", "assistant/message", "tool/call", "tool/result", "step/end",
    "step/start", "assistant/message", "step/end", "turn/end",
  ]);
  const res = log.events.find((e) => e.type === "tool/result");
  assert.equal(res.data.content, "alpha");
  // the second request was derived from the log and carries the tool result
  assert.deepEqual(model.seen[1].messages.map((m) => m.role), ["user", "assistant", "tool"]);
  assert.equal(model.seen[1].messages[2].toolCallId, "c1");
});

test("runTurn: model error is retried once and logged as assistant/attempt, not history", async () => {
  const ctx = new DshContext();
  const log = new DshLog(clock);
  const r = await runTurn("hi", deps(ctx, log, scripted([new Error("503 overloaded"), { text: "ok" }])));
  assert.equal(r.reason, "done");
  assert.equal(log.events.filter((e) => e.type === "assistant/attempt").length, 1);
  assert.deepEqual(deriveMessages(log.events).messages.map((m) => m.content), ["hi", "ok"]);
});

test("runTurn: cancellation closes the turn as cancelled", async () => {
  const ctx = new DshContext();
  const log = new DshLog(clock);
  const ac = new AbortController();
  const model = async () => { ac.abort(); return { text: "late" }; };
  const r = await runTurn("hi", deps(ctx, log, model, { signal: ac.signal }));
  assert.equal(r.reason, "cancelled");
  assert.equal(log.last("turn/end").data.reason, "cancelled");
  assert.equal(log.events.some((e) => e.type === "assistant/message"), false);
});

test("approval: auto-read runs reads, denied write is blocked and never executes", async () => {
  files.clear();
  const ctx = new DshContext();
  const asked = [];
  ctx.plugin(approvalPlugin({ preset: () => "auto-read", approve: async (p) => { asked.push(p.name); return false; } }));
  const log = new DshLog(clock);
  const model = scripted([
    { text: "", toolCalls: [{ id: "r", name: "read_file", args: "{\"path\":\"/x\"}" }, { id: "w", name: "write_file", args: "{\"path\":\"/x\",\"content\":\"y\"}" }] },
    { text: "done" },
  ]);
  await runTurn("go", deps(ctx, log, model));
  assert.deepEqual(asked, ["write_file"]);
  const results = log.events.filter((e) => e.type === "tool/result");
  assert.equal(results[0].data.approval, "auto");
  assert.equal(results[1].data.approval, "denied");
  assert.equal(results[1].data.isError, true);
  assert.equal(files.has("/x"), false, "denied write did not run");
  assert.equal(needsApproval("auto-all", { name: "write_file", risk: "destructive" }), false);
  assert.equal(needsApproval("ask", { name: "read_file", risk: "read" }), true);
});

test("approval unloaded live: the same write now runs (reversible effect)", async () => {
  files.clear();
  const ctx = new DshContext();
  ctx.plugin(approvalPlugin({ preset: () => "ask", approve: async () => false }));
  ctx.unload("approval");
  const log = new DshLog(clock);
  await runTurn("go", deps(ctx, log, scripted([{ text: "", toolCalls: [{ id: "w", name: "write_file", args: "{\"path\":\"/z\",\"content\":\"q\"}" }] }, { text: "ok" }])));
  assert.equal(files.get("/z"), "q");
});

test("validation: bad args are an error result the model sees; bad JSON too", async () => {
  const ctx = new DshContext();
  ctx.plugin(validationPlugin(simpleValidate));
  const log = new DshLog(clock);
  await runTurn("go", deps(ctx, log, scripted([
    { text: "", toolCalls: [{ id: "a", name: "read_file", args: "{}" }, { id: "b", name: "read_file", args: "{nope" }, { id: "c", name: "nope", args: "{}" }] },
    { text: "sorry" },
  ])));
  const res = log.events.filter((e) => e.type === "tool/result").map((e) => e.data.content);
  assert.match(res[0], /missing path/);
  assert.match(res[1], /not valid JSON/);
  assert.match(res[2], /Unknown tool/);
});

test("pre-step rejection closes the turn with no step", async () => {
  const ctx = new DshContext();
  ctx.waterfall("agent/pre-step", (p, next) => next({ ...p, reject: "nope" }));
  const log = new DshLog(clock);
  const r = await runTurn("x", deps(ctx, log, scripted([])));
  assert.equal(r.reason, "rejected");
  assert.deepEqual(log.events.map((e) => e.type), ["turn/start", "turn/end"]);
});

test("fork at a turn boundary, repair an interrupted tail, JSONL round trip", async () => {
  const ctx = new DshContext();
  const log = new DshLog(clock);
  await runTurn("one", deps(ctx, log, scripted([{ text: "1" }])));
  await runTurn("two", deps(ctx, log, scripted([{ text: "2" }])));
  assert.equal(turnBounds(log.events).length, 2);
  const seed = forkSeed(log.events, 0);
  const child = new DshLog(clock, seed);
  assert.equal(child.last("turn/end").seq, seed.length - 1);
  assert.deepEqual(deriveMessages(child.events).messages.map((m) => m.content), ["one", "1"]);
  assert.throws(() => forkSeed(log.events, 5));

  const broken = new DshLog(clock, child.events);
  broken.append("turn/start", { input: "three" });
  broken.append("tool/call", { callId: "k", name: "read_file", args: "{}" });
  const fixes = repairTail(broken.events);
  assert.deepEqual(fixes.map((f) => f.type), ["tool/result", "turn/end"]);
  assert.equal(fixes[1].data.reason, "interrupted");
  assert.deepEqual(repairTail(log.events), []);

  const text = toJsonl({ id: "s1", title: "t", created: 1 }, log.events);
  const back = fromJsonl(text);
  assert.equal(back.meta.id, "s1");
  assert.deepEqual(back.events, JSON.parse(JSON.stringify(log.events)));
  assert.throws(() => fromJsonl(text.replace("\"seq\":3", "\"seq\":9")), /seq gap/);
});

test("compaction: old long tool results are pruned and history past threshold is summarized, both logged", async () => {
  const ctx = new DshContext();
  const log = new DshLog(clock);
  const big = "x".repeat(500);
  files.clear(); files.set("/big", big);
  const summaries = [];
  ctx.plugin(compactionPlugin({
    log: () => log,
    prune: { thresholdChars: 100, headChars: 10, tailChars: 5, keepRecent: 1, marker: "[..]" },
    estimate: (s, ms) => ms.reduce((n, m) => n + JSON.stringify(m).length, s.length) / 4,
    window: () => 400,
    thresholdRatio: 0.5,
    summarize: async (tx) => { summaries.push(tx); return "SUMMARY"; },
  }));
  const model = scripted([
    { text: "", toolCalls: [{ id: "1", name: "read_file", args: "{\"path\":\"/big\"}" }] },
    { text: "", toolCalls: [{ id: "2", name: "read_file", args: "{\"path\":\"/big\"}" }] },
    { text: "read twice" },
    { text: "second turn answer" },
  ]);
  await runTurn("read big twice", deps(ctx, log, model));
  const prune = log.events.find((e) => e.type === "compaction/prune");
  assert.ok(prune, "the older result was pruned");
  assert.equal(prune.data.replacements[0].content, "xxxxxxxxxx[..]xxxxx");
  await runTurn("next", deps(ctx, log, model));
  const sum = log.last("compaction/summary");
  assert.ok(sum, "a second turn over the threshold was summarized");
  const d = deriveMessages(log.events);
  assert.match(d.messages[0].content, /SUMMARY/);
  assert.equal(d.messages.at(-1).content, "second turn answer");
  // the summarized request is what the model actually saw
  assert.match(model.seen.at(-1).messages[0].content, /SUMMARY/);
  assert.equal(planPrune(log, { thresholdChars: 100, headChars: 10, tailChars: 5, keepRecent: 0, marker: "" }).replacements.length, 1, "already-pruned results are not pruned twice");
});

test("goal: the model saying 'done' does not end it; only the judge does, from logged evidence", async () => {
  files.clear();
  const ctx = new DshContext();
  const log = new DshLog(clock);
  const model = scripted([
    { text: "GOAL COMPLETE. I am done." },                                                   // round 1: claims, no evidence
    { text: "", toolCalls: [{ id: "w", name: "write_file", args: "{\"path\":\"/out.txt\",\"content\":\"42\"}" }] },
    { text: "wrote it" },                                                                     // round 2: real evidence
  ]);
  const judged = [];
  const res = await runGoal({
    log, objective: "write 42 to /out.txt", maxRounds: 4, judgeName: "test-judge",
    turn: (input) => runTurn(input, deps(ctx, log, model)),
    judge: async (_o, ev) => { judged.push(ev); return /wrote 2 chars to \/out.txt/.test(ev) ? { met: true, note: "file written" } : { met: false, note: "no write observed" }; },
  });
  assert.equal(res.status, "met");
  assert.equal(res.rounds, 2);
  const verdicts = log.events.filter((e) => e.type === "goal/verdict");
  assert.deepEqual(verdicts.map((v) => v.data.met), [false, true]);
  // round 2's prompt carried the attempt count and the judge's note
  const u2 = log.events.filter((e) => e.type === "user/message")[1].data.text;
  assert.match(u2, /attempt 1/);
  assert.match(u2, /no write observed/);
  assert.equal(log.last("goal/end").data.status, "met");
});

test("goal: exhausts honestly and parseVerdict fails closed", async () => {
  const ctx = new DshContext();
  const log = new DshLog(clock);
  const res = await runGoal({
    log, objective: "x", maxRounds: 2, judgeName: "j",
    turn: (input) => runTurn(input, deps(ctx, log, scripted([{ text: "done!" }]).bind(null))),
    judge: async () => ({ met: false, note: "no" }),
  }).catch((e) => e);
  // second round's scripted model is exhausted -> error turn, still judged, still not met
  assert.equal(res.status, "exhausted");
  assert.deepEqual(parseVerdict("sure, it's met"), { met: false, note: "judge reply was not JSON" });
  assert.deepEqual(parseVerdict("{\"met\": \"yes\"}").met, false);
  assert.deepEqual(parseVerdict("{\"met\": true, \"note\": \"ok\"}"), { met: true, note: "ok" });
});

test("ralph: a worker's 'complete' is re-checked; rejection carries into the next fresh round", async () => {
  const prompts = [];
  const replies = [
    "{\"status\":\"complete\",\"summary\":\"all done\",\"evidence\":\"trust me\",\"next\":\"\"}",
    "{\"status\":\"complete\",\"summary\":\"file written\",\"evidence\":\"/f has 3 lines\",\"next\":\"\"}",
  ];
  const r = await runRalph({
    objective: "make /f", maxRounds: 5,
    round: async (p) => { prompts.push(p); return { text: replies.shift(), evidence: "" }; },
    judge: async (_o, ev) => (/3 lines/.test(ev) ? { met: true, note: "" } : { met: false, note: "no evidence" }),
  });
  assert.equal(r.status, "complete");
  assert.equal(r.rounds, 2);
  assert.match(prompts[1], /Harness judge rejected/);
  assert.match(prompts[1], /fresh agent/);
});

test("skills: /name expands in pre-step; unloading restores the raw input", async () => {
  const ctx = new DshContext();
  ctx.plugin(skillsPlugin(() => [{ name: "terse", body: "Answer in one word." }]));
  const log = new DshLog(clock);
  const model = scripted([{ text: "Yes" }, { text: "Long answer" }]);
  await runTurn("/terse is water wet", deps(ctx, log, model));
  assert.match(model.seen[0].messages[0].content, /Answer in one word\.[\s\S]*is water wet/);
  ctx.unload("skills");
  await runTurn("/terse again", deps(ctx, log, model));
  assert.equal(model.seen[1].messages.at(-1).content, "/terse again");
});

test("JSON tool protocol fallback: parse, flatten, and drive a full turn", async () => {
  const { parseJsonProtocolReply, flattenForJsonProtocol, jsonProtocolSystem } = await import("../.test-build/dsh/loop.js");
  assert.deepEqual(parseJsonProtocolReply("```json\n{\"tool\":\"read_file\",\"args\":{\"path\":\"/a\"}}\n```", "j1").toolCalls, [{ id: "j1", name: "read_file", args: "{\"path\":\"/a\"}" }]);
  assert.equal(parseJsonProtocolReply("{\"final\":\"hi {there}\"}", "x").text, "hi {there}");
  assert.equal(parseJsonProtocolReply("just prose", "x").text, "just prose");
  const flat = flattenForJsonProtocol([
    { role: "assistant", content: "", toolCalls: [{ id: "1", name: "read_file", args: "{\"path\":\"/a\"}" }] },
    { role: "tool", content: "alpha", toolCallId: "1", toolName: "read_file" },
  ]);
  assert.deepEqual(flat.map((m) => m.role), ["assistant", "user"]);
  assert.match(flat[1].content, /Tool result \(read_file\)/);
  assert.match(jsonProtocolSystem("S", [{ name: "t", description: "d", parameters: {} }]), /- t: d/);
});
