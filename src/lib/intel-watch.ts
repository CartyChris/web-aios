import type { DefinitionOfDone, TriggerSpec } from "./harness/types";
import { newTrigger, validateTrigger, parseSchedule, nextDue } from "./harness/triggers";

/* ────────────────────────────────────────────────────────────────────────────
   Intel watchlists — the pure half.

   The Intel app collects signals by asking a model to extract items from a
   page. Pulling the same page twice used to produce every item twice, which
   made "what is new" unanswerable: everything was new, every time. So the
   first job here is identity. A signal is the same signal when its source and
   its normalised title agree, and a re-pull MERGES into what is already there
   instead of stacking a copy on top.

   On top of that identity sits the watchlist: a saved filter plus a snapshot
   of what matched the last time the user marked it seen. The diff between
   that snapshot and now is the "what changed since last time" view, and every
   count it produces is a count of real rows, never an estimate.

   The schedule is not reinvented. A watch that refreshes on a timer is a
   harness schedule trigger, built with the harness's own `newTrigger` and
   admitted by its own `validateTrigger`, so it shows up in Harness beside
   every other trigger, obeys the global Armed switch, and lands in the same
   decision ledger.

   PURE: no DOM, no storage, no clock, no randomness. `now` and ids are
   injected, which is what lets every function below be tested at a fixed
   instant.
   ──────────────────────────────────────────────────────────────────────────── */

export type Severity = "low" | "medium" | "high" | "critical";

export const SEVERITY_ORDER: readonly Severity[] = ["low", "medium", "high", "critical"];

export function severityRank(s: Severity): number {
  return SEVERITY_ORDER.indexOf(s);
}

export function asSeverity(v: unknown): Severity {
  return typeof v === "string" && (SEVERITY_ORDER as readonly string[]).includes(v) ? (v as Severity) : "low";
}

/** The fields of a stored signal this module reads. The app's own type is a
 *  superset; structural typing lets it pass straight through. */
export interface WatchSignal {
  id: string;
  title: string;
  body: string;
  source: string;
  url?: string;
  severity: Severity;
  tags: string[];
  ts: number;
  read?: boolean;
  /** Which feed produced it. Absent on signals collected before this existed. */
  feedId?: string;
  /** When a later pull last changed it. */
  updatedAt?: number;
}

export interface IncomingSignal {
  title: string;
  body?: string;
  source: string;
  url?: string;
  severity?: unknown;
  tags?: unknown;
}

/* ── identity ────────────────────────────────────────────────────────────── */

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Same source and same words in the title: the same signal. Case, curly
 *  quotes and punctuation do not make a new story. */
export function fingerprint(s: { title: string; source: string }): string {
  return `${normalizeText(s.source)}|${normalizeText(s.title)}`;
}

/* ── merging a pull into the store ───────────────────────────────────────── */

export interface MergeResult<T extends WatchSignal> {
  signals: T[];
  /** Ids of rows that did not exist before this pull. */
  addedIds: string[];
  added: number;
  /** Existing rows whose severity, body, url or tags this pull changed. */
  updated: number;
  /** Existing rows this pull saw again with nothing new to say. */
  unchanged: number;
  /** Rows dropped off the end to stay under the cap. */
  evicted: number;
}

export interface MergeOptions {
  now: number;
  makeId: () => string;
  feedId?: string;
  /** Hard ceiling on stored signals; the oldest fall off first. */
  cap?: number;
}

function cleanTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const t of v) {
    const s = String(t ?? "").trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out.slice(0, 12);
}

/**
 * Merge freshly extracted items into the stored signals.
 *
 * An item whose fingerprint is already stored updates that row in place (it
 * keeps its id, its first-seen time and its read flag) rather than appearing
 * twice. A duplicate inside the same batch merges into its first occurrence.
 * New rows go on top, newest pull first, which is the order the list shows.
 */
