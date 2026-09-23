/* AIOS Chat protocol: parsing model replies, gating side effects, and the
 * two artifacts the agent hands the user (an .ics file and a mailto: link).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseAgentReply, validateToolCall, needsApproval, toolSchemaText, agentSystemPrompt,
  buildIcs, toIcsDate, icsEscape, cleanRrule, eventsFromArgs, mailtoLink, slug, clip,
  describeCall, AGENT_TOOLS, MAX_AGENT_STEPS,
} from "../.test-build/aios-agent.js";

/* ── parsing ─────────────────────────────────────────────────────────────── */

test("a bare tool object parses", () => {
  const r = parseAgentReply('{"tool":"open_app","args":{"appId":"notes"}}');
  assert.deepEqual(r, { kind: "tool", tool: "open_app", args: { appId: "notes" } });
});

test("a fenced json block surrounded by prose parses", () => {
  const r = parseAgentReply('Sure, let me do that.\n```json\n{"tool":"list_apps"}\n```\nOne moment.');
  assert.equal(r.kind, "tool");
  assert.equal(r.tool, "list_apps");
  assert.deepEqual(r.args, {});
});

test("braces inside strings do not end the object early", () => {
  const r = parseAgentReply('{"tool":"write_file","args":{"path":"/a.js","content":"function f() { return \\"}\\"; }"}}');
  assert.equal(r.kind, "tool");
  assert.equal(r.args.content, 'function f() { return "}"; }');
});

test("a final object is the answer", () => {
  assert.deepEqual(parseAgentReply('{"final":"Opened Notes."}'), { kind: "final", text: "Opened Notes." });
});

test("plain prose with no JSON is treated as a final answer", () => {
  assert.deepEqual(parseAgentReply("All done."), { kind: "final", text: "All done." });
});

test("broken JSON, unknown tools, bad args and empty replies are invalid", () => {
  assert.equal(parseAgentReply('{"tool": "open_app", }').kind, "invalid");
  assert.equal(parseAgentReply('{"tool":"format_disk"}').kind, "invalid");
  assert.equal(parseAgentReply('{"tool":"open_app","args":[1]}').kind, "invalid");
  assert.equal(parseAgentReply('{"nothing":1}').kind, "invalid");
  assert.equal(parseAgentReply("   ").kind, "invalid");
});

test("required args are enforced, optional ones are not", () => {
  const miss = validateToolCall("write_file", { path: "/x.txt" });
  assert.equal(miss.kind, "invalid");
  assert.match(miss.reason, /content/);
  assert.equal(validateToolCall("list_files", {}).kind, "tool");
  assert.equal(validateToolCall("open_app", { appId: "notes" }).kind, "tool");
});

test("calendar accepts a list of events instead of single fields", () => {
  const ok = validateToolCall("create_calendar_event", { events: [{ title: "a", start: "2026-01-01T09:00", end: "2026-01-01T10:00" }] });
  assert.equal(ok.kind, "tool");
  assert.equal(validateToolCall("create_calendar_event", { events: [] }).kind, "invalid");
  assert.equal(validateToolCall("create_calendar_event", { events: [{ title: "a" }] }).kind, "invalid");
});

/* ── permissions ─────────────────────────────────────────────────────────── */

test("exactly the side-effectful tools need approval", () => {
  const gated = AGENT_TOOLS.filter((t) => needsApproval(t.name)).map((t) => t.name).sort();
  assert.deepEqual(gated, ["close_window", "create_app", "create_calendar_event", "send_email", "write_file"]);
  assert.equal(needsApproval("nope"), false);
});

test("the schema text names every tool and marks the gated ones", () => {
  const text = toolSchemaText();
  for (const t of AGENT_TOOLS) assert.ok(text.includes(`- ${t.name}(`), t.name);
  assert.equal((text.match(/\[asks the user first\]/g) ?? []).length, 5);
  const sys = agentSystemPrompt("windows: 2");
  assert.ok(sys.includes(`at most ${MAX_AGENT_STEPS} steps`));
  assert.ok(sys.endsWith("windows: 2"));
  assert.equal(MAX_AGENT_STEPS, 8);
});

