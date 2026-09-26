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

import { parsePanel } from "../.test-build/aios-agent.js";

test("panels: a final answer can carry an allowlisted, text-only panel", () => {
  const r = parseAgentReply('{"final":"Here is your week","panel":{"type":"table","columns":["Day","Plan"],"rows":[["Mon","Gym",9],["Tue"]]}}');
  assert.equal(r.kind, "final");
  assert.deepEqual(r.panel, { type: "table", columns: ["Day", "Plan"], rows: [["Mon", "Gym"], ["Tue", ""]] });
});

test("panels: unknown types, HTML-ish objects and oversize panels are refused, the answer survives", () => {
  const bad = parseAgentReply('{"final":"ok","panel":{"type":"script","src":"x"}}');
  assert.equal(bad.kind, "final");
  assert.equal(bad.panel, undefined);
  assert.match(bad.panelError, /unknown panel type/);
  assert.equal(parsePanel({ type: "table", columns: ["a"], rows: Array.from({ length: 51 }, () => ["x"]) }).ok, false);
  assert.equal(parsePanel({ type: "choices", options: [{ label: { html: "<b>" } }] }).ok, false);
  const form = parsePanel({ type: "form", fields: [{ name: "d", label: "Day", kind: "datetime-local" }] });
  assert.equal(form.panel.fields[0].kind, "text", "an unknown input kind falls back to text");
});

/* ── chart, timeline and diff panels ─────────────────────────────────────── */

test("panels: a chart is numbers and labels only, padded with gaps", () => {
  const r = parsePanel({ type: "chart", kind: "line", title: "Focus", labels: ["Mon", "Tue", "Wed"], series: [{ name: "min", values: [30, "45"] }] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.panel.series[0].values, [30, 45, null], "a numeric string is a number; a missing value is a gap");
  assert.equal(r.panel.kind, "line");
  assert.equal(parsePanel({ type: "chart", kind: "pie", labels: ["a"], series: [{ values: [1] }] }).panel.kind, "bar", "unknown kinds fall back to bar");
});

test("panels: a chart with non-numbers, too many values or no values is refused", () => {
  assert.match(parsePanel({ type: "chart", labels: ["a"], series: [{ values: ["<script>"] }] }).reason, /numbers/);
  assert.match(parsePanel({ type: "chart", labels: ["a"], series: [{ values: [Infinity] }] }).reason, /numbers/);
  assert.match(parsePanel({ type: "chart", labels: ["a"], series: [{ values: [1, 2] }] }).reason, /more values/);
  assert.match(parsePanel({ type: "chart", labels: ["a"], series: [{ values: [null] }] }).reason, /no values/);
  assert.equal(parsePanel({ type: "chart", labels: Array.from({ length: 25 }, () => "x"), series: [{ values: [1] }] }).ok, false);
  assert.equal(parsePanel({ type: "chart", labels: ["a"], series: [1, 2, 3, 4].map(() => ({ values: [1] })) }).ok, false);
  assert.equal(parsePanel({ type: "chart", labels: [{ html: "<b>" }], series: [{ values: [1] }] }).ok, false);
});

test("panels: timeline links are kept only when they are an app id and a plain absolute path", () => {
  const r = parsePanel({ type: "timeline", items: [
    { when: "Tue 09:12", text: "Created plan.md", appId: "notes", path: "/notes/plan.md" },
    { when: "Tue 10:00", text: "bad app", appId: "javascript:alert(1)", path: "/x" },
    { when: "Tue 11:00", text: "bad path", appId: "files", path: "/a/../../etc" },
    { when: "Tue 12:00", text: "path without app", path: "/x" },
  ] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.panel.items[0], { when: "Tue 09:12", text: "Created plan.md", appId: "notes", path: "/notes/plan.md" });
  assert.deepEqual(r.panel.items[1], { when: "Tue 10:00", text: "bad app" });
  assert.deepEqual(r.panel.items[2], { when: "Tue 11:00", text: "bad path", appId: "files" });
  assert.deepEqual(r.panel.items[3], { when: "Tue 12:00", text: "path without app" });
  assert.equal(parsePanel({ type: "timeline", items: [{ text: "no when" }] }).ok, false);
});

test("panels: a diff is two capped texts", () => {
  const r = parsePanel({ type: "diff", title: "plan.md", before: "a\nb", after: "a\nB" });
  assert.deepEqual(r.panel, { type: "diff", title: "plan.md", before: "a\nb", after: "a\nB" });
  assert.equal(parsePanel({ type: "diff", before: "", after: "x" }).ok, true, "an empty side is allowed");
  assert.match(parsePanel({ type: "diff", before: 1, after: "x" }).reason, /as text/);
  assert.match(parsePanel({ type: "diff", before: "x".repeat(20_001), after: "" }).reason, /capped/);
});

test("panels: the error for an unknown type lists every allowed type", () => {
  const r = parsePanel({ type: "iframe" });
  for (const t of ["table", "checklist", "choices", "form", "chart", "timeline", "diff"]) assert.match(r.reason, new RegExp(t));
});
