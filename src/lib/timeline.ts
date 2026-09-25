/* Timeline memory: one dated record of what happened on this device.

   Recent agent-memory work (SodaMem, arXiv 2608.08055: evidence-grounded
   temporal graph memory) points the same way: memory is useful when every
   entry has a time and a source you can check. This builds that record from
   stores the OS already keeps and answers plain questions like "yesterday",
   "tuesday notes" or "last week loop". Every answer is a list of entries with
   their source, never a summary that cannot be traced.

   Pure: the clock and the time zone offset are passed in. */

export type TimelineKind = "activity" | "file" | "task" | "job" | "focus" | "notification";

export interface TimelineEntry {
  at: number;
  kind: TimelineKind;
  text: string;
  /** Where it came from, shown next to every entry. */
  source: string;
  target?: { appId: string; args?: Record<string, unknown> };
}

export interface TimelineInput {
  activity: Array<{ source: string; text: string; at: number }>;
  files: Array<{ path: string; kind: "file" | "dir"; updatedAt: number; createdAt: number }>;
  tasks: Array<{ title: string; createdAt: number; archivedAt?: number }>;
  jobs: Array<{ title: string; status: string; startedAt: number; endedAt?: number }>;
  focus: Array<{ endedAt: number; minutes: number; mode: string }>;
  notifications: Array<{ title: string; ts: number }>;
}

export function buildTimeline(i: TimelineInput): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  for (const a of i.activity) out.push({ at: a.at, kind: "activity", text: a.text, source: a.source });
  for (const f of i.files) {
    if (f.kind !== "file" || f.path.startsWith("/.trash") || f.path.startsWith("/dsh/sessions")) continue;
    const app = f.path.startsWith("/notes/") ? "notes" : f.path.startsWith("/code/") ? "ide" : "files";
    out.push({ at: f.updatedAt, kind: "file", text: `${f.updatedAt - f.createdAt < 2000 ? "Created" : "Edited"} ${f.path}`, source: "Files", target: { appId: app, args: { path: f.path } } });
  }
  for (const t of i.tasks) {
    out.push({ at: t.createdAt, kind: "task", text: `Added task "${t.title}"`, source: "Tasks", target: { appId: "tasks" } });
    if (t.archivedAt) out.push({ at: t.archivedAt, kind: "task", text: `Archived task "${t.title}"`, source: "Tasks", target: { appId: "tasks" } });
  }
  for (const j of i.jobs) out.push({ at: j.endedAt ?? j.startedAt, kind: "job", text: `${j.title} (${j.status})`, source: "Jobs" });
  for (const f of i.focus) out.push({ at: f.endedAt, kind: "focus", text: `${f.minutes} min ${f.mode === "work" ? "focus" : "break"} session`, source: "Focus", target: { appId: "focus" } });
  for (const n of i.notifications) out.push({ at: n.ts, kind: "notification", text: n.title, source: "Notifications" });
  return out.sort((a, b) => b.at - a.at);
}

const DAY = 86_400_000;
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** Local midnight for `t`, given the zone offset in minutes (Date#getTimezoneOffset). */
function startOfDay(t: number, tzOffsetMin: number): number {
  const local = t - tzOffsetMin * 60_000;
  return local - (((local % DAY) + DAY) % DAY) + tzOffsetMin * 60_000;
}

export interface TimelineQuery {
  from: number;
  to: number;
  words: string[];
  /** What the time part was understood as, shown to the user. */
  label: string;
}

/** Split a question into a time range and words. Unrecognised time words are
 *  left as words; no range means all of time. */
export function parseQuery(q: string, now: number, tzOffsetMin = 0): TimelineQuery {
  let words = q.toLowerCase().replace(/[^\p{L}\p{N}\s/.-]/gu, " ").split(/\s+/).filter(Boolean);
  const drop = new Set(["what", "did", "i", "do", "on", "in", "the", "my", "show", "me", "when", "was", "a"]);
  const today = startOfDay(now, tzOffsetMin);
  let from = 0, to = Number.POSITIVE_INFINITY, label = "all time";
  const take = (w: string) => { words = words.filter((x) => x !== w); };
  if (words.includes("today")) { from = today; to = today + DAY; label = "today"; take("today"); }
  else if (words.includes("yesterday")) { from = today - DAY; to = today; label = "yesterday"; take("yesterday"); }
  else if (words.includes("week") && (words.includes("last") || words.includes("past"))) { from = today - 7 * DAY; to = now + 1; label = "the last 7 days"; take("week"); take("last"); take("past"); }
  else if (words.includes("week") && words.includes("this")) { from = today - 7 * DAY; to = now + 1; label = "the last 7 days"; take("week"); take("this"); }
  else {
    const d = words.find((w) => DAYS.includes(w));
    if (d) {
      const localDow = new Date(today - tzOffsetMin * 60_000).getUTCDay();
      let back = (localDow - DAYS.indexOf(d) + 7) % 7;
      if (back === 0) back = 7; // "tuesday" on a Tuesday means last Tuesday; "today" means today
      from = today - back * DAY; to = from + DAY; label = `last ${d[0].toUpperCase()}${d.slice(1)}`;
      take(d); take("last");
    }
  }
  return { from, to, words: words.filter((w) => !drop.has(w)), label };
}

export function queryTimeline(entries: TimelineEntry[], q: string, now: number, tzOffsetMin = 0, limit = 50): { query: TimelineQuery; hits: TimelineEntry[] } {
  const query = parseQuery(q, now, tzOffsetMin);
  const hits = entries.filter((e) => e.at >= query.from && e.at < query.to && query.words.every((w) => `${e.text} ${e.source} ${e.kind}`.toLowerCase().includes(w)));
  return { query, hits: hits.slice(0, limit) };
}
