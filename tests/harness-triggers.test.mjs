/* Layer 1 — triggers.
 *
 * The thing worth testing about a trigger layer is not that it fires. It is
 * that it can be shown NOT to fire for a stated reason, because the failure
 * mode of every trigger system is silence, and silence from a typo and silence
 * from a correctly-suppressed duplicate are the same silence.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSchedule, nextDue, isDue, eventMatches, pathMatches, renderObjective,
  dedupeKeyFor, createDedupeLedger, validateTrigger, decideFire, newTrigger,
  MIN_INTERVAL_MS,
} from "../.test-build/harness/triggers.js";

const T0 = 1_776_254_400_000; // a fixed instant; every clock here is injected

const spec = (patch = {}) => newTrigger({
  id: "trg_1",
  createdAt: T0,
  kind: "event",
  match: "artifact:created",
  enabled: true,
  objectiveTemplate: "Summarise {{payload.path}}",
  ...patch,
});

const fire = (patch = {}, over = {}) => decideFire({
  spec: spec(patch),
  kind: over.kind ?? spec(patch).kind,
  signal: "artifact:created",
  payload: { path: "/notes/a.md" },
  now: T0,
  dedupeMs: 60_000,
  ledger: createDedupeLedger(),
  ...over,
});

/* ── schedule grammar ────────────────────────────────────────────────────── */

test("every:<n><unit> parses for every supported unit", () => {
  assert.deepEqual(parseSchedule("every:15m").schedule, { kind: "every", ms: 900_000 });
  assert.deepEqual(parseSchedule("every:2h").schedule, { kind: "every", ms: 7_200_000 });
  assert.deepEqual(parseSchedule("every:1d").schedule, { kind: "every", ms: 86_400_000 });
  assert.deepEqual(parseSchedule("EVERY:15M").schedule, { kind: "every", ms: 900_000 }, "case must not matter");
});

test("an interval below the floor is refused, and the error names the floor", () => {
  const r = parseSchedule("every:5s");
  assert.equal(r.ok, false);
  assert.match(r.error, new RegExp(`${MIN_INTERVAL_MS / 1000}s minimum`));
  // The floor is exclusive-below, so exactly the floor is allowed.
  assert.equal(parseSchedule("every:60s").ok, true);
});

test("at:HH:MM parses and rejects impossible times", () => {
  assert.deepEqual(parseSchedule("at:09:30").schedule, { kind: "at", hour: 9, minute: 30 });
  assert.deepEqual(parseSchedule("at:9:05").schedule, { kind: "at", hour: 9, minute: 5 });
  assert.equal(parseSchedule("at:24:00").ok, false);
  assert.equal(parseSchedule("at:12:60").ok, false);
});

test("garbage is refused with a message that says what the grammar is", () => {
  const r = parseSchedule("* * * * *");
  assert.equal(r.ok, false);
  assert.match(r.error, /every:15m/);
  assert.equal(parseSchedule("").ok, false);
  assert.equal(parseSchedule("every:0m").ok, false);
});

/* ── due-ness against an injected clock ──────────────────────────────────── */

test("an interval schedule that has never fired is due immediately", () => {
  assert.equal(nextDue({ kind: "every", ms: 900_000 }, undefined, T0), T0);
});

test("an interval schedule is due exactly one interval after it last fired", () => {
  assert.equal(nextDue({ kind: "every", ms: 900_000 }, T0, T0), T0 + 900_000);
  assert.equal(isDue(spec({ kind: "schedule", match: "every:15m", lastFiredAt: T0 }), T0 + 899_999), false);
  assert.equal(isDue(spec({ kind: "schedule", match: "every:15m", lastFiredAt: T0 }), T0 + 900_000), true);
});

