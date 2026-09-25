/* Desk: what needs you, from what is actually on this device.

   The brief is computed, not written. Every line comes from a record the OS
   holds (a job, a task, a file, a focus session), every number is counted
   from those records, and the list of things the Desk cannot see is part of
   the output rather than an afterthought. A model can be asked to talk the
   brief through, but it is handed this result as data; it does not produce it.

   Pure: the clock and the local hour are passed in. */

export interface DeskTask {
  id: string;
  title: string;
  column: string;
  priority: "low" | "med" | "high";
  due?: number;
  dueHasTime?: boolean;
  archivedAt?: number;
}

export interface DeskJob {
  id: string;
  title: string;
  status: "running" | "blocked" | "done" | "error" | "timeout";
  detail?: string;
  startedAt: number;
  endedAt?: number;
  target?: { appId: string; args?: Record<string, unknown>; windowId?: string };
}

export interface DeskFile {
  path: string;
  kind: "file" | "dir";
  updatedAt: number;
  size: number;
}

export interface DeskInput {
  now: number;
  /** Local hour 0-23, passed in so a test does not depend on the machine's zone. */
  hour: number;
  /** End of the local day, epoch ms. */
  endOfDay: number;
  tasks: DeskTask[];
  /** Column ids that mean "finished". */
  doneColumns: string[];
  jobs: DeskJob[];
  files: DeskFile[];
  unreadNotifications: number;
  focusMinutesToday: number;
  focusStreakDays: number;
}

export type DeskAction =
  | { kind: "open"; appId: string; args?: Record<string, unknown>; windowId?: string }
  | { kind: "ask"; prompt: string };

export interface DeskItem {
  id: string;
  /** 3 needs you now, 2 overdue or failed, 1 today, 0 when you have a moment. */
  urgency: 0 | 1 | 2 | 3;
  title: string;
  detail: string;
  action?: DeskAction;
  actionLabel?: string;
}

