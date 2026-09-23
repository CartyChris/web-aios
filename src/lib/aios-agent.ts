/* AIOS Chat: the pure half of the top-bar agent.

   The model talks to the OS through one JSON object per reply. This module
   owns everything about that protocol that can be decided without a DOM: the
   tool list the model is shown, parsing and validating what it sends back,
   which tools need the user's OK, and the two artifacts the agent can produce
   for the outside world (an .ics calendar file and a mailto: link).

   No `@/` imports, no DOM, no clock, no randomness: every function here is a
   function of its arguments, which is what lets tests pin it. */

export const MAX_AGENT_STEPS = 8;

export interface AgentToolSpec {
  name: string;
  /** Argument names; a trailing "?" marks an optional one. */
  args: string[];
  desc: string;
  /** True when the tool changes something the user would want to OK first. */
  sideEffect: boolean;
}

export const AGENT_TOOLS: AgentToolSpec[] = [
  { name: "read_os", args: [], desc: "Summary of the OS right now: open windows, installed apps, files, user apps.", sideEffect: false },
  { name: "list_apps", args: [], desc: "Every app id and name you can open.", sideEffect: false },
  { name: "open_app", args: ["appId", "args?"], desc: "Open an app by id. args is an optional object passed to the app.", sideEffect: false },
  { name: "list_windows", args: [], desc: "Open windows with their ids.", sideEffect: false },
  { name: "focus_window", args: ["windowId"], desc: "Bring a window to the front.", sideEffect: false },
  { name: "close_window", args: ["windowId"], desc: "Close a window.", sideEffect: true },
  { name: "list_files", args: ["dir?"], desc: "List files in the virtual file system (default: root).", sideEffect: false },
  { name: "read_file", args: ["path"], desc: "Read a file's text.", sideEffect: false },
  { name: "write_file", args: ["path", "content"], desc: "Create or overwrite a text file.", sideEffect: true },
  { name: "create_app", args: ["name", "html"], desc: "Install a new app from one self-contained HTML document.", sideEffect: true },
  {
    name: "create_calendar_event",
    args: ["title", "start", "end", "notes?", "rrule?"],
    desc: "Make an .ics calendar file. start/end are ISO local times like 2026-09-24T09:00. rrule is an iCalendar RRULE such as FREQ=WEEKLY;BYDAY=MO,WE,FR for a routine. For several events pass events: [{title,start,end,notes?,rrule?}] instead.",
    sideEffect: true,
  },
  { name: "send_email", args: ["to", "subject", "body"], desc: "Prepare an email. It is never sent automatically: the user gets a draft and a link to open in their mail app.", sideEffect: true },
  { name: "set_theme", args: ["themeId"], desc: "Switch the OS theme. Unknown ids return the list of valid ones.", sideEffect: false },
  { name: "notify", args: ["title", "body?"], desc: "Show the user a notification.", sideEffect: false },
];

const BY_NAME = new Map(AGENT_TOOLS.map((t) => [t.name, t]));

export const getTool = (name: string): AgentToolSpec | undefined => BY_NAME.get(name);
export const needsApproval = (name: string): boolean => BY_NAME.get(name)?.sideEffect ?? false;

/** The tool list as the model sees it. */
export function toolSchemaText(tools: AgentToolSpec[] = AGENT_TOOLS): string {
  return tools
    .map((t) => `- ${t.name}(${t.args.join(", ")})${t.sideEffect ? " [asks the user first]" : ""}: ${t.desc}`)
    .join("\n");
}

export function agentSystemPrompt(context = ""): string {
  return [
    "You are AIOS Chat, an agent that operates a web operating system for the user.",
    "Reply with EXACTLY ONE JSON object and nothing else. Either call a tool:",
    '{"tool": "open_app", "args": {"appId": "notes"}}',
    "or finish with a short answer for the user:",
    '{"final": "Done. I opened Notes."}',
    `You have at most ${MAX_AGENT_STEPS} steps. After each tool call you receive its result.`,
    "Tools marked [asks the user first] may be denied; if so, do not retry the same call, explain instead.",
    "Never claim you sent an email: send_email only prepares one.",
    "",
    "Tools:",
    toolSchemaText(),
    ...(context ? ["", "Current OS state:", context] : []),
  ].join("\n");
}

export type AgentStep =
  | { kind: "tool"; tool: string; args: Record<string, unknown> }
  | { kind: "final"; text: string }
  | { kind: "invalid"; reason: string };