test("a daily time that has already passed today and has not fired is due now, not tomorrow", () => {
  // A missed digest must still arrive. Silently rolling to tomorrow is how a
  // daily job quietly becomes a job that runs on days you happen to be online.
  const now = new Date(2026, 8, 16, 14, 0, 0).getTime();
  const due = nextDue({ kind: "at", hour: 9, minute: 30 }, undefined, now);
  assert.equal(due, new Date(2026, 8, 16, 9, 30, 0).getTime());
  assert.ok(due <= now, "a missed daily slot should be due immediately");
});

test("a daily time that already fired in today's slot rolls to tomorrow", () => {
  const now = new Date(2026, 8, 16, 14, 0, 0).getTime();
  const firedToday = new Date(2026, 8, 16, 9, 30, 0).getTime();
  const due = nextDue({ kind: "at", hour: 9, minute: 30 }, firedToday, now);
  assert.equal(due, new Date(2026, 8, 17, 9, 30, 0).getTime());
});

test("a daily time still ahead of now is due later today", () => {
  const now = new Date(2026, 8, 16, 7, 0, 0).getTime();
  assert.equal(nextDue({ kind: "at", hour: 9, minute: 30 }, undefined, now), new Date(2026, 8, 16, 9, 30, 0).getTime());
});

test("an unparseable schedule never fires rather than firing constantly", () => {
  // Fail closed: the alternative is a typo that bills on every tick.
  assert.equal(isDue(spec({ kind: "schedule", match: "* * * * *", enabled: true }), T0 + 1e9), false);
});

test("a disabled schedule is never due, however overdue it is", () => {
  assert.equal(isDue(spec({ kind: "schedule", match: "every:1m", enabled: false, lastFiredAt: 0 }), T0), false);
});

/* ── matching ────────────────────────────────────────────────────────────── */

test("an event pattern matches exactly, or on a prefix wildcard, or on *", () => {
  assert.equal(eventMatches("artifact:created", "artifact:created"), true);
  assert.equal(eventMatches("artifact:created", "artifact:deleted"), false);
  assert.equal(eventMatches("artifact:*", "artifact:created"), true);
  assert.equal(eventMatches("artifact:*", "artifactory:created"), false, "a prefix wildcard must respect the separator");
  assert.equal(eventMatches("*", "anything:at:all"), true);
});

test("a watched path matches on a segment boundary, not on a string prefix", () => {
  // /notes must not fire for /notes-archive: a different directory whose name
  // merely starts the same way.
  assert.equal(pathMatches("/notes", "/notes/a.md"), true);
  assert.equal(pathMatches("/notes", "/notes"), true);
  assert.equal(pathMatches("/notes", "/notes-archive/a.md"), false);
  assert.equal(pathMatches("/notes/", "/notes/a.md"), true, "a trailing slash must not change the meaning");
  assert.equal(pathMatches("/", "/anything"), true);
});

/* ── objective templating ────────────────────────────────────────────────── */

const ev = (payload, at = T0) => ({ triggerId: "trg_1", kind: "event", at, payload, dedupeKey: "k" });

test("payload fields, the clock and the trigger id all substitute", () => {
  const out = renderObjective("At {{now}}, trigger {{trigger}} ({{kind}}) saw {{payload.path}}", ev({ path: "/notes/a.md" }));
  assert.match(out, /^At 2026-04-15T/);
  assert.match(out, /trigger trg_1 \(event\)/);
  assert.match(out, /saw \/notes\/a\.md/);
});

test("a nested payload field resolves", () => {
  assert.equal(renderObjective("{{payload.a.b.c}}", ev({ a: { b: { c: "deep" } } })), "deep");
});

test("an unresolved placeholder is LEFT STANDING, not silently blanked", () => {
  // An objective with a hole in it reads as a complete instruction and quietly
  // asks the wrong question; a visible {{payload.nope}} is a bug report.
  assert.equal(renderObjective("Check {{payload.nope}}", ev({ path: "/a" })), "Check {{payload.nope}}");
  assert.equal(renderObjective("Check {{bogus}}", ev({})), "Check {{bogus}}");
});

test("a whole payload substitutes as canonical JSON", () => {
  assert.equal(renderObjective("{{payload}}", ev({ b: 2, a: 1 })), '{"b":2,"a":1}');
});