export interface Brief {
  greeting: string;
  headline: string;
  items: DeskItem[];
  /** What the Desk cannot see, said out loud. */
  blindSpots: string[];
  counts: { needsYou: number; canWait: number };
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function greeting(hour: number): string {
  if (hour < 5) return "Still up";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export function ago(ms: number): string {
  if (ms < 90_000) return "just now";
  if (ms < HOUR) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < DAY) return `${Math.round(ms / HOUR)} h ago`;
  const d = Math.round(ms / DAY);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

function overdueBy(ms: number): string {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / 60_000))} min overdue`;
  if (ms < DAY) return `${Math.round(ms / HOUR)} h overdue`;
  const d = Math.round(ms / DAY);
  return `${d} day${d === 1 ? "" : "s"} overdue`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function buildBrief(input: DeskInput): Brief {
  const { now } = input;
  const items: DeskItem[] = [];
  const open = input.tasks.filter((t) => !t.archivedAt && !input.doneColumns.includes(t.column));

  // 3: something is stopped until you answer it.
  for (const j of input.jobs.filter((x) => x.status === "blocked")) {
    items.push({
      id: `job:${j.id}`, urgency: 3, title: j.title, detail: `Waiting for your OK${j.detail ? `: ${j.detail}` : ""}. Started ${ago(now - j.startedAt)}.`,
      ...(j.target ? { action: { kind: "open" as const, ...j.target }, actionLabel: "Go to it" } : {}),
    });
  }

  // 2: failed or timed out in the last day.
  for (const j of input.jobs.filter((x) => (x.status === "error" || x.status === "timeout") && now - (x.endedAt ?? x.startedAt) < DAY)) {
    items.push({
      id: `job:${j.id}`, urgency: 2, title: `${j.status === "timeout" ? "Timed out" : "Failed"}: ${j.title}`,
      detail: `${j.detail ?? "No detail recorded."} (${ago(now - (j.endedAt ?? j.startedAt))})`,
      ...(j.target ? { action: { kind: "open" as const, ...j.target }, actionLabel: "Look at it" } : {}),
    });
  }

  // 2: overdue tasks, most overdue first; more than three collapse into one line.
  const overdue = open.filter((t) => t.due !== undefined && t.due < now).sort((a, b) => (a.due ?? 0) - (b.due ?? 0));
  for (const t of overdue.slice(0, 3)) {
    items.push({ id: `task:${t.id}`, urgency: 2, title: t.title, detail: `${overdueBy(now - (t.due ?? now))}${t.priority === "high" ? ", high priority" : ""}.`, action: { kind: "open", appId: "tasks" }, actionLabel: "Open Tasks" });
  }
  if (overdue.length > 3) {
    items.push({ id: "task:overdue-rest", urgency: 2, title: `${plural(overdue.length - 3, "more overdue task")}`, detail: "Oldest first in Tasks, under Overdue.", action: { kind: "open", appId: "tasks" }, actionLabel: "Open Tasks" });
  }

  // 1: due later today.
  const today = open.filter((t) => t.due !== undefined && t.due >= now && t.due <= input.endOfDay).sort((a, b) => (a.due ?? 0) - (b.due ?? 0));
  for (const t of today.slice(0, 4)) {
    const inMs = (t.due ?? now) - now;
    items.push({ id: `task:${t.id}`, urgency: 1, title: t.title, detail: t.dueHasTime ? `Due in ${inMs < HOUR ? `${Math.max(1, Math.round(inMs / 60_000))} min` : `${Math.round(inMs / HOUR)} h`}.` : "Due today.", action: { kind: "open", appId: "tasks" }, actionLabel: "Open Tasks" });
  }

  // 1: high priority with no date, the ones that quietly never get a slot.
  const undatedHigh = open.filter((t) => t.priority === "high" && t.due === undefined);
  if (undatedHigh.length) {
    items.push({
      id: "task:undated-high", urgency: 1, title: `${plural(undatedHigh.length, "high-priority task")} with no date`,
      detail: `${undatedHigh.slice(0, 3).map((t) => `"${t.title}"`).join(", ")}${undatedHigh.length > 3 ? " and more" : ""}. Giving one a date is how it gets done.`,
      action: { kind: "open", appId: "tasks" }, actionLabel: "Open Tasks",
    });
  }

  // 1: drafts AIOS Chat wrote and nobody sent.
  const drafts = input.files.filter((f) => f.kind === "file" && f.path.startsWith("/Mail/Drafts/"));
  if (drafts.length) {
    items.push({ id: "mail:drafts", urgency: 1, title: `${plural(drafts.length, "email draft")} not sent`, detail: `Newest ${ago(now - Math.max(...drafts.map((d) => d.updatedAt)))}. Drafts are never sent for you.`, action: { kind: "open", appId: "files", args: { path: "/Mail/Drafts" } }, actionLabel: "Open drafts" });
  }

  // 0: pick up where you left off.
  const recent = input.files
    .filter((f) => f.kind === "file" && now - f.updatedAt < DAY && !f.path.startsWith("/.trash") && !f.path.startsWith("/dsh/sessions") && !f.path.startsWith("/harness"))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 3);
  for (const f of recent) {
    const app = f.path.startsWith("/notes/") ? "notes" : f.path.startsWith("/code/") ? "ide" : "files";
    items.push({ id: `file:${f.path}`, urgency: 0, title: f.path.split("/").pop() || f.path, detail: `Edited ${ago(now - f.updatedAt)} in ${f.path.slice(0, f.path.lastIndexOf("/")) || "/"}.`, action: { kind: "open", appId: app, args: { path: f.path } }, actionLabel: "Open" });
  }

  // 0: a focus nudge in working hours, only when there has been none today.
  if (input.focusMinutesToday === 0 && input.hour >= 9 && input.hour < 18) {
    items.push({ id: "focus:none", urgency: 0, title: "No focus session yet today", detail: input.focusStreakDays > 0 ? `One keeps your ${input.focusStreakDays}-day streak.` : "25 minutes on the most overdue thing above is a good start.", action: { kind: "open", appId: "focus" }, actionLabel: "Start one" });
  } else if (input.focusMinutesToday > 0) {
    items.push({ id: "focus:done", urgency: 0, title: `${input.focusMinutesToday} min of focus today`, detail: input.focusStreakDays > 1 ? `${input.focusStreakDays}-day streak.` : "Nice." });
  }

  if (input.unreadNotifications > 0) {
    items.push({ id: "notify:unread", urgency: 0, title: plural(input.unreadNotifications, "unread notification"), detail: "In the bell menu, top right." });
  }

  items.sort((a, b) => b.urgency - a.urgency);
  const needsYou = items.filter((i) => i.urgency >= 2).length;
  const canWait = items.length - needsYou;
  const headline = items.length === 0
    ? "Nothing needs you right now."
    : needsYou === 0
      ? `Nothing urgent. ${plural(canWait, "thing")} when you have a moment.`
      : `${plural(needsYou, "thing needs", "things need")} you${canWait ? `; ${canWait} can wait` : ""}.`;

  return {
    greeting: greeting(input.hour),
    headline,
    items,
    blindSpots: [
      "Your email inbox: there is no mail connector, only drafts written here.",
      "Your real calendar: only .ics files saved in /Calendar are on this device.",
      "Other browsers and devices: everything here lives in this browser's storage.",
    ],
    counts: { needsYou, canWait },
  };
}

/** The brief as plain text, the form AIOS Chat is given when asked to plan the
 *  day from it. Data, not instructions: the caller fences it. */
export function briefText(b: Brief): string {
  return [
    `${b.greeting}. ${b.headline}`,
    ...b.items.map((i) => `- [${["later", "today", "overdue", "now"][i.urgency]}] ${i.title}: ${i.detail}`),
    "Cannot see:",
    ...b.blindSpots.map((s) => `- ${s}`),
  ].join("\n");
}
