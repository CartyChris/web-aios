/* ────────────────────────────────────────────────────────────────────────────
   Tasks — natural-language quick add, due-date buckets, and .ics export.

   "tomorrow 3pm call Sam !high" becomes { title: "call Sam", due: <tomorrow
   15:00 local>, hasTime: true, priority: "high" }. The clock is a parameter:
   nothing here reads the time, so every test pins its own "now".

   Date-only dues are stored as the END of that local day (23:59:59.999), so a
   task due "friday" is not overdue until Friday is over. `hasTime` records
   whether a time was actually given, so the UI never shows an invented 23:59.

   PURE. No DOM, no Date.now — `now` arrives as a Date.
   ──────────────────────────────────────────────────────────────────────────── */

import { buildIcs, type CalEvent } from "./aios-agent";

export type Priority = "low" | "med" | "high";

export interface QuickAdd {
  title: string;
  due: number | null;
  hasTime: boolean;
  priority: Priority | null;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WD_RE = "sunday|monday|tuesday|wednesday|thursday|friday|saturday|tues|thurs|thur|sun|mon|tue|wed|thu|fri|sat";

const sod = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const eod = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();

function weekdayIndex(word: string): number {
  const w = word.toLowerCase();
  return WEEKDAYS.findIndex((d) => d.startsWith(w.slice(0, 3)));
}

export function parseQuickAdd(input: string, now: Date): QuickAdd {
  // Padded with spaces so every token can be matched as `\s…(?=\s)`, which
  // keeps "sat" from matching inside "Saturn" and "3pm" inside "13pmx".
  let s = ` ${input} `;
  const cut = (re: RegExp): RegExpExecArray | null => {
    const m = re.exec(s);
    if (!m) return null;
    s = `${s.slice(0, m.index)} ${s.slice(m.index + m[0].length)}`;
    return m;
  };

  let priority: Priority | null = null;
  let m = cut(/\s!(high|medium|med|low|h|m|l)(?=\s)/i);
  if (m) {
    const p = m[1].toLowerCase();
    priority = p.startsWith("h") ? "high" : p.startsWith("l") ? "low" : "med";
  } else if ((m = cut(/\s(!{1,3})(?=\s)/))) {
    priority = m[1].length === 3 ? "high" : m[1].length === 2 ? "med" : "low";
  } else if ((m = cut(/\sp([123])(?=\s)/i))) {
    priority = m[1] === "1" ? "high" : m[1] === "2" ? "med" : "low";
  }

  // Relative time first: "in 2 hours" is a complete instant, not a day.
  let instant: number | null = null;
  if ((m = cut(/\sin\s+(\d{1,4})\s*(minutes|minute|mins|min|m|hours|hour|hrs|hr|h)(?=\s)/i))) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase().startsWith("h") ? 3_600_000 : 60_000;
    instant = now.getTime() + n * unit;
  }

  let day: Date | null = null;
  let tonight = false;
  if ((m = cut(/\s(?:on\s+|by\s+|due\s+)?(\d{4})-(\d{2})-(\d{2})(?=\s)/i))) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (d.getMonth() === Number(m[2]) - 1) day = d;
  } else if ((m = cut(/\s(?:by\s+|due\s+)?(today|tonight)(?=\s)/i))) {
    day = sod(now);
    tonight = m[1].toLowerCase() === "tonight";
  } else if ((m = cut(/\s(?:by\s+|due\s+)?(tomorrow|tmrw|tmr)(?=\s)/i))) {
    day = addDays(now, 1);
  } else if ((m = cut(/\sin\s+(\d{1,3})\s*(days|day|d|weeks|week|w)(?=\s)/i))) {
    const n = Number(m[1]);
    day = addDays(now, m[2].toLowerCase().startsWith("w") ? n * 7 : n);
  } else if ((m = cut(new RegExp(`\\s(?:on\\s+|by\\s+|due\\s+)?(next\\s+)?(${WD_RE})(?=\\s)`, "i")))) {
    const target = weekdayIndex(m[2]);
    // The next occurrence strictly after today: "friday" said on a Friday
    // means a week out, because "today" already has a word.
    let delta = (target - now.getDay() + 7) % 7;
    if (delta === 0) delta = 7;
    day = addDays(now, delta);
  }

  let hour: number | null = null;
  let minute = 0;
  if ((m = cut(/\s(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?=\s)/i))) {
    const h = Number(m[1]);
    const mi = m[2] ? Number(m[2]) : 0;
    if (h >= 1 && h <= 12 && mi < 60) {
      hour = (h % 12) + (m[3].toLowerCase() === "pm" ? 12 : 0);
      minute = mi;
    }
  } else if ((m = cut(/\s(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)(?=\s)/))) {
    hour = Number(m[1]);
    minute = Number(m[2]);
  } else if ((m = cut(/\s(?:at\s+)?(noon|midday|midnight)(?=\s)/i))) {
    hour = m[1].toLowerCase() === "midnight" ? 0 : 12;
  }
  if (hour === null && tonight) hour = 20;

  let due: number | null = null;
  let hasTime = false;
  if (instant !== null) {
    due = instant;
    hasTime = true;
  } else if (hour !== null) {
    let base = day ?? sod(now);
    let at = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute).getTime();
    // A bare time that has already passed today means tomorrow.
    if (!day && at <= now.getTime()) {
      base = addDays(base, 1);
      at = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute).getTime();
    }
    due = at;
    hasTime = true;
  } else if (day) {
    due = eod(day);
  }

  let title = s.replace(/\s+/g, " ").trim();
  // Connectives stranded by the removal: "call Sam at" / "on report".
  title = title.replace(/^(?:at|on|by|due)\s+/i, "").replace(/\s+(?:at|on|by|due)$/i, "").trim();
  if (!title) title = input.trim();
  return { title, due, hasTime, priority };
}