test("a huge payload is truncated before it reaches the prompt", () => {
  const out = renderObjective("{{payload.blob}}", ev({ blob: "x".repeat(50_000) }));
  assert.ok(out.length < 2_200, `substitution was ${out.length} chars`);
  assert.match(out, /\[truncated\]$/);
});

test("a cyclic payload produces a note, not a crash", () => {
  const cyclic = { name: "a" };
  cyclic.self = cyclic;
  assert.equal(renderObjective("{{payload}}", ev(cyclic)), "[unserialisable payload]");
});

/* ── dedupe ──────────────────────────────────────────────────────────────── */

test("the dedupe key ignores key order, so the same logical event keys the same", () => {
  assert.equal(dedupeKeyFor("t", { a: 1, b: 2 }), dedupeKeyFor("t", { b: 2, a: 1 }));
  assert.notEqual(dedupeKeyFor("t", { a: 1 }), dedupeKeyFor("t", { a: 2 }));
  assert.notEqual(dedupeKeyFor("t1", { a: 1 }), dedupeKeyFor("t2", { a: 1 }));
});

test("the dedupe key is stable across nesting and arrays", () => {
  assert.equal(dedupeKeyFor("t", { x: [{ b: 1, a: 2 }] }), dedupeKeyFor("t", { x: [{ a: 2, b: 1 }] }));
});

test("the ledger admits once inside the window and again after it", () => {
  const l = createDedupeLedger();
  assert.equal(l.admit("k", T0, 60_000), true);
  assert.equal(l.admit("k", T0 + 59_999, 60_000), false);
  assert.equal(l.admit("k", T0 + 60_000, 60_000), true);
});

test("the ledger counts what it suppressed — a ledger that never refuses is unwired", () => {
  const l = createDedupeLedger();
  assert.equal(l.suppressed(), 0);
  l.admit("k", T0, 60_000);
  l.admit("k", T0 + 1, 60_000);
  l.admit("k", T0 + 2, 60_000);
  assert.equal(l.suppressed(), 2);
});

test("the ledger stays bounded under a chatty event source", () => {
  const l = createDedupeLedger();
  for (let i = 0; i < 5_000; i++) l.admit(`k${i}`, T0 + i, 60_000);
  assert.ok(l.size() <= 500, `ledger grew to ${l.size()}`);
});

/* ── validation ──────────────────────────────────────────────────────────── */

test("a trigger with no objective, no dod or no config is refused", () => {
  const r = validateTrigger(spec({ objectiveTemplate: "", dodId: "", configId: "" }));
  assert.equal(r.ok, false);
  assert.equal(r.reasons.length, 3);
  assert.ok(r.reasons.some((x) => /definition of done/.test(x)));
});

test("a schedule trigger with an unparseable match is refused at save time", () => {
  const r = validateTrigger(spec({ kind: "schedule", match: "0 9 * * *", objectiveTemplate: "Digest" }));
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(" "), /not a schedule/);
});

test("a schedule trigger referencing {{payload}} is refused — it has no payload", () => {
  const r = validateTrigger(spec({ kind: "schedule", match: "every:1h", objectiveTemplate: "Report on {{payload.x}}" }));
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(" "), /never resolve/);
});

test("a file trigger must watch an absolute path", () => {
  assert.equal(validateTrigger(spec({ kind: "file", match: "notes" })).ok, false);
  assert.equal(validateTrigger(spec({ kind: "file", match: "/notes", objectiveTemplate: "x" })).ok, true);
});

test("an event trigger with an empty match is refused", () => {
  assert.equal(validateTrigger(spec({ kind: "event", match: "" })).ok, false);
});

test("a well-formed trigger of every kind validates", () => {
  assert.equal(validateTrigger(spec({ kind: "event", match: "*", objectiveTemplate: "x" })).ok, true);
  assert.equal(validateTrigger(spec({ kind: "schedule", match: "at:09:30", objectiveTemplate: "Digest for {{now}}" })).ok, true);
  assert.equal(validateTrigger(spec({ kind: "manual", match: "", objectiveTemplate: "x" })).ok, true);
});