export function mergeSignals<T extends WatchSignal>(existing: T[], incoming: IncomingSignal[], opts: MergeOptions): MergeResult<T> {
  const cap = opts.cap ?? 500;
  const working = existing.slice();
  const index = new Map<string, number>();
  working.forEach((s, i) => {
    const fp = fingerprint(s);
    if (!index.has(fp)) index.set(fp, i);
  });

  const fresh: T[] = [];
  const freshIndex = new Map<string, number>();
  const touched = new Set<number>();
  const hit = new Set<number>();

  for (const item of incoming) {
    const title = String(item?.title ?? "").trim();
    if (!title) continue;
    const source = String(item.source ?? "").trim();
    const body = String(item.body ?? "").trim();
    const severity = asSeverity(item.severity);
    const tags = cleanTags(item.tags);
    const url = typeof item.url === "string" && item.url ? item.url : undefined;
    const fp = fingerprint({ title, source });

    const fi = freshIndex.get(fp);
    if (fi !== undefined) {
      // A repeat inside one batch: fold it into the first copy, keep the higher
      // severity so a duplicate cannot quietly downgrade a critical item.
      const cur = fresh[fi]!;
      fresh[fi] = {
        ...cur,
        severity: severityRank(severity) > severityRank(cur.severity) ? severity : cur.severity,
        body: cur.body || body,
        tags: [...new Set([...cur.tags, ...tags])],
      };
      continue;
    }

    const ei = index.get(fp);
    if (ei !== undefined) {
      hit.add(ei);
      const cur = working[ei]!;
      const nextTags = [...new Set([...cur.tags, ...tags])];
      const nextBody = body || cur.body;
      const nextUrl = url ?? cur.url;
      const changed =
        cur.severity !== severity || nextBody !== cur.body || nextUrl !== cur.url || nextTags.length !== cur.tags.length;
      if (changed) {
        working[ei] = { ...cur, severity, body: nextBody, url: nextUrl, tags: nextTags, updatedAt: opts.now };
        touched.add(ei);
      }
      continue;
    }

    const row = {
      id: opts.makeId(),
      title,
      body,
      source,
      ...(url ? { url } : {}),
      severity,
      tags,
      ts: opts.now,
      ...(opts.feedId ? { feedId: opts.feedId } : {}),
    } as T;
    freshIndex.set(fp, fresh.length);
    fresh.push(row);
  }

  const all = [...fresh, ...working];
  const kept = all.slice(0, cap);
  return {
    signals: kept,
    addedIds: fresh.map((s) => s.id),
    added: fresh.length,
    updated: touched.size,
    unchanged: hit.size - touched.size,
    evicted: all.length - kept.length,
  };
}

/* ── parsing the model's extraction ──────────────────────────────────────── */

/**
 * Pull the JSON array out of a model reply. Models wrap JSON in prose and code
 * fences often enough that a bare JSON.parse is a coin toss; anything that is
 * not an array of objects is an error rather than a guess.
 */
export function parseExtraction(text: string): Array<Record<string, unknown>> {
  const s = text.indexOf("[");
  const e = text.lastIndexOf("]");
  if (s === -1 || e <= s) throw new Error("The model did not return a JSON array.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(s, e + 1));
  } catch {
    throw new Error("The model's JSON did not parse.");
  }
  if (!Array.isArray(parsed)) throw new Error("Unexpected response shape.");
  return parsed.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x));
}

/* ── watchlists ──────────────────────────────────────────────────────────── */

export interface SeenEntry {
  /** Severity at the moment it was marked seen. */
  s: Severity;
  /** Title, so a row that has since vanished can still be named. */
  t: string;
}

export interface WatchRefreshResult {
  at: number;
  pulled: number;
  failed: number;
  added: number;
  updated: number;
}

export interface Watch {
  id: string;
  name: string;
  /** Whitespace-separated terms; every one must appear. Empty matches all. */
  query: string;
  minSeverity: Severity;
  /** Feeds this watch refreshes and matches. Empty means every feed. */
  feedIds: string[];
  createdAt: number;
  /** fingerprint -> what it looked like when the user last marked it seen. */
  seen: Record<string, SeenEntry>;
  seenAt: number;
  /** The harness trigger this watch owns, when it has a schedule. */
  triggerId?: string;
  /** The trigger `lastFiredAt` this watch has already refreshed for. */
  handledFireAt?: number;
  last?: WatchRefreshResult;
  lastError?: string;
}

/** A snapshot remembers at most this many rows; a watch over "everything"
 *  should not copy the whole store into itself. */
export const SEEN_CAP = 400;

export function queryTerms(query: string): string[] {
  return normalizeText(query).split(" ").filter(Boolean);
}