/** First balanced {...} in `s`, respecting strings. */
function firstObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Read one model reply. Accepts a bare object, a fenced ```json block, or an
 *  object surrounded by prose. A reply with no JSON at all is treated as a
 *  final answer, because a model that just talks has finished. */
export function parseAgentReply(text: string): AgentStep {
  const trimmed = text.trim();
  if (!trimmed) return { kind: "invalid", reason: "Empty reply." };
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = firstObject(fenced ? fenced[1] : trimmed) ?? (fenced ? firstObject(trimmed) : null);
  if (!candidate) return { kind: "final", text: trimmed };
  let obj: unknown;
  try {
    obj = JSON.parse(candidate);
  } catch {
    return { kind: "invalid", reason: "Reply contained JSON that does not parse." };
  }
  if (!isRecord(obj)) return { kind: "invalid", reason: "Reply must be a JSON object." };
  if (typeof obj.final === "string") return { kind: "final", text: obj.final };
  if (typeof obj.tool !== "string") return { kind: "invalid", reason: 'Object needs a "tool" or a "final" field.' };
  const args = obj.args === undefined ? {} : obj.args;
  if (!isRecord(args)) return { kind: "invalid", reason: '"args" must be an object.' };
  return validateToolCall(obj.tool, args);
}

export function validateToolCall(tool: string, args: Record<string, unknown>): AgentStep {
  const spec = BY_NAME.get(tool);
  if (!spec) return { kind: "invalid", reason: `Unknown tool "${tool}". Valid: ${AGENT_TOOLS.map((t) => t.name).join(", ")}.` };
  // Several events replace the single-event fields.
  if (tool === "create_calendar_event" && Array.isArray(args.events)) {
    const bad = args.events.findIndex((e) => !isRecord(e) || typeof e.title !== "string" || typeof e.start !== "string" || typeof e.end !== "string");
    if (args.events.length === 0) return { kind: "invalid", reason: "events is empty." };
    if (bad >= 0) return { kind: "invalid", reason: `events[${bad}] needs title, start and end strings.` };
    return { kind: "tool", tool, args };
  }
  const missing = spec.args.filter((a) => !a.endsWith("?") && (args[a] === undefined || args[a] === null || args[a] === ""));
  if (missing.length) return { kind: "invalid", reason: `${tool} is missing: ${missing.join(", ")}.` };
  return { kind: "tool", tool, args };
}

/** One-line human description of a call, for approval prompts. */
export function describeCall(tool: string, args: Record<string, unknown>): string {
  const s = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : "");
  switch (tool) {
    case "write_file": return `Write ${s("path")} (${s("content").length} chars)`;
    case "create_app": return `Install a new app "${s("name")}"`;
    case "send_email": return `Draft an email to ${s("to")}: "${s("subject")}"`;
    case "close_window": return `Close window ${s("windowId")}`;
    case "create_calendar_event": {
      const n = Array.isArray(args.events) ? args.events.length : 1;
      return n > 1 ? `Create a calendar file with ${n} events` : `Create calendar event "${s("title")}" at ${s("start")}`;
    }
    default: return tool;
  }
}

/* ── Calendar ─────────────────────────────────────────────────────────────── */

export interface CalEvent {
  title: string;
  start: string;
  end: string;
  notes?: string;
  rrule?: string;
}

/** ISO-ish local time to an iCalendar DATE-TIME. A trailing Z keeps UTC. */
export function toIcsDate(iso: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?(Z)?$/.exec(iso.trim());
  if (!m) return null;
  const [, y, mo, d, h = "00", mi = "00", s = "00", z = ""] = m;
  return `${y}${mo}${d}T${h}${mi}${s}${z}`;
}

/** RFC 5545 TEXT escaping. */
export const icsEscape = (s: string): string =>
  s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** Keep only characters an RRULE can contain, so a model cannot inject lines. */
export const cleanRrule = (r: string): string => r.replace(/^RRULE:/i, "").replace(/[^A-Za-z0-9=;,+-]/g, "");

/** Build a VCALENDAR. `stamp` is the DTSTAMP (a caller-supplied clock) and
 *  `uidSeed` makes UIDs unique across calls. */
export function buildIcs(events: CalEvent[], stamp: string, uidSeed: string): { ok: true; ics: string } | { ok: false; reason: string } {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Web-AIOS//AIOS Chat//EN", "CALSCALE:GREGORIAN"];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const start = toIcsDate(e.start);
    const end = toIcsDate(e.end);
    if (!start || !end) return { ok: false, reason: `Event ${i + 1} has a start or end that is not an ISO date (${e.start} / ${e.end}).` };
    if (end < start) return { ok: false, reason: `Event ${i + 1} ends before it starts.` };
    lines.push("BEGIN:VEVENT", `UID:${uidSeed}-${i}@web-aios`, `DTSTAMP:${stamp}`, `DTSTART:${start}`, `DTEND:${end}`, `SUMMARY:${icsEscape(e.title)}`);
    if (e.notes) lines.push(`DESCRIPTION:${icsEscape(e.notes)}`);
    if (e.rrule) {
      const r = cleanRrule(e.rrule);
      if (r) lines.push(`RRULE:${r}`);
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return { ok: true, ics: lines.join("\r\n") + "\r\n" };
}

/** Normalise create_calendar_event args into a list of events. */
export function eventsFromArgs(args: Record<string, unknown>): CalEvent[] {
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const one = (r: Record<string, unknown>): CalEvent => ({
    title: str(r.title) ?? "Event", start: str(r.start) ?? "", end: str(r.end) ?? "", notes: str(r.notes), rrule: str(r.rrule),
  });
  if (Array.isArray(args.events)) return args.events.filter(isRecord).map(one);
  return [one(args)];
}

/* ── Email ────────────────────────────────────────────────────────────────── */

/** A mailto: link the user has to click. Addresses are kept only if they look
 *  like addresses, so the link cannot carry extra headers. */
export function mailtoLink(to: string, subject: string, body: string): string {
  const addrs = to.split(/[,;\s]+/).filter((a) => /^[^\s@?&]+@[^\s@?&]+\.[^\s@?&]+$/.test(a));
  return `mailto:${addrs.map(encodeURIComponent).join(",")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** File-name-safe slug. */
export const slug = (s: string, fallback = "untitled"): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || fallback;

/** Clip a tool result so one call cannot flood the model's context. */
export const clip = (s: string, n = 4000): string => (s.length > n ? `${s.slice(0, n)}\n[truncated ${s.length - n} chars]` : s);
