import type { TriggerEvent, TriggerKind, TriggerSpec } from "./types";

/* ────────────────────────────────────────────────────────────────────────────
   Layer 1 — triggers.

   Five of the six harness layers had a runtime and this one did not, so every
   run in this OS has so far started because a person pressed a button. That is
   not a harness; it is a very careful chat window. What separates the two is
   whether the thing can start work it was not watched into starting.

   Three properties are load-bearing, and each has a test:

   - A trigger that has never fired is a bug you cannot otherwise see. A cron
     expression with a typo, a bus event nobody emits and a VFS path that does
     not exist all look identical from the outside: silence. `firedCount` and
     `matchedCount` are recorded separately so "never matched" is
     distinguishable from "matched and was suppressed".
   - Dedupe is mandatory, not optional. An event source that fires twice on one
     logical change — and most do — otherwise spends the budget twice and
     writes two contradictory receipts.
   - A schedule is evaluated against an injected clock. A trigger layer that
     reads `Date.now()` cannot be tested at all without waiting in real time,
     which is why this is the layer that usually ships untested.

   PURE. No timers, no bus, no storage: this module decides WHETHER something
   should fire and WHAT the objective is. `harness-triggers.ts` owns the
   setInterval and the subscriptions.
   ──────────────────────────────────────────────────────────────────────────── */

/* ── schedule grammar ────────────────────────────────────────────────────── */

export type Schedule =
  | { kind: "every"; ms: number }
  | { kind: "at"; hour: number; minute: number };

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** The shortest interval a schedule may name. A trigger firing every two
 *  seconds against a paid model is a bill, not a feature, and the limit is
 *  here rather than in the UI so it cannot be bypassed by editing storage. */
export const MIN_INTERVAL_MS = 60_000;

export function parseSchedule(match: string): { ok: true; schedule: Schedule } | { ok: false; error: string } {
  const src = match.trim().toLowerCase();

  const every = src.match(/^every:(\d+)([smhd])$/);
  if (every) {
    const n = Number(every[1]);
    const unit = every[2] ?? "m";
    if (!Number.isFinite(n) || n <= 0) return { ok: false, error: `"${match}": the interval must be a positive number.` };
    const ms = n * (UNIT_MS[unit] ?? 60_000);
    if (ms < MIN_INTERVAL_MS) {
      return { ok: false, error: `"${match}" is shorter than the ${MIN_INTERVAL_MS / 1000}s minimum interval.` };
    }
    return { ok: true, schedule: { kind: "every", ms } };
  }

  const at = src.match(/^at:(\d{1,2}):(\d{2})$/);
  if (at) {
    const hour = Number(at[1]);
    const minute = Number(at[2]);
    if (hour > 23 || minute > 59) return { ok: false, error: `"${match}": ${hour}:${minute} is not a time of day.` };
    return { ok: true, schedule: { kind: "at", hour, minute } };
  }

  return { ok: false, error: `"${match}" is not a schedule. Use every:15m, every:2h or at:09:30.` };
}

/**
 * When a schedule is next due, given when it last ran.
 *
 * `at:` is resolved in LOCAL time deliberately: a person who asks for a 09:30
 * digest means their own 09:30, and this whole OS runs in one browser in one
 * timezone. The Date arithmetic is the injected `now`, so a test can sit at
 * any instant it likes.
 */
export function nextDue(schedule: Schedule, lastFiredAt: number | undefined, now: number): number {
  if (schedule.kind === "every") {
    return lastFiredAt === undefined ? now : lastFiredAt + schedule.ms;
  }
  const d = new Date(now);
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate(), schedule.hour, schedule.minute, 0, 0).getTime();
  if (today > now) return today;
  // Today's slot has passed. If it already fired inside this slot, the next
  // one is tomorrow; if it did not, it is due now — a missed daily digest
  // should still arrive rather than silently skipping to tomorrow.
  if (lastFiredAt !== undefined && lastFiredAt >= today) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, schedule.hour, schedule.minute, 0, 0).getTime();
  }
  return today;
}

export function isDue(spec: TriggerSpec, now: number): boolean {
  if (!spec.enabled || spec.kind !== "schedule") return false;
  const parsed = parseSchedule(spec.match);
  // An unparseable schedule never fires. It must be caught at save time by
  // validateTrigger; silently firing on a typo would be worse.
  if (!parsed.ok) return false;
  return nextDue(parsed.schedule, spec.lastFiredAt, now) <= now;
}

/* ── matching ────────────────────────────────────────────────────────────── */

