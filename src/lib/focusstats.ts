/* ────────────────────────────────────────────────────────────────────────────
   Focus — session statistics from a log of finished sessions.

   Only sessions that ran to the end are logged, so every number here is a
   session that actually happened. Days are LOCAL calendar days, because
   "today" means the user's today, not UTC's.

   PURE. `now` is passed in.
   ──────────────────────────────────────────────────────────────────────────── */

export interface FocusSession { endedAt: number; minutes: number; mode: "work" | "break" }

export interface FocusStats {
  todaySessions: number;
  todayMinutes: number;
  weekMinutes: number;
  totalSessions: number;
  totalMinutes: number;
  /** Consecutive local days with at least one work session, counting back from
   *  today — or from yesterday when today has none yet (a streak is not broken
   *  until the day is over). */
  streakDays: number;
  /** Work minutes per day for the last 7 days, oldest first; the last is today. */
  last7: number[];
}

const dayKey = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};
const shiftDay = (now: Date, n: number): number => new Date(now.getFullYear(), now.getMonth(), now.getDate() - n, 12).getTime();

export function focusStats(log: FocusSession[], now: Date): FocusStats {
  const work = log.filter((s) => s.mode === "work" && s.endedAt <= now.getTime());
  const perDay = new Map<string, number>();
  for (const s of work) perDay.set(dayKey(s.endedAt), (perDay.get(dayKey(s.endedAt)) ?? 0) + s.minutes);

  const today = dayKey(now.getTime());
  const last7 = Array.from({ length: 7 }, (_, i) => perDay.get(dayKey(shiftDay(now, 6 - i))) ?? 0);

  let streak = 0;
  let start = perDay.has(today) ? 0 : 1;
  while (perDay.has(dayKey(shiftDay(now, start)))) { streak++; start++; }

  const todayWork = work.filter((s) => dayKey(s.endedAt) === today);
  return {
    todaySessions: todayWork.length,
    todayMinutes: todayWork.reduce((a, s) => a + s.minutes, 0),
    weekMinutes: last7.reduce((a, b) => a + b, 0),
    totalSessions: work.length,
    totalMinutes: work.reduce((a, s) => a + s.minutes, 0),
    streakDays: streak,
    last7,
  };
}

/** Clamp a typed custom duration to something a timer can honour. */
export function clampMinutes(v: number, min = 1, max = 240): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, Math.round(v)));
}

/** 0..1 through a session that ends at `endsAt` and lasts `totalMs`. */
export function sessionProgress(endsAt: number, totalMs: number, now: number): number {
  if (totalMs <= 0) return 1;
  return Math.min(1, Math.max(0, 1 - (endsAt - now) / totalMs));
}