/* ── buckets and filters ─────────────────────────────────────────────────── */

export type DueBucket = "overdue" | "today" | "upcoming" | "none";

export function dueBucket(due: number | null | undefined, now: Date): DueBucket {
  if (due == null) return "none";
  if (due < now.getTime()) return "overdue";
  if (due <= eod(now)) return "today";
  return "upcoming";
}

export type TaskFilter = "all" | "today" | "upcoming" | "overdue" | "done";

export interface FilterableTask {
  due?: number;
  done: boolean;
}

/** "today" includes overdue work: something late is still today's problem. */
export function matchesFilter(t: FilterableTask, f: TaskFilter, now: Date): boolean {
  if (f === "all") return true;
  if (f === "done") return t.done;
  if (t.done) return false;
  const b = dueBucket(t.due, now);
  if (f === "today") return b === "today" || b === "overdue";
  if (f === "overdue") return b === "overdue";
  return b === "upcoming";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function formatClock(d: Date): string {
  const h = d.getHours();
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${h % 12 === 0 ? 12 : h % 12}:${mm} ${h < 12 ? "AM" : "PM"}`;
}

/** "Today 3:00 PM", "Tomorrow", "Mon Sep 28", "Sep 28 2027". */
export function formatDue(due: number, hasTime: boolean, now: Date): string {
  const d = new Date(due);
  const dayDiff = Math.round((sod(d).getTime() - sod(now).getTime()) / 86_400_000);
  let label: string;
  if (dayDiff === 0) label = "Today";
  else if (dayDiff === 1) label = "Tomorrow";
  else if (dayDiff === -1) label = "Yesterday";
  else if (dayDiff > 1 && dayDiff < 7) label = DAYS[d.getDay()];
  else label = `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}${d.getFullYear() !== now.getFullYear() ? ` ${d.getFullYear()}` : ""}`;
  return hasTime ? `${label} ${formatClock(d)}` : label;
}

/** Local "YYYY-MM-DDTHH:MM", the shape `<input type=datetime-local>` and the
 *  .ics builder both take. */
export function toLocalIso(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Inverse of `toLocalIso`, or null for anything that is not one. */
export function fromLocalIso(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(s.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0));
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

export interface IcsTask {
  title: string;
  notes?: string;
  due?: number;
  dueHasTime?: boolean;
}

/**
 * Dated tasks as calendar events, through the one .ics builder the OS has
 * (`buildIcs` in aios-agent.ts). A timed task becomes a 30-minute event; a
 * date-only task spans that day. Undated tasks are skipped and counted.
 */
export function tasksToIcs(tasks: IcsTask[], stamp: string, uidSeed: string):
  { ok: true; ics: string; count: number; skipped: number } | { ok: false; reason: string } {
  const events: CalEvent[] = [];
  let skipped = 0;
  for (const t of tasks) {
    if (t.due == null) { skipped++; continue; }
    if (t.dueHasTime) {
      events.push({ title: t.title, start: toLocalIso(t.due), end: toLocalIso(t.due + 30 * 60_000), notes: t.notes || undefined });
    } else {
      const day = toLocalIso(t.due).slice(0, 10);
      events.push({ title: t.title, start: `${day}T00:00`, end: `${day}T23:59`, notes: t.notes || undefined });
    }
  }
  if (!events.length) return { ok: false, reason: "No task has a due date, so there is nothing to put on a calendar." };
  const r = buildIcs(events, stamp, uidSeed);
  return r.ok ? { ok: true, ics: r.ics, count: events.length, skipped } : r;
}

export interface CheckItem { id: string; text: string; done: boolean }

export function checklistProgress(items: CheckItem[] | undefined): { done: number; total: number } {
  const list = items ?? [];
  return { done: list.filter((i) => i.done).length, total: list.length };
}