/**
 * Whether a bus event name matches a trigger's pattern.
 *
 * One wildcard form, `prefix:*`, and nothing else. A full glob here would be a
 * second pattern language in a codebase that already has one, and the failure
 * it invites — a pattern that matches far more than its author expected —
 * costs real money on every extra match.
 */
export function eventMatches(pattern: string, event: string): boolean {
  const p = pattern.trim();
  if (p === "*") return true;
  if (p.endsWith(":*")) return event.startsWith(p.slice(0, -1));
  return p === event;
}

/** Whether a written path falls under a trigger's watched prefix. A prefix
 *  must match on a path SEGMENT: watching `/notes` must not fire for
 *  `/notes-archive/x.md`, which is a different directory. */
export function pathMatches(prefix: string, path: string): boolean {
  const p = prefix.trim().replace(/\/+$/, "");
  if (!p || p === "/") return true;
  return path === p || path.startsWith(`${p}/`);
}

/* ── objective templating ────────────────────────────────────────────────── */

const MAX_SUBSTITUTION_CHARS = 2_000;

/**
 * Fill `{{payload}}`, `{{payload.field}}` and `{{now}}` in an objective.
 *
 * Every substituted value is capped and stringified. The objective goes
 * straight into a system prompt, and a bus payload is not necessarily small or
 * even a string — a 400 KB VFS write event interpolated whole would blow the
 * context window and cost a fortune before the first tool call.
 *
 * An unresolved placeholder is left standing rather than replaced with "" so
 * that a mistyped field is visible in the trace instead of producing an
 * objective with a hole in it.
 */
export function renderObjective(template: string, event: TriggerEvent): string {
  return template.replace(/\{\{([a-zA-Z0-9_.]+)\}\}/g, (whole, expr: string) => {
    if (expr === "now") return new Date(event.at).toISOString();
    if (expr === "trigger") return event.triggerId;
    if (expr === "kind") return event.kind;
    if (expr === "payload") return cap(stringify(event.payload));
    if (expr.startsWith("payload.")) {
      const value = dig(event.payload, expr.slice("payload.".length).split("."));
      return value === undefined ? whole : cap(stringify(value));
    }
    return whole;
  });
}

function dig(value: unknown, path: string[]): unknown {
  let cur = value;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function stringify(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    // A payload with a cycle is a payload, not a crash.
    return "[unserialisable payload]";
  }
}

function cap(s: string): string {
  return s.length > MAX_SUBSTITUTION_CHARS ? `${s.slice(0, MAX_SUBSTITUTION_CHARS)}… [truncated]` : s;
}

/* ── dedupe ──────────────────────────────────────────────────────────────── */

/**
 * A stable key over (trigger, payload).
 *
 * Stable means: the same logical event produces the same key whatever order
 * the payload's keys happen to be in, because two JSON serialisations of one
 * object are not guaranteed to agree and a dedupe that depends on key order
 * silently stops deduping.
 */
export function dedupeKeyFor(triggerId: string, payload: unknown): string {
  return `${triggerId}:${canonical(payload)}`;
}

function canonical(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${canonical(val)}`).join(",")}}`;
}

/** Remembers which keys fired recently, and forgets them on a window. */
export interface DedupeLedger {
  /** True when this key has NOT fired inside the window. Records it if so. */
  admit: (key: string, now: number, windowMs: number) => boolean;
  /** How many admissions were refused. A ledger that has never refused
   *  anything is either working perfectly or not wired in at all, and the
   *  count is how you tell. */
  suppressed: () => number;
  size: () => number;
}

/** Bounded, because a long-lived page with a chatty event source would
 *  otherwise grow one entry per event forever. */
const LEDGER_MAX = 500;

export function createDedupeLedger(): DedupeLedger {
  const seen = new Map<string, number>();
  let suppressed = 0;

  return {
    admit(key, now, windowMs) {
      const last = seen.get(key);
      if (last !== undefined && now - last < windowMs) {
        suppressed += 1;
        return false;
      }
      seen.set(key, now);
      if (seen.size > LEDGER_MAX) {
        // Drop the oldest. Map preserves insertion order, but a re-admitted
        // key keeps its original position, so re-set it above to refresh —
        // done by delete-then-set here to keep eviction honest.
        for (const [k, at] of seen) {
          if (now - at >= windowMs) seen.delete(k);
          if (seen.size <= LEDGER_MAX) break;
        }
        while (seen.size > LEDGER_MAX) {
          const oldest = seen.keys().next().value;
          if (oldest === undefined) break;
          seen.delete(oldest);
        }
      }
      return true;
    },
    suppressed: () => suppressed,
    size: () => seen.size,
  };
}

/* ── validation ──────────────────────────────────────────────────────────── */