export function matchesWatch(s: WatchSignal, w: Pick<Watch, "query" | "minSeverity" | "feedIds">, feedNames: Record<string, string>): boolean {
  if (severityRank(s.severity) < severityRank(w.minSeverity)) return false;
  if (w.feedIds.length) {
    const byId = s.feedId !== undefined && w.feedIds.includes(s.feedId);
    // Signals from before feedId existed are matched on the feed's name.
    const byName = s.feedId === undefined && w.feedIds.some((id) => feedNames[id] !== undefined && feedNames[id] === s.source);
    if (!byId && !byName) return false;
  }
  const terms = queryTerms(w.query);
  if (!terms.length) return true;
  const hay = ` ${normalizeText([s.title, s.body, s.source, ...s.tags].join(" "))} `;
  return terms.every((t) => hay.includes(t));
}

export function snapshotOf(matches: WatchSignal[]): Record<string, SeenEntry> {
  const out: Record<string, SeenEntry> = {};
  let n = 0;
  for (const s of matches) {
    if (n >= SEEN_CAP) break;
    const fp = fingerprint(s);
    if (out[fp]) continue;
    out[fp] = { s: s.severity, t: s.title };
    n += 1;
  }
  return out;
}

export interface NewWatchInput {
  id: string;
  name: string;
  query: string;
  minSeverity: Severity;
  feedIds?: string[];
  now: number;
  signals: WatchSignal[];
  feedNames: Record<string, string>;
}

/** A new watch starts with everything that matches today marked seen, so its
 *  first diff is about change, not about the backlog. */
export function createWatch(input: NewWatchInput): Watch {
  const base = { query: input.query.trim(), minSeverity: input.minSeverity, feedIds: input.feedIds ?? [] };
  const matches = input.signals.filter((s) => matchesWatch(s, base, input.feedNames));
  return {
    id: input.id,
    name: input.name.trim() || "Watch",
    ...base,
    createdAt: input.now,
    seen: snapshotOf(matches),
    seenAt: input.now,
  };
}

/** Mark everything that matches now as seen. */
export function markSeen(w: Watch, signals: WatchSignal[], feedNames: Record<string, string>, now: number): Watch {
  return { ...w, seen: snapshotOf(signals.filter((s) => matchesWatch(s, w, feedNames))), seenAt: now };
}

/** A sensible default name for a watch saved from the current filter. */
export function watchNameFor(query: string, minSeverity: Severity | "all"): string {
  const q = query.trim();
  // "critical+" would be a floor with nothing above it.
  const sev = minSeverity === "all" || minSeverity === "low" ? "" : minSeverity === "critical" ? "critical" : `${minSeverity}+`;
  if (q && sev) return `${q} (${sev})`;
  if (q) return q;
  if (sev) return `${sev[0]!.toUpperCase()}${sev.slice(1)} signals`;
  return "All signals";
}

/** An existing watch with the same scope, so "Watch this" twice on one filter
 *  opens the first watch instead of making a second copy of it. */
export function findWatchByScope(watches: Watch[], scope: Pick<Watch, "query" | "minSeverity" | "feedIds">): Watch | undefined {
  const terms = queryTerms(scope.query).sort().join(" ");
  const feeds = [...scope.feedIds].sort().join(",");
  return watches.find(
    (w) => w.minSeverity === scope.minSeverity && queryTerms(w.query).sort().join(" ") === terms && [...w.feedIds].sort().join(",") === feeds,
  );
}

export interface SeverityChange<T extends WatchSignal = WatchSignal> {
  signal: T;
  from: Severity;
}

export interface WatchDiff<T extends WatchSignal = WatchSignal> {
  matches: T[];
  /** Matching now, not in the snapshot. */
  fresh: T[];
  escalated: SeverityChange<T>[];
  deescalated: SeverityChange<T>[];
  /** In the snapshot, no longer matching (deleted, evicted or filtered out). */
  gone: Array<{ fp: string; title: string; severity: Severity }>;
  changed: number;
}