/* ── the decision, with a reason for every refusal ───────────────────────── */

test("a matching enabled event trigger fires and renders its objective", () => {
  const d = fire();
  assert.equal(d.fire, true);
  assert.equal(d.objective, "Summarise /notes/a.md");
  assert.equal(d.event.triggerId, "trg_1");
  assert.equal(d.event.at, T0);
  assert.ok(d.event.dedupeKey.length > 0);
});

test("every refusal carries a distinct machine reason AND a human detail", () => {
  const cases = [
    [fire({ enabled: false }), "disabled"],
    [fire({}, { kind: "file" }), "kind_mismatch"],
    [fire({}, { signal: "something:else" }), "no_match"],
    [fire({ objectiveTemplate: "" }), "invalid"],
  ];
  const reasons = new Set();
  for (const [d, expected] of cases) {
    assert.equal(d.fire, false);
    assert.equal(d.reason, expected);
    assert.ok(d.detail.length > 0, `${expected} gave no detail`);
    reasons.add(d.reason);
  }
  assert.equal(reasons.size, 4, "two different refusals share a reason code");
});

test("a repeated identical event is suppressed as a duplicate, with a reason", () => {
  const ledger = createDedupeLedger();
  const first = fire({}, { ledger });
  const second = fire({}, { ledger });
  assert.equal(first.fire, true);
  assert.equal(second.fire, false);
  assert.equal(second.reason, "duplicate");
  assert.match(second.detail, /within the last 60s/);
  assert.equal(ledger.suppressed(), 1);
});

test("a different payload on the same trigger is NOT a duplicate", () => {
  // The negative control for dedupe: it must still let real work through.
  const ledger = createDedupeLedger();
  assert.equal(fire({}, { ledger, payload: { path: "/notes/a.md" } }).fire, true);
  assert.equal(fire({}, { ledger, payload: { path: "/notes/b.md" } }).fire, true);
  assert.equal(ledger.suppressed(), 0);
});

test("the same payload fires again once the dedupe window has passed", () => {
  const ledger = createDedupeLedger();
  assert.equal(fire({}, { ledger }).fire, true);
  assert.equal(fire({}, { ledger, now: T0 + 60_001 }).fire, true);
});

test("a file trigger fires on a path under its prefix and not on a lookalike", () => {
  const base = { kind: "file", match: "/notes", objectiveTemplate: "Reread {{payload.path}}" };
  const hit = decideFire({ spec: spec(base), kind: "file", signal: "/notes/a.md", payload: { path: "/notes/a.md" }, now: T0, dedupeMs: 60_000, ledger: createDedupeLedger() });
  assert.equal(hit.fire, true);
  assert.equal(hit.objective, "Reread /notes/a.md");
  const miss = decideFire({ spec: spec(base), kind: "file", signal: "/notes-archive/a.md", payload: {}, now: T0, dedupeMs: 60_000, ledger: createDedupeLedger() });
  assert.equal(miss.fire, false);
  assert.equal(miss.reason, "no_match");
});

test("a scheduled trigger that is not yet due declines with a reason rather than silence", () => {
  const d = decideFire({
    spec: spec({ kind: "schedule", match: "every:15m", lastFiredAt: T0, objectiveTemplate: "Digest {{now}}" }),
    kind: "schedule", signal: "", payload: {}, now: T0 + 60_000, dedupeMs: 60_000, ledger: createDedupeLedger(),
  });
  assert.equal(d.fire, false);
  assert.equal(d.reason, "no_match");
  assert.equal(d.detail, "Not due yet.");
});

test("a new trigger is created disabled — a trigger that fires before you finish writing it is a bill", () => {
  assert.equal(newTrigger({ id: "t", createdAt: T0 }).enabled, false);
  assert.equal(newTrigger({ id: "t", createdAt: T0 }).firedCount, 0);
});