/**
 * A trigger that cannot fire is rejected at save time.
 *
 * Same principle as `dodValidate` refusing a definition of done that cannot
 * fail: the expensive version of this mistake is the one you find out about
 * three weeks later, when you notice the daily digest you configured has never
 * arrived and there is nothing anywhere that says why.
 */
export function validateTrigger(spec: TriggerSpec): { ok: true } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];

  if (!spec.id.trim()) reasons.push("A trigger needs an id.");
  if (!spec.objectiveTemplate.trim()) reasons.push("A trigger needs an objective; an empty one gives the agent nothing to do.");
  if (!spec.dodId.trim()) reasons.push("A trigger needs a definition of done. A run nobody judges cannot report whether it worked.");
  if (!spec.configId.trim()) reasons.push("A trigger needs a loop configuration, which is where its budget comes from.");

  switch (spec.kind) {
    case "schedule": {
      const parsed = parseSchedule(spec.match);
      if (!parsed.ok) reasons.push(parsed.error);
      break;
    }
    case "event":
      if (!spec.match.trim()) reasons.push("An event trigger needs an event name, or `*` for every event.");
      break;
    case "file":
      if (!spec.match.trim().startsWith("/")) reasons.push("A file trigger watches an absolute VFS path, e.g. /notes.");
      break;
    case "manual":
    case "eval":
      break;
    default:
      reasons.push(`Unknown trigger kind: ${String(spec.kind)}.`);
  }

  // A template naming a field the payload will never carry is the commonest
  // way a trigger fires and produces a useless objective. Only warn on the
  // kinds whose payload shape is known.
  if (spec.kind === "schedule" && /\{\{payload/.test(spec.objectiveTemplate)) {
    reasons.push("A scheduled trigger has no payload, so {{payload}} would never resolve. Use {{now}}.");
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/* ── the decision ────────────────────────────────────────────────────────── */

export type FireDecision =
  | { fire: true; event: TriggerEvent; objective: string }
  | { fire: false; reason: "disabled" | "kind_mismatch" | "no_match" | "duplicate" | "invalid"; detail: string };

export interface FireInput {
  spec: TriggerSpec;
  kind: TriggerKind;
  /** The bus event name, or the written VFS path. Unused for a schedule. */
  signal: string;
  payload: unknown;
  now: number;
  dedupeMs: number;
  ledger: DedupeLedger;
}

/**
 * The whole of Layer 1's decision, in one pure function.
 *
 * It returns a REASON when it declines rather than a bare false, because
 * "nothing happened" is the single least debuggable state a trigger layer can
 * be in, and the reason is what the UI shows next to a trigger that has never
 * fired.
 */
export function decideFire(input: FireInput): FireDecision {
  const { spec, kind, signal, payload, now, dedupeMs, ledger } = input;

  if (!spec.enabled) return { fire: false, reason: "disabled", detail: "The trigger is switched off." };
  if (spec.kind !== kind) {
    return { fire: false, reason: "kind_mismatch", detail: `This is a ${kind} signal and the trigger listens for ${spec.kind}.` };
  }

  const valid = validateTrigger(spec);
  if (!valid.ok) return { fire: false, reason: "invalid", detail: valid.reasons.join(" ") };

  if (kind === "event" && !eventMatches(spec.match, signal)) {
    return { fire: false, reason: "no_match", detail: `"${signal}" does not match "${spec.match}".` };
  }
  if (kind === "file" && !pathMatches(spec.match, signal)) {
    return { fire: false, reason: "no_match", detail: `"${signal}" is not under "${spec.match}".` };
  }
  if (kind === "schedule" && !isDue(spec, now)) {
    return { fire: false, reason: "no_match", detail: "Not due yet." };
  }

  const dedupeKey = dedupeKeyFor(spec.id, kind === "schedule" ? { slot: Math.floor(now / 1000) } : { signal, payload });
  if (!ledger.admit(dedupeKey, now, dedupeMs)) {
    return { fire: false, reason: "duplicate", detail: `An identical event fired within the last ${Math.round(dedupeMs / 1000)}s.` };
  }

  const event: TriggerEvent = { triggerId: spec.id, kind, at: now, payload, dedupeKey };
  return { fire: true, event, objective: renderObjective(spec.objectiveTemplate, event) };
}

/** A trigger the UI can show as new. Kept here so the defaults live beside the
 *  validator that has to accept them. */
export function newTrigger(patch: Partial<TriggerSpec> & { id: string; createdAt: number }): TriggerSpec {
  return {
    kind: "event",
    match: "",
    enabled: false,
    configId: "default",
    dodId: "exploratory",
    objectiveTemplate: "",
    firedCount: 0,
    ...patch,
  };
}
