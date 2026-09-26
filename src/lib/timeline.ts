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

/* ── richer time phrases ──────────────────────────────────────────────────

   "3 days ago", "2 weeks ago", "last 10 days", "since Monday", "this month",
   "last month", "March 3", "3 March", "in March", "March 2025", "2026-09-20".

   These run BEFORE the original phrases below and only when they match, so
   every question the original parser understood still means what it meant.
   All of it is local calendar arithmetic: a month is the calendar month in the
   user's zone, not "30 days", and a bare month means the most recent one that
   is not in the future, because this is a record of what already happened. */

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_ABBR: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const CAP = (w: string) => `${w[0].toUpperCase()}${w.slice(1)}`;

/** Local calendar parts of an instant. */
function localParts(t: number, tz: number): { y: number; m: number; d: number; dow: number } {
  const x = new Date(t - tz * 60_000);
  return { y: x.getUTCFullYear(), m: x.getUTCMonth(), d: x.getUTCDate(), dow: x.getUTCDay() };
}
/** The instant of local midnight on a calendar date. Month overflow is fine:
 *  (2026, 12, 1) is 2027-01-01, which is how month ends are computed. */
const localMidnight = (y: number, m: number, d: number, tz: number): number => Date.UTC(y, m, d) + tz * 60_000;

function monthNumber(w: string, allowAbbr: boolean): number | null {
  const full = MONTHS.indexOf(w);
  if (full >= 0) return full;
  if (allowAbbr && w in MONTH_ABBR) return MONTH_ABBR[w];
  return null;
}

/** The most recent occurrence of month `m` (and optionally day `d`) that is
 *  not after today — this is a record of the past. */
function mostRecent(m: number, d: number | null, now: number, tz: number): { y: number } {
  const t = localParts(now, tz);
  const inFuture = m > t.m || (m === t.m && d !== null && d > t.d);
  return { y: inFuture ? t.y - 1 : t.y };
}

interface When { from: number; to: number; label: string; start: number; end: number }

function parseWhen(q: string, now: number, tz: number): When | null {
  const today = startOfDay(now, tz);
  const t = localParts(now, tz);
  const hit = (re: RegExp) => re.exec(q);
  const num = (w: string) => (/^\d+$/.test(w) ? Number(w) : NUMBER_WORDS[w] ?? NaN);
  const NUM = "(\\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)";
  let m: RegExpExecArray | null;

  // 2026-09-20
  if ((m = hit(/\b(\d{4})-(\d{2})-(\d{2})\b/))) {
    const from = localMidnight(+m[1], +m[2] - 1, +m[3], tz);
    return { from, to: from + DAY, label: m[0], start: m.index, end: m.index + m[0].length };
  }

  // 3 days ago / 2 weeks ago / a month ago
  if ((m = hit(new RegExp(`\\b${NUM}\\s+(day|week|month)s?\\s+ago\\b`)))) {
    const n = num(m[1]);
    const unit = m[2];
    // The label names the actual dates, so "3 days ago" can be checked at a
    // glance instead of being taken on trust.
    const said = `${m[1]} ${unit}${n === 1 ? "" : "s"} ago`;
    const span = { start: m.index, end: m.index + m[0].length };
    const dayName = (at: number) => { const p = localParts(at, tz); return `${CAP(DAYS[p.dow]).slice(0, 3)} ${CAP(MONTHS[p.m]).slice(0, 3)} ${p.d}`; };
    if (unit === "day") { const from = today - n * DAY; return { from, to: from + DAY, label: `${said} (${dayName(from)})`, ...span }; }
    if (unit === "week") { const from = today - 7 * n * DAY; const to = from + 7 * DAY; return { from, to, label: `${said} (${dayName(from)} to ${dayName(to - DAY)})`, ...span }; }
    const from = localMidnight(t.y, t.m - n, 1, tz);
    const p = localParts(from, tz);
    return { from, to: localMidnight(t.y, t.m - n + 1, 1, tz), label: `${said} (${CAP(MONTHS[p.m])} ${p.y})`, ...span };
  }

  // last 10 days / past 2 weeks
  if ((m = hit(new RegExp(`\\b(?:last|past)\\s+${NUM}\\s+(day|week)s?\\b`)))) {
    const n = num(m[1]);
    const days = m[2] === "week" ? 7 * n : n;
    return { from: today - days * DAY, to: now + 1, label: `the last ${days} day${days === 1 ? "" : "s"}`, start: m.index, end: m.index + m[0].length };
  }

  // this month / last month
  if ((m = hit(/\b(this|last)\s+month\b/))) {
    const back = m[1] === "last" ? 1 : 0;
    const from = localMidnight(t.y, t.m - back, 1, tz);
    return { from, to: back ? localMidnight(t.y, t.m, 1, tz) : now + 1, label: `${m[1]} month`, start: m.index, end: m.index + m[0].length };
  }

  // since monday / since yesterday / since march / since 2026-09-01
  if ((m = hit(/\bsince\s+([a-z]+|\d{4}-\d{2}-\d{2})\b/))) {
    const w = m[1];
    let from: number | null = null;
    if (w === "today") from = today;
    else if (w === "yesterday") from = today - DAY;
    else if (DAYS.includes(w)) {
      let back = (t.dow - DAYS.indexOf(w) + 7) % 7;
      if (back === 0) back = 7;
      from = today - back * DAY;
    } else if (/^\d{4}-/.test(w)) {
      const [y, mo, d] = w.split("-").map(Number);
      from = localMidnight(y, mo - 1, d, tz);
    } else {
      const mo = monthNumber(w, true);
      if (mo !== null) from = localMidnight(mostRecent(mo, null, now, tz).y, mo, 1, tz);
    }
    if (from !== null) return { from, to: now + 1, label: `since ${/^\d/.test(w) ? w : CAP(w)}`, start: m.index, end: m.index + m[0].length };
  }

  // march 3 / mar 3 / 3 march / 3rd of march / march 2025. Every candidate is
  // tried, not just the first: in "week 3 plan march 5" the first word+number
  // pair is "week 3", and stopping there would miss the date entirely.
  const dayOf = (mo: number, d: number, at: number, len: number): When | null => {
    if (d < 1 || d > 31) return null;
    const from = localMidnight(mostRecent(mo, d, now, tz).y, mo, d, tz);
    return { from, to: from + DAY, label: `${CAP(MONTHS[mo])} ${d}`, start: at, end: at + len };
  };
  for (const x of q.matchAll(/\b([a-z]+)\s+(\d{1,4})(?:st|nd|rd|th)?\b/g)) {
    const mo = monthNumber(x[1], true);
    if (mo === null) continue;
    if (x[2].length === 4) {
      const y = +x[2];
      return { from: localMidnight(y, mo, 1, tz), to: localMidnight(y, mo + 1, 1, tz), label: `${CAP(MONTHS[mo])} ${y}`, start: x.index!, end: x.index! + x[0].length };
    }
    const w = dayOf(mo, +x[2], x.index!, x[0].length);
    if (w) return w;
  }
  for (const x of q.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]+)\b/g)) {
    const mo = monthNumber(x[2], true);
    if (mo === null) continue;
    const w = dayOf(mo, +x[1], x.index!, x[0].length);
    if (w) return w;
  }

  // in march / bare "march". A bare "may" is an ordinary English word, and a
  // bare abbreviation is too easily a word ("dec" in a file name), so those
  // need "in" in front of them.
  for (const x of q.matchAll(/\b(?:(in)\s+)?([a-z]+)\b/g)) {
    const hasIn = !!x[1];
    const w = x[2];
    const full = MONTHS.indexOf(w);
    const mo = full >= 0 && (w !== "may" || hasIn) ? full : hasIn ? monthNumber(w, true) : null;
    if (mo === null) continue;
    const y = mostRecent(mo, null, now, tz).y;
    const from = localMidnight(y, mo, 1, tz);
    const to = mo === t.m && y === t.y ? now + 1 : localMidnight(y, mo + 1, 1, tz);
    return { from, to, label: `${CAP(MONTHS[mo])} ${y}`, start: x.index!, end: x.index! + x[0].length };
  }
  return null;
}