export function diffWatch<T extends WatchSignal>(signals: T[], w: Watch, feedNames: Record<string, string>): WatchDiff<T> {
  const matches = signals.filter((s) => matchesWatch(s, w, feedNames));
  const fresh: T[] = [];
  const escalated: SeverityChange<T>[] = [];
  const deescalated: SeverityChange<T>[] = [];
  const present = new Set<string>();

  for (const s of matches) {
    const fp = fingerprint(s);
    if (present.has(fp)) continue;
    present.add(fp);
    const was = w.seen[fp];
    if (!was) {
      fresh.push(s);
      continue;
    }
    const d = severityRank(s.severity) - severityRank(was.s);
    if (d > 0) escalated.push({ signal: s, from: was.s });
    else if (d < 0) deescalated.push({ signal: s, from: was.s });
  }

  const gone = Object.entries(w.seen)
    .filter(([fp]) => !present.has(fp))
    .map(([fp, e]) => ({ fp, title: e.t, severity: e.s }));

  return { matches, fresh, escalated, deescalated, gone, changed: fresh.length + escalated.length + deescalated.length + gone.length };
}

/** Feeds a refresh of this watch should pull. */
export function feedsForWatch<F extends { id: string }>(w: Pick<Watch, "feedIds">, feeds: F[]): F[] {
  return w.feedIds.length ? feeds.filter((f) => w.feedIds.includes(f.id)) : feeds.slice();
}

/* ── schedules, through the harness trigger layer ────────────────────────── */

export const WATCH_SCHEDULES: ReadonlyArray<{ match: string; label: string }> = [
  { match: "every:1h", label: "Hourly" },
  { match: "every:6h", label: "Every 6 hours" },
  { match: "every:24h", label: "Daily" },
  { match: "at:08:00", label: "Daily at 08:00" },
];

export const WATCH_TRIGGER_PREFIX = "trg_intel_";

export function watchTriggerId(watchId: string): string {
  return `${WATCH_TRIGGER_PREFIX}${watchId}`;
}

/** Braces are stripped from user text before it enters an objective template:
 *  a watch named "{{payload}}" would otherwise fail validation or be
 *  substituted as though it were a placeholder. */
function templateSafe(s: string): string {
  return s.replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
}

export function watchObjective(w: Pick<Watch, "name" | "query" | "minSeverity">, feedNames: string[], reportPath: string): string {
  const name = templateSafe(w.name) || "Watch";
  const scope = [
    w.query.trim() ? `terms "${templateSafe(w.query)}"` : "",
    w.minSeverity !== "low" ? `${w.minSeverity} and above` : "",
    feedNames.length ? `feeds: ${feedNames.map(templateSafe).join(", ")}` : "all feeds",
  ].filter(Boolean).join("; ");
  return (
    `Scheduled refresh of the Intel watch "${name}" (${scope}) at {{now}}. ` +
    `The Intel app pulls the feeds itself when this trigger fires and writes the change report to ${reportPath}. ` +
    `Call no tools. Reply with one sentence confirming the refresh was scheduled.`
  );
}

/**
 * The definition of done a watch's scheduled run is judged against.
 *
 * The harness starts a run every time a trigger fires. The pull itself is done
 * by the Intel app, so the run only has to acknowledge the refresh, and this
 * DoD says exactly that in code: the answer mentions the refresh, and the run
 * stayed small. Without it the run falls back to the exploratory DoD, which
 * waits for a person — every scheduled refresh would then leave a job reading
 * "waiting on a human" that no human needs to answer.
 */
export const INTEL_REFRESH_DOD: DefinitionOfDone = {
  id: "intel-watch-refresh",
  label: "Intel watch refresh, acknowledged",
  owner: "Intel app",
  passThreshold: 1,
  criteria: [
    {
      id: "ack",
      label: "Acknowledged the refresh",
      expectation: "The answer confirms the Intel watch refresh and uses the word refresh.",
      check: { kind: "regex", pattern: "refresh", flags: "i" },
      by: "fixed",
      weight: 1,
      required: true,
    },
    {
      id: "small",
      label: "Stayed small",
      expectation: "The acknowledgement took at most three loop steps.",
      check: { kind: "max_steps", value: 3 },
      by: "fixed",
      weight: 1,
      required: true,
    },
  ],
};

export type BuiltTrigger = { ok: true; spec: TriggerSpec } | { ok: false; reasons: string[] };