test("approval prompts describe the call", () => {
  assert.equal(describeCall("send_email", { to: "a@b.co", subject: "Hi" }), 'Draft an email to a@b.co: "Hi"');
  assert.equal(describeCall("create_calendar_event", { events: [{}, {}, {}] }), "Create a calendar file with 3 events");
});

/* ── calendar ────────────────────────────────────────────────────────────── */

test("ISO local and UTC times convert to iCalendar form", () => {
  assert.equal(toIcsDate("2026-09-24T09:05"), "20260924T090500");
  assert.equal(toIcsDate("2026-09-24T09:05:30Z"), "20260924T090530Z");
  assert.equal(toIcsDate("2026-09-24"), "20260924T000000");
  assert.equal(toIcsDate("next tuesday"), null);
});

test("text is escaped and RRULEs cannot inject lines", () => {
  assert.equal(icsEscape("a,b;c\\d\ne"), "a\\,b\\;c\\\\d\\ne");
  assert.equal(cleanRrule("RRULE:FREQ=WEEKLY;BYDAY=MO\r\nATTENDEE:x"), "FREQ=WEEKLY;BYDAY=MOATTENDEEx");
});

test("a routine becomes a calendar with an RRULE, CRLF line endings, one VEVENT each", () => {
  const r = buildIcs(
    [
      { title: "Run, easy", start: "2026-09-24T07:00", end: "2026-09-24T07:45", rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR" },
      { title: "Stretch", start: "2026-09-24T21:00", end: "2026-09-24T21:15", notes: "10 min" },
    ],
    "20260923T120000Z",
    "seed",
  );
  assert.equal(r.ok, true);
  const lines = r.ics.split("\r\n");
  assert.equal(lines[0], "BEGIN:VCALENDAR");
  assert.equal(lines.filter((l) => l === "BEGIN:VEVENT").length, 2);
  assert.ok(lines.includes("RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"));
  assert.ok(lines.includes("SUMMARY:Run\\, easy"));
  assert.ok(lines.includes("UID:seed-1@web-aios"));
  assert.ok(lines.includes("DTSTAMP:20260923T120000Z"));
  assert.ok(!r.ics.replace(/\r\n/g, "").includes("\n"));
});

test("bad dates and backwards events are refused", () => {
  assert.equal(buildIcs([{ title: "x", start: "soon", end: "2026-01-01T10:00" }], "s", "u").ok, false);
  assert.equal(buildIcs([{ title: "x", start: "2026-01-01T10:00", end: "2026-01-01T09:00" }], "s", "u").ok, false);
});

test("single-event args and events arrays normalise the same way", () => {
  assert.deepEqual(eventsFromArgs({ title: "A", start: "s", end: "e" }), [{ title: "A", start: "s", end: "e", notes: undefined, rrule: undefined }]);
  assert.equal(eventsFromArgs({ events: [{ title: "A", start: "s", end: "e" }, 7] }).length, 1);
});

/* ── email and helpers ───────────────────────────────────────────────────── */

test("mailto links encode subject and body and drop non-addresses", () => {
  const link = mailtoLink("a@b.co, bogus, c@d.io?cc=evil@x.y", "Hi & bye", "line1\nline2");
  assert.equal(link, "mailto:a%40b.co?subject=Hi%20%26%20bye&body=line1%0Aline2");
});

test("slug and clip", () => {
  assert.equal(slug("Morning Routine!"), "morning-routine");
  assert.equal(slug("!!!"), "untitled");
  assert.equal(clip("abc", 10), "abc");
  assert.match(clip("x".repeat(20), 5), /^x{5}\n\[truncated 15 chars\]$/);
});