/** Split a question into a time range and words. Unrecognised time words are
 *  left as words; no range means all of time. */
export function parseQuery(q: string, now: number, tzOffsetMin = 0): TimelineQuery {
  const norm = q.toLowerCase().replace(/[^\p{L}\p{N}\s/.-]/gu, " ");
  const drop = new Set(["what", "did", "i", "do", "on", "in", "the", "my", "show", "me", "when", "was", "a"]);
  const rich = parseWhen(norm, now, tzOffsetMin);
  if (rich) {
    const rest = `${norm.slice(0, rich.start)} ${norm.slice(rich.end)}`.split(/\s+/).filter(Boolean);
    return { from: rich.from, to: rich.to, label: rich.label, words: rest.filter((w) => !drop.has(w)) };
  }
  let words = norm.split(/\s+/).filter(Boolean);
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

/**
 * A timeline answer as plain text for a model: one line per entry, each with
 * its local date and time, kind, source, and — when the entry came from
 * something that can be opened — the exact `open_app` call that leads back to
 * it. That call is the provenance link: an answer drawn from the timeline can
 * always be traced to the note, task or file it came from, which is the whole
 * reason the timeline keeps a source on every entry.
 *
 * Returns a sentence, not an empty string, when nothing matched, so the model
 * says so instead of inventing an event.
 */
export function timelineAnswer(r: { query: TimelineQuery; hits: TimelineEntry[] }, tzOffsetMin = 0): string {
  const what = `${r.query.label}${r.query.words.length ? `, matching "${r.query.words.join(" ")}"` : ""}`;
  if (!r.hits.length) return `Nothing in the timeline for ${what}. The timeline covers activity, files, tasks, jobs, focus sessions and notifications on this device only.`;
  const pad = (n: number) => String(n).padStart(2, "0");
  const lines = r.hits.map((e) => {
    const x = new Date(e.at - tzOffsetMin * 60_000);
    const when = `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())} ${pad(x.getUTCHours())}:${pad(x.getUTCMinutes())}`;
    const link = e.target ? `  -> open_app ${JSON.stringify({ appId: e.target.appId, ...(e.target.args ? { args: e.target.args } : {}) })}` : "";
    return `${when}  ${e.kind.padEnd(12)} ${e.text}  [${e.source}]${link}`;
  });
  return `${r.hits.length} entr${r.hits.length === 1 ? "y" : "ies"} from ${what}:\n${lines.join("\n")}`;
}