export function buildWatchTrigger(
  w: Pick<Watch, "id" | "name" | "query" | "minSeverity">,
  match: string,
  now: number,
  feedNames: string[],
  reportPath: string,
): BuiltTrigger {
  const spec = newTrigger({
    id: watchTriggerId(w.id),
    createdAt: now,
    kind: "schedule",
    match,
    enabled: true,
    configId: "default",
    dodId: INTEL_REFRESH_DOD.id,
    objectiveTemplate: watchObjective(w, feedNames, reportPath),
  });
  const v = validateTrigger(spec);
  return v.ok ? { ok: true, spec } : { ok: false, reasons: v.reasons };
}

export type ScheduleState =
  | { kind: "none" }
  /** The watch points at a trigger that no longer exists (removed in Harness). */
  | { kind: "missing"; triggerId: string }
  | {
    kind: "scheduled";
    triggerId: string;
    match: string;
    label: string;
    enabled: boolean;
    firedCount: number;
    lastFiredAt?: number;
    /** Next due instant by the harness's own clock rules; null when the
     *  schedule text no longer parses. */
    nextAt: number | null;
  };

export function scheduleLabel(match: string): string {
  return WATCH_SCHEDULES.find((s) => s.match === match)?.label ?? match;
}

export function scheduleState(w: Pick<Watch, "triggerId">, triggers: TriggerSpec[], now: number): ScheduleState {
  if (!w.triggerId) return { kind: "none" };
  const spec = triggers.find((t) => t.id === w.triggerId);
  if (!spec) return { kind: "missing", triggerId: w.triggerId };
  const parsed = parseSchedule(spec.match);
  return {
    kind: "scheduled",
    triggerId: spec.id,
    match: spec.match,
    label: scheduleLabel(spec.match),
    enabled: spec.enabled,
    firedCount: spec.firedCount,
    ...(spec.lastFiredAt !== undefined ? { lastFiredAt: spec.lastFiredAt } : {}),
    nextAt: parsed.ok ? nextDue(parsed.schedule, spec.lastFiredAt, now) : null,
  };
}

/**
 * Watches whose trigger has fired since they last refreshed for it.
 *
 * `lastFiredAt` only moves when the harness actually admitted and started a
 * run (a busy or capped decline does not bump it), so it is the one field that
 * means "the schedule really fired". A fire that happened while Intel was not
 * loaded is still owed, and is handled once when it next loads.
 */
export function firesToHandle(watches: Watch[], triggers: TriggerSpec[]): Array<{ watchId: string; firedAt: number }> {
  const out: Array<{ watchId: string; firedAt: number }> = [];
  for (const w of watches) {
    if (!w.triggerId) continue;
    const spec = triggers.find((t) => t.id === w.triggerId);
    if (!spec || spec.lastFiredAt === undefined) continue;
    if (w.handledFireAt !== undefined && spec.lastFiredAt <= w.handledFireAt) continue;
    out.push({ watchId: w.id, firedAt: spec.lastFiredAt });
  }
  return out;
}

/* ── text: markdown export, AI context, time ─────────────────────────────── */

export function slugify(s: string): string {
  const slug = normalizeText(s).replace(/[^a-z0-9 ]/g, "").trim().replace(/ /g, "-").slice(0, 40).replace(/-+$/, "");
  return slug || "watch";
}

export function watchReportPath(w: Pick<Watch, "id" | "name">): string {
  return `/intel/watches/${slugify(w.name)}-${w.id.slice(-4)}.md`;
}

/** 2026-09-25T10-04-12 — sortable, and legal in every file system. */
export function fileStamp(now: number): string {
  return new Date(now).toISOString().slice(0, 19).replace(/:/g, "-");
}

function isoMinute(ts: number): string {
  return `${new Date(ts).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function safeUrl(u: string | undefined): string | undefined {
  // encodeURIComponent leaves parentheses alone, and a bare ")" ends a
  // markdown link early, so these three are escaped by hand.
  return u && /^https?:\/\//i.test(u) ? u.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\s/g, "%20") : undefined;
}

export function signalLine(s: WatchSignal): string {
  const url = safeUrl(s.url);
  const src = url ? `[${oneLine(s.source)}](${url})` : oneLine(s.source);
  const tags = s.tags.length ? ` ${s.tags.map((t) => `#${oneLine(t).replace(/\s+/g, "-")}`).join(" ")}` : "";
  const body = s.body ? ` ${oneLine(s.body)}` : "";
  return `- **[${s.severity}] ${oneLine(s.title)}**${body} (${src}, ${isoMinute(s.ts)})${tags}`;
}

function bySeverity(signals: WatchSignal[]): string[] {
  const lines: string[] = [];
  for (const sev of [...SEVERITY_ORDER].reverse()) {
    const rows = signals.filter((s) => s.severity === sev);
    if (!rows.length) continue;
    lines.push(`### ${sev[0]!.toUpperCase()}${sev.slice(1)} (${rows.length})`, "", ...rows.map(signalLine), "");
  }
  return lines;
}

/** The current signal list, as a document a person can keep. */
export function signalsMarkdown(opts: { title: string; signals: WatchSignal[]; now: number; note?: string }): string {
  const { title, signals, now, note } = opts;
  const lines = [
    `# ${oneLine(title)}`,
    "",
    `Exported ${isoMinute(now)}. ${signals.length} signal${signals.length === 1 ? "" : "s"}${note ? ` (${oneLine(note)})` : ""}.`,
    "",
  ];
  if (!signals.length) lines.push("Nothing matched.", "");
  else lines.push(...bySeverity(signals));
  return lines.join("\n").trimEnd() + "\n";
}

/** A watch's change report: what is new, what moved, what went, then the
 *  full current set. */
export function watchReportMarkdown(w: Watch, diff: WatchDiff, now: number, feedNames: string[]): string {
  const scope = [
    w.query.trim() ? `terms: ${oneLine(w.query)}` : "all terms",
    `severity: ${w.minSeverity}+`,
    feedNames.length ? `feeds: ${feedNames.map(oneLine).join(", ")}` : "all feeds",
  ].join(" | ");
  const lines = [
    `# Intel watch: ${oneLine(w.name)}`,
    "",
    `Generated ${isoMinute(now)}. Changes are since ${isoMinute(w.seenAt)}, when this watch was last marked seen.`,
    "",
    `Scope: ${scope}`,
    "",
    `**${diff.fresh.length} new, ${diff.escalated.length} escalated, ${diff.deescalated.length} de-escalated, ${diff.gone.length} no longer matching. ${diff.matches.length} matching now.**`,
    "",
  ];
  if (diff.fresh.length) lines.push("## New", "", ...diff.fresh.map(signalLine), "");
  if (diff.escalated.length) {
    lines.push("## Escalated", "", ...diff.escalated.map((c) => `${signalLine(c.signal)} (was ${c.from})`), "");
  }
  if (diff.deescalated.length) {
    lines.push("## De-escalated", "", ...diff.deescalated.map((c) => `${signalLine(c.signal)} (was ${c.from})`), "");
  }
  if (diff.gone.length) {
    lines.push("## No longer matching", "", ...diff.gone.map((g) => `- [${g.severity}] ${oneLine(g.title)}`), "");
  }
  if (!diff.changed) lines.push("Nothing has changed since the last look.", "");
  lines.push("## Everything matching now", "");
  if (diff.matches.length) lines.push(...bySeverity(diff.matches));
  else lines.push("Nothing matches.", "");
  return lines.join("\n").trimEnd() + "\n";
}

/** What "Ask AI about this" sends as context for one signal. */
export function signalContext(s: WatchSignal): string {
  const head = [
    `Title: ${oneLine(s.title)}`,
    `Severity (as extracted): ${s.severity}`,
    `Source: ${oneLine(s.source)}${s.url ? ` <${s.url}>` : ""}`,
    `First seen: ${isoMinute(s.ts)}${s.updatedAt ? `; last changed ${isoMinute(s.updatedAt)}` : ""}`,
    s.tags.length ? `Tags: ${s.tags.join(", ")}` : "",
  ].filter(Boolean);
  return `${head.join("\n")}\n\n${s.body || "(no summary was extracted)"}`;
}

/** "3m ago", "2h ago", "4d ago" against an injected clock. */
export function agoText(ts: number, now: number): string {
  const d = Math.max(0, now - ts);
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

/** "in 2h 5m", or "due now" when the instant has passed. */
export function untilText(at: number, now: number): string {
  const d = at - now;
  if (d <= 0) return "due now";
  const m = Math.ceil(d / 60_000);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `in ${h}h ${rm}m` : `in ${h}h`;
  const days = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `in ${days}d ${rh}h` : `in ${days}d`;
}
