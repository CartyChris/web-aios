"use client";

import { useCallback, useMemo, useState } from "react";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { useVFS } from "@/kernel/vfs";
import { bus } from "@/kernel/bus";
import { ask } from "@/lib/useAI";
import type { AppProps } from "@/kernel/types";
import { uid, relTime, download } from "@/lib/format";
import { useNow } from "@/lib/useNow";
import { Tabs, Empty, ErrorNote, Spinner, Markdown, CopyButton } from "./_ui";
import { cn } from "@/lib/cn";
import { Icon } from "@/shell/icons";
import { useJobs, isActive } from "@/kernel/jobs";
import { useTriggers } from "@/kernel/triggers";
import { useHarness } from "@/kernel/harness";
import {
  mergeSignals, parseExtraction, createWatch, markSeen, diffWatch, feedsForWatch, findWatchByScope,
  buildWatchTrigger, scheduleState, firesToHandle, watchReportMarkdown, watchReportPath, signalsMarkdown,
  signalContext, watchNameFor, fileStamp, agoText, untilText, WATCH_SCHEDULES, WATCH_TRIGGER_PREFIX, INTEL_REFRESH_DOD,
  type IncomingSignal, type MergeResult, type Watch, type WatchDiff,
} from "@/lib/intel-watch";

/* ────────────────────────────────────────────────────────────────────────────
   Signals — ported from the "add-fifteen-new-features" intel dashboard.

   The original was a Postgres-backed Next.js app with seeded demo data. A
   desktop app cannot assume a database, so the model is inverted: you add feeds
   and signals yourself (or pull them through the OS proxy), and the dashboard
   is a live view over what you actually collected. No seeded fiction — a chart
   of invented numbers is worse than an empty one, because it looks like data.

   Watches (added later) are saved filters with memory: each remembers what
   matched when you last marked it seen, so it can say what is new, what
   escalated and what went away since then. A watch can refresh on a schedule,
   and that schedule is a real harness trigger (see lib/intel-watch.ts), so it
   is visible in Harness and obeys the global Armed switch.
   ──────────────────────────────────────────────────────────────────────────── */

export interface Signal {
  id: string;
  title: string;
  body: string;
  source: string;
  url?: string;
  severity: "low" | "medium" | "high" | "critical";
  tags: string[];
  ts: number;
  read?: boolean;
  /** The feed that produced it. Absent on signals pulled before watches existed. */
  feedId?: string;
  /** When a later pull last changed it. */
  updatedAt?: number;
}

export interface Feed { id: string; name: string; url: string; lastPulled?: number }

interface IntelState {
  signals: Signal[];
  feeds: Feed[];
  watches: Watch[];
  addSignal: (s: Omit<Signal, "id" | "ts">) => void;
  addMany: (s: Array<Omit<Signal, "id" | "ts">>) => void;
  /** Add a pull's items, merging any the store already holds instead of
   *  stacking duplicates. Returns the real counts. */
  mergeMany: (items: IncomingSignal[], feedId?: string) => MergeResult<Signal>;
  patch: (id: string, p: Partial<Signal>) => void;
  remove: (id: string) => void;
  addFeed: (name: string, url: string) => void;
  removeFeed: (id: string) => void;
  touchFeed: (id: string) => void;
  clear: () => void;
  addWatch: (w: Watch) => void;
  patchWatch: (id: string, p: Partial<Watch>) => void;
  removeWatch: (id: string) => void;
}

const useIntel = create<IntelState>()(
  persist(
    (set, get) => ({
      signals: [], feeds: [], watches: [],
      addSignal: (s) => set((st) => ({ signals: [{ ...s, id: uid("sig"), ts: Date.now() }, ...st.signals] })),
      addMany: (list) => set((st) => ({ signals: [...list.map((s) => ({ ...s, id: uid("sig"), ts: Date.now() })), ...st.signals].slice(0, 500) })),
      mergeMany: (items, feedId) => {
        const r = mergeSignals(get().signals, items, { now: Date.now(), makeId: () => uid("sig"), feedId, cap: 500 });
        set({ signals: r.signals });
        return r;
      },
      patch: (id, p) => set((st) => ({ signals: st.signals.map((s) => (s.id === id ? { ...s, ...p } : s)) })),
      remove: (id) => set((st) => ({ signals: st.signals.filter((s) => s.id !== id) })),
      addFeed: (name, url) => set((st) => ({ feeds: [...st.feeds, { id: uid("feed"), name, url }] })),
      // A watch scoped to a feed that no longer exists would otherwise go on
      // refreshing nothing; the stale id is dropped with the feed.
      removeFeed: (id) => set((st) => ({
        feeds: st.feeds.filter((f) => f.id !== id),
        watches: st.watches.map((w) => (w.feedIds.includes(id) ? { ...w, feedIds: w.feedIds.filter((x) => x !== id) } : w)),
      })),
      touchFeed: (id) => set((st) => ({ feeds: st.feeds.map((f) => (f.id === id ? { ...f, lastPulled: Date.now() } : f)) })),
      clear: () => set({ signals: [] }),
      addWatch: (w) => set((st) => ({ watches: [w, ...st.watches].slice(0, 50) })),
      patchWatch: (id, p) => set((st) => ({ watches: st.watches.map((w) => (w.id === id ? { ...w, ...p } : w)) })),
      removeWatch: (id) => set((st) => ({ watches: st.watches.filter((w) => w.id !== id) })),
    }),
    { name: "webaios.intel.v1", storage: createJSONStorage(() => localStorage) },
  ),
);

const SEVERITIES: Signal["severity"][] = ["low", "medium", "high", "critical"];
const SEV_COLOR: Record<Signal["severity"], string> = {
  low: "var(--muted)", medium: "var(--accent)", high: "var(--warn)", critical: "var(--danger)",
};

/** "Watch this" schedules daily by default: every fire costs one model call
 *  per feed plus one short harness run, so the cheap cadence is the default. */
const DEFAULT_SCHEDULE = "every:24h";

const feedNameMap = (feeds: Feed[]): Record<string, string> => Object.fromEntries(feeds.map((f) => [f.id, f.name]));

/* ── pulling, outside React ──────────────────────────────────────────────────
   These live at module level so a scheduled refresh can run while the Intel
   window is closed. Every pull is a live job (kernel/jobs.ts), which is also
   where the UI reads "is this busy" from — there is no second copy of that
   state to drift. */

let jobSeq = 0;
const jobIdFor = (prefix: string) => `${prefix}:${Date.now().toString(36)}${(jobSeq++).toString(36)}`;
/** Feeds and watches with a pull in flight, so two routes to the same pull
 *  (a click and a schedule) cannot run it twice at once. */
const inflight = new Set<string>();

async function pullFeed(feed: Feed, report: (detail: string) => void): Promise<{ found: number; added: number; updated: number }> {
  report("Fetching the page");
  const res = await fetch(`/api/proxy?url=${encodeURIComponent(feed.url)}&mode=text`);
  const data = await res.json().catch(() => ({ error: `The proxy answered ${res.status} with something other than JSON.` }));
  if (!res.ok || data.error) throw new Error(data.error ?? `${res.status}`);
  report("Extracting signals");
  const extracted = await ask({
    messages: [{ role: "user", content: `Source: ${feed.name} (${data.url})\n\n${(data.text ?? "").slice(0, 40_000)}` }],
    system: `Extract distinct newsworthy items from this page.

Return ONLY a JSON array: [{"title": "...", "body": "<one or two sentences>", "severity": "low"|"medium"|"high"|"critical", "tags": ["..."]}]

At most 15 items. Severity reflects how consequential the item is, not how dramatic its headline is. If the page has no real items — a nav page, a paywall, an error — return an empty array rather than inventing entries.`,
    maxTokens: 2200,
    // Machine-shaped output: the persona preamble has no business in a JSON extraction.
    persona: false,
  });
  const items = parseExtraction(extracted.text);
  const r = useIntel.getState().mergeMany(
    items.filter((x) => x.title).map((x) => ({
      title: String(x.title),
      body: String(x.body ?? ""),
      source: feed.name,
      url: typeof data.url === "string" ? data.url : undefined,
      severity: x.severity,
      tags: x.tags,
    })),
    feed.id,
  );
  useIntel.getState().touchFeed(feed.id);
  return { found: items.length, added: r.added, updated: r.updated };
}

/** One feed, as its own job. Resolves with a message worth showing, or null. */
async function runFeedPull(feed: Feed): Promise<string | null> {
  const key = `feed:${feed.id}`;
  if (inflight.has(key)) return `${feed.name} is already being pulled.`;
  inflight.add(key);
  const jobId = useJobs.getState().start({
    id: jobIdFor(`intel-feed-${feed.id}`), kind: "ai", title: `Intel: pulling ${feed.name}`, target: { appId: "intel", args: { tab: "feeds" } },
  });
  try {
    const r = await pullFeed(feed, (detail) => useJobs.getState().update(jobId, { detail }));
    const summary = r.found ? `${r.added} new, ${r.updated} updated, ${r.found} found` : "no items found on that page";
    useJobs.getState().finish(jobId, "done", summary);
    bus.emit("notify", { title: `${feed.name}: ${summary}`, kind: r.found ? "success" : "info" });
    return r.found ? null : `${feed.name}: no items found on that page.`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Pull failed.";
    useJobs.getState().finish(jobId, "error", msg);
    return `${feed.name}: ${msg}`;
  } finally {
    inflight.delete(key);
  }
}

interface BatchResult { pulled: number; failed: number; skipped: number; added: number; updated: number; errors: string[] }

/** Several feeds in sequence under one job whose progress is feeds done / total. */
async function pullSeveral(feeds: Feed[], jobId: string): Promise<BatchResult> {
  const out: BatchResult = { pulled: 0, failed: 0, skipped: 0, added: 0, updated: 0, errors: [] };
  for (const [i, f] of feeds.entries()) {
    const key = `feed:${f.id}`;
    const step = `${i + 1}/${feeds.length} ${f.name}`;
    if (inflight.has(key)) { out.skipped += 1; continue; }
    inflight.add(key);
    try {
      const r = await pullFeed(f, (d) => useJobs.getState().update(jobId, { detail: `${step}: ${d}`, progress: i / feeds.length }));
      out.pulled += 1; out.added += r.added; out.updated += r.updated;
    } catch (e) {
      out.failed += 1;
      out.errors.push(`${f.name}: ${e instanceof Error ? e.message : "pull failed"}`);
    } finally {
      inflight.delete(key);
    }
    useJobs.getState().update(jobId, { progress: (i + 1) / feeds.length });
  }
  return out;
}

async function runPullAll(): Promise<string | null> {
  const feeds = useIntel.getState().feeds;
  if (!feeds.length) return null;
  const jobId = useJobs.getState().start({
    id: jobIdFor("intel-pullall"), kind: "ai", title: `Intel: pulling ${feeds.length} feeds`, progress: 0, target: { appId: "intel", args: { tab: "feeds" } },
  });
  const r = await pullSeveral(feeds, jobId);
  const summary = `${r.added} new, ${r.updated} updated from ${r.pulled} feed${r.pulled === 1 ? "" : "s"}${r.failed ? `, ${r.failed} failed` : ""}${r.skipped ? `, ${r.skipped} already running` : ""}`;
  useJobs.getState().finish(jobId, r.pulled === 0 && r.failed > 0 ? "error" : "done", summary);
  return r.errors.length ? r.errors.join(" ") : null;
}

/** Refresh one watch: pull its feeds, then measure what changed since it was
 *  last marked seen. A scheduled refresh also writes the change report to
 *  Files, because nobody was watching when it ran. */
async function refreshWatch(watchId: string, reason: "manual" | "schedule"): Promise<string | null> {
  const st = useIntel.getState();
  const w = st.watches.find((x) => x.id === watchId);
  if (!w) return null;
  const key = `watch:${w.id}`;
  if (inflight.has(key)) return `${w.name} is already refreshing.`;
  const feeds = feedsForWatch(w, st.feeds);
  const jobId = useJobs.getState().start({
    id: jobIdFor(`intel-watch-${w.id}`),
    kind: reason === "schedule" ? "task" : "ai",
    title: `Intel watch: ${w.name}${reason === "schedule" ? " (scheduled)" : ""}`,
    progress: 0,
    target: { appId: "intel", args: { tab: "watches" } },
  });
  if (!feeds.length) {
    const msg = "No feeds to pull. Add one on the Feeds tab.";
    useJobs.getState().finish(jobId, "error", msg);
    st.patchWatch(w.id, { lastError: msg });
    return `${w.name}: ${msg}`;
  }
  inflight.add(key);
  try {
    const r = await pullSeveral(feeds, jobId);
    const after = useIntel.getState();
    const cur = after.watches.find((x) => x.id === w.id);
    if (!cur) {
      useJobs.getState().finish(jobId, "done", "The watch was deleted while it refreshed.");
      return null;
    }
    const names = feedNameMap(after.feeds);
    const diff = diffWatch(after.signals, cur, names);
    const now = Date.now();
    let reportPath: string | undefined;
    if (reason === "schedule") {
      reportPath = watchReportPath(cur);
      try {
        useVFS.getState().write(reportPath, watchReportMarkdown(cur, diff, now, feedsForWatch(cur, after.feeds).map((f) => f.name)), { appId: "intel" });
      } catch {
        reportPath = undefined;
      }
    }
    after.patchWatch(cur.id, {
      last: { at: now, pulled: r.pulled, failed: r.failed, added: r.added, updated: r.updated },
      lastError: r.errors.length ? r.errors.join(" ") : undefined,
    });
    const summary = `${diff.fresh.length} new, ${diff.escalated.length} escalated since last look`;
    useJobs.getState().finish(
      jobId,
      r.pulled === 0 && r.failed > 0 ? "error" : "done",
      `${summary}${r.failed ? ` · ${r.failed} feed${r.failed === 1 ? "" : "s"} failed` : ""}`,
    );
    // Published so a Harness event trigger (e.g. "intel:*") can react to a
    // watch that changed, with the numbers in {{payload.fresh}} and friends.
    bus.emit("intel:watch-refreshed", {
      watchId: cur.id, name: cur.name, reason,
      fresh: diff.fresh.length, escalated: diff.escalated.length, deescalated: diff.deescalated.length,
      gone: diff.gone.length, matching: diff.matches.length, reportPath,
    });
    if (reason === "schedule" && (diff.fresh.length || diff.escalated.length)) {
      bus.emit("notify", {
        title: `${cur.name}: ${summary}`,
        body: reportPath ? `Report saved to ${reportPath}` : undefined,
        kind: "info",
        target: { appId: "intel", args: { tab: "watches" } },
      });
    }
    return r.errors.length ? r.errors.join(" ") : null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Refresh failed.";
    useJobs.getState().finish(jobId, "error", msg);
    useIntel.getState().patchWatch(w.id, { lastError: msg });
    return `${w.name}: ${msg}`;
  } finally {
    inflight.delete(key);
  }
}

/* ── the schedule hook-up ────────────────────────────────────────────────────
   The harness trigger layer decides WHEN (schedule grammar, Armed switch,
   dedupe, the per-session run cap) and records every decision in its ledger.
   When a trigger this app created fires, the trigger's `lastFiredAt` moves,
   and that is what starts the refresh here. The fire is marked handled before
   the pull begins, so a second store update cannot start a second pull.

   Installed when this module first loads (the first time Intel opens in a
   page session) and kept for the life of the page, so closing the window does
   not stop the schedule. A fire that happened before Intel loaded is caught up
   once, on load. */

let watcherInstalled = false;

function handleFires() {
  const st = useIntel.getState();
  for (const h of firesToHandle(st.watches, useTriggers.getState().triggers)) {
    st.patchWatch(h.watchId, { handledFireAt: h.firedAt });
    void refreshWatch(h.watchId, "schedule");
  }
}

function installWatcher() {
  if (watcherInstalled || typeof window === "undefined") return;
  watcherInstalled = true;
  useTriggers.subscribe(handleFires);
  handleFires();
}

installWatcher();

function scheduleWatch(w: Watch, match: string): string | null {
  const feeds = useIntel.getState().feeds;
  const built = buildWatchTrigger(w, match, Date.now(), feedsForWatch(w, feeds).map((f) => f.name), watchReportPath(w));
  if (!built.ok) return built.reasons.join(" ");
  // The run a fire starts is judged against this DoD. If someone deletes it in
  // Harness the trigger still works; it falls back to the exploratory DoD.
  const harness = useHarness.getState();
  if (!harness.dods.some((d) => d.id === INTEL_REFRESH_DOD.id)) harness.saveDod(INTEL_REFRESH_DOD);
  const trg = useTriggers.getState();
  const existing = trg.triggers.find((t) => t.id === built.spec.id);
  // Re-scheduling keeps the trigger's history (its fired count and the clock
  // its next slot is measured from) and does not un-pause a trigger someone
  // paused in Harness.
  trg.save(existing
    ? { ...built.spec, enabled: existing.enabled, createdAt: existing.createdAt, firedCount: existing.firedCount, lastFiredAt: existing.lastFiredAt }
    : built.spec);
  useIntel.getState().patchWatch(w.id, { triggerId: built.spec.id, handledFireAt: existing?.lastFiredAt ?? w.handledFireAt });
  return null;
}

function unscheduleWatch(w: Watch) {
  // Only ever removes a trigger this app made.
  if (w.triggerId?.startsWith(WATCH_TRIGGER_PREFIX)) useTriggers.getState().remove(w.triggerId);
  useIntel.getState().patchWatch(w.id, { triggerId: undefined });
}

function saveReport(w: Watch, diff: WatchDiff<Signal>, feeds: Feed[], now: number): string {
  const path = watchReportPath(w);
  useVFS.getState().write(path, watchReportMarkdown(w, diff, now, feedsForWatch(w, feeds).map((f) => f.name)), { appId: "intel" });
  bus.emit("notify", { title: "Watch report saved to Files", body: path, kind: "success", target: { appId: "notes", args: { path } } });
  return path;
}

function askAboutWatch(w: Watch, diff: WatchDiff<Signal>, feeds: Feed[], now: number) {
  bus.emit("aios-chat:ask", {
    prompt: `Here is what changed in my Intel watch "${w.name}" since I last looked. What matters most, what is probably noise, and what should I check next?`,
    context: { label: `Intel watch "${w.name}"`, text: watchReportMarkdown(w, diff, now, feedsForWatch(w, feeds).map((f) => f.name)).slice(0, 20_000) },
  });
}

function askAboutSignal(s: Signal) {
  bus.emit("aios-chat:ask", {
    prompt: "What does this signal mean for me, how credible is it likely to be, and what should I watch for next?",
    context: { label: `an Intel signal from ${s.source}`, text: signalContext(s) },
  });
}

export default function Intel({ args }: AppProps) {
  const intel = useIntel();
  const vfs = useVFS();
  const jobs = useJobs((s) => s.jobs);
  const triggers = useTriggers((s) => s.triggers);
  const armed = useTriggers((s) => s.armed);
  const [tab, setTab] = useState(() => (typeof args?.tab === "string" ? args.tab : "feed"));
  const [q, setQ] = useState("");
  const [sev, setSev] = useState("all");
  const [error, setError] = useState<string | null>(null);
  const [brief, setBrief] = useState("");
  const [feedName, setFeedName] = useState("");
  const [openWatch, setOpenWatch] = useState<string | null>(null);
  // Buckets are relative to the clock, so it comes from state rather than a
  // Date.now() read during render.
  const now = useNow(60_000);
  const [feedUrl, setFeedUrl] = useState("");

  // What is in flight comes from the jobs kernel, not a local flag: a pull
  // started by the schedule shows its spinner here too.
  const activeJobs = useMemo(() => jobs.filter(isActive).map((j) => j.id), [jobs]);
  const busyWith = useCallback((prefix: string) => activeJobs.some((id) => id.startsWith(`${prefix}:`)), [activeJobs]);

  const feedNames = useMemo(() => feedNameMap(intel.feeds), [intel.feeds]);

  const filtered = useMemo(() => {
    let out = intel.signals;
    if (sev !== "all") out = out.filter((s) => s.severity === sev);
    if (q.trim()) out = out.filter((s) => (s.title + s.body + s.tags.join(" ") + s.source).toLowerCase().includes(q.toLowerCase()));
    return out;
  }, [intel.signals, sev, q]);

  const stats = useMemo(() => {
    const bySev = Object.fromEntries(SEVERITIES.map((s) => [s, intel.signals.filter((x) => x.severity === s).length]));
    const day = 86_400_000;
    // Seven-day histogram, newest bucket last.
    const buckets = Array.from({ length: 7 }, (_, i) => {
      const from = now - (6 - i) * day;
      return intel.signals.filter((s) => s.ts >= from - day && s.ts < from).length;
    });
    const tags = new Map<string, number>();
    for (const s of intel.signals) for (const t of s.tags) tags.set(t, (tags.get(t) ?? 0) + 1);
    return { bySev, buckets, topTags: [...tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10) };
  }, [intel.signals, now]);

  const diffs = useMemo(
    () => new Map(intel.watches.map((w) => [w.id, diffWatch(intel.signals, w, feedNames)])),
    [intel.watches, intel.signals, feedNames],
  );

  const pull = useCallback(async (feed: Feed) => {
    setError(null);
    const msg = await runFeedPull(feed);
    if (msg) setError(msg);
  }, []);

  const pullAll = useCallback(async () => {
    setError(null);
    const msg = await runPullAll();
    if (msg) setError(msg);
  }, []);

  const writeBrief = useCallback(async () => {
    if (!intel.signals.length) return;
    setError(null); setBrief("");
    const jobId = useJobs.getState().start({
      id: jobIdFor("intel-brief"), kind: "ai", title: "Intel: writing a brief",
      detail: `${Math.min(80, intel.signals.length)} signals`, target: { appId: "intel", args: { tab: "brief" } },
    });
    let reported = 0;
    try {
      const res = await ask({
        messages: [{ role: "user", content: intel.signals.slice(0, 80).map((s) => `[${s.severity}] ${s.title} — ${s.body} (${s.source})`).join("\n") }],
        system: "Write a short intelligence brief over these signals: what matters most, what the patterns are, and what is probably noise. Cite sources by name. End with 'What is missing' — the questions these signals do not answer.",
        maxTokens: 1600,
        onDelta: (_d, f) => {
          setBrief(f);
          // A job row repainting on every token would cost more than the brief.
          if (f.length - reported >= 400) {
            reported = f.length;
            useJobs.getState().update(jobId, { detail: `${f.length} characters so far` });
          }
        },
      });
      setBrief(res.text);
      setTab("brief");
      useJobs.getState().finish(jobId, "done", `${res.text.length} characters`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Brief failed.";
      setError(msg);
      useJobs.getState().finish(jobId, "error", msg);
    }
  }, [intel.signals]);

  /** One click: save the current filter as a watch and put it on a schedule. */
  const watchThis = useCallback(() => {
    setError(null);
    const minSeverity = sev === "all" ? "low" : (sev as Signal["severity"]);
    const scope = { query: q.trim(), minSeverity, feedIds: [] as string[] };
    const existing = findWatchByScope(intel.watches, scope);
    if (existing) {
      setOpenWatch(existing.id);
      setTab("watches");
      bus.emit("notify", { title: `Already watching "${existing.name}"`, kind: "info" });
      return;
    }
    // The store caps watches at 50, and a watch pushed off the end would leave
    // its trigger firing with nothing to refresh. Refuse instead.
    if (intel.watches.length >= 50) {
      setError("You already have 50 watches. Delete one before adding another.");
      return;
    }
    const w = createWatch({
      id: uid("watch"), name: watchNameFor(q, sev as Signal["severity"] | "all"), ...scope, now: Date.now(), signals: intel.signals, feedNames,
    });
    intel.addWatch(w);
    const problem = scheduleWatch(w, DEFAULT_SCHEDULE);
    if (problem) setError(problem);
    setOpenWatch(w.id);
    setTab("watches");
  }, [q, sev, intel, feedNames]);

  const exportMarkdown = useCallback(() => {
    const t = Date.now();
    const path = `/intel/exports/signals-${fileStamp(t)}.md`;
    const note = [q.trim() ? `filter: ${q.trim()}` : "", sev !== "all" ? `severity: ${sev}` : ""].filter(Boolean).join(", ");
    vfs.write(path, signalsMarkdown({ title: "Intel signals", signals: filtered, now: t, note: note || undefined }), { appId: "intel" });
    bus.emit("notify", { title: `${filtered.length} signals exported to Files`, body: path, kind: "success", target: { appId: "notes", args: { path } } });
  }, [vfs, filtered, q, sev]);

  const askAboutList = useCallback(() => {
    const note = [q.trim() ? `filter: ${q.trim()}` : "", sev !== "all" ? `severity: ${sev}` : ""].filter(Boolean).join(", ");
    bus.emit("aios-chat:ask", {
      prompt: "What stands out in these signals, how do they connect, and what should I look into first?",
      context: {
        label: `${filtered.length} Intel signals${note ? ` (${note})` : ""}`,
        text: signalsMarkdown({ title: "Intel signals", signals: filtered.slice(0, 120), now, note: note || undefined }).slice(0, 20_000),
      },
    });
  }, [filtered, q, sev, now]);

  const maxBucket = Math.max(1, ...stats.buckets);
  const briefBusy = busyWith("intel-brief");

  return (
    <div className="flex h-full flex-col">
      <Tabs
        tabs={[
          { id: "feed", label: `Signals (${intel.signals.length})`, icon: "intel" },
          { id: "watches", label: `Watches (${intel.watches.length})`, icon: "eye" },
          { id: "dash", label: "Dashboard", icon: "system" },
          { id: "feeds", label: `Feeds (${intel.feeds.length})`, icon: "link" },
          { id: "brief", label: "Brief", icon: "report" },
        ]}
        active={tab}
        onChange={setTab}
      />

      <div className="shrink-0 border-b border-[var(--border)] px-2.5 py-1.5">
        <ErrorNote error={error} onDismiss={() => setError(null)} />
        <div className="flex flex-wrap items-center gap-1.5">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter signals…" aria-label="Filter signals" className="os-input min-w-28 flex-1 !py-1 text-[12px]" />
          {["all", ...SEVERITIES].map((s) => (
            <button key={s} onClick={() => setSev(s)} className={cn("os-btn !px-2 !py-0.5 text-[10.5px]", sev === s && "!border-[var(--accent)] !bg-[var(--accent)]/16")}>{s}</button>
          ))}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {briefBusy ? <Spinner label="Writing…" /> : <button className="os-btn !py-1 text-[11px]" onClick={writeBrief} disabled={!intel.signals.length}>Brief</button>}
          <button
            className="os-btn !py-1 text-[11px]"
            onClick={watchThis}
            title="Save this filter as a watch and refresh it daily through a Harness schedule trigger"
          >
            <Icon name="eye" size={12} /> Watch this
          </button>
          {filtered.length > 0 && (
            <>
              <button className="os-btn !py-1 text-[11px]" onClick={askAboutList} title="Ask the AIOS assistant about the signals shown">
                <Icon name="spark" size={12} /> Ask AI
              </button>
              <button className="os-btn !py-1 text-[11px]" onClick={exportMarkdown} title="Save the signals shown as a Markdown file in Files">
                <Icon name="file" size={12} /> Save .md
              </button>
            </>
          )}
          {intel.signals.length > 0 && (
            <button className="os-btn !py-1 text-[11px]" onClick={() => download(`signals-${Date.now()}.json`, JSON.stringify(intel.signals, null, 2), "application/json")}>Export</button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === "feed" && (
          filtered.length === 0 ? (
            <Empty
              icon="intel"
              title={intel.signals.length ? "Nothing matches that filter" : "No signals yet"}
              body={intel.signals.length ? undefined : "Add a feed URL on the Feeds tab and pull it. Signals are extracted from the real page — nothing here is seeded demo data."}
            />
          ) : (
            <div className="space-y-1.5">
              {filtered.map((s) => (
                <div key={s.id} className={cn("os-card !py-2", !s.read && "!border-l-2")} style={{ borderLeftColor: SEV_COLOR[s.severity] }}>
                  <div className="flex items-start gap-2">
                    <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: SEV_COLOR[s.severity] }} />
                    <div className="min-w-0 flex-1">
                      <div className="break-words text-[12.5px] font-medium leading-snug">{s.title}</div>
                      {s.body && <div className="mt-0.5 break-words text-[11.5px] leading-relaxed text-[var(--muted)]">{s.body}</div>}
                      <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-[var(--muted)]">
                        <span>{s.source}</span>
                        <span>· {relTime(s.ts)}</span>
                        {s.updatedAt && <span title="A later pull changed this signal">· updated {agoText(s.updatedAt, now)}</span>}
                        {s.tags.map((t) => <span key={t} className="os-chip !px-1.5 !py-0 !text-[9px]">{t}</span>)}
                        {s.url && <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] underline">source ↗</a>}
                      </div>
                    </div>
                    <button aria-label="Ask AI about this signal" className="shrink-0 p-0.5 text-[10px] opacity-60 hover:opacity-100" onClick={() => askAboutSignal(s)} title="Ask AI about this">
                      <Icon name="spark" size={11} />
                    </button>
                    <button aria-label="Remove signal" className="shrink-0 p-0.5 text-[10px] opacity-60 hover:opacity-100" onClick={() => intel.remove(s.id)}><Icon name="close" size={11} /></button>
                  </div>
                </div>
              ))}
            </div>
          )
        )}

        {tab === "watches" && (
          intel.watches.length === 0 ? (
            <Empty
              icon="eye"
              title="No watches yet"
              body="Filter the signals (by words, severity or both) and press Watch this. A watch remembers what it matched when you last looked, so it can tell you what is new, what escalated and what went away."
            />
          ) : (
            <div className="max-w-3xl space-y-2">
              {!armed && intel.watches.some((w) => w.triggerId) && (
                <div className="os-card flex flex-wrap items-center gap-2 !py-2 text-[11.5px]">
                  <Icon name="trigger" size={13} />
                  <span className="min-w-0 flex-1 text-[var(--muted)]">
                    Harness triggers are disarmed, so scheduled refreshes will not run. Arm them in Harness when you want watches to refresh on their own.
                  </span>
                  <button className="os-btn !px-2 !py-0.5 text-[10.5px]" onClick={() => bus.emit("app:open", { appId: "harness" })}>Open Harness</button>
                </div>
              )}
              {intel.watches.some((w) => w.triggerId) && (
                <p className="text-[10.5px] leading-snug text-[var(--muted)]">
                  A scheduled refresh is a Harness trigger. Each time it fires, Intel pulls the watch&apos;s feeds (one model call per feed)
                  and Harness records one short acknowledgement run. It runs once Intel has been opened in this browser session, and
                  catches up on a missed fire the next time Intel opens.
                </p>
              )}
              {intel.watches.map((w) => {
                const diff = diffs.get(w.id);
                if (!diff) return null;
                return (
                  <WatchCard
                    key={w.id}
                    watch={w}
                    diff={diff}
                    feeds={intel.feeds}
                    now={now}
                    open={openWatch === w.id}
                    busy={busyWith(`intel-watch-${w.id}`)}
                    schedule={scheduleState(w, triggers, now)}
                    onToggle={() => setOpenWatch(openWatch === w.id ? null : w.id)}
                    onError={setError}
                  />
                );
              })}
            </div>
          )
        )}

        {tab === "dash" && (
          intel.signals.length === 0 ? (
            <Empty icon="system" title="No data to chart" body="The dashboard shows what you have actually collected. Pull a feed first." />
          ) : (
            <div className="grid max-w-3xl gap-3 sm:grid-cols-2">
              <div className="os-card">
                <div className="os-label mb-2">By severity</div>
                {SEVERITIES.map((s) => (
                  <div key={s} className="mb-1.5">
                    <div className="mb-0.5 flex justify-between text-[11px]">
                      <span style={{ color: SEV_COLOR[s] }}>{s}</span>
                      <span className="tabular-nums">{stats.bySev[s]}</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                      <div className="h-full rounded-full" style={{ width: `${(stats.bySev[s] / Math.max(1, intel.signals.length)) * 100}%`, background: SEV_COLOR[s] }} />
                    </div>
                  </div>
                ))}
              </div>

              <div className="os-card">
                <div className="os-label mb-2">Last 7 days</div>
                <div className="flex h-24 items-end gap-1">
                  {stats.buckets.map((b, i) => (
                    <div key={i} className="flex flex-1 flex-col items-center gap-1">
                      <div className="w-full rounded-t" style={{ height: `${(b / maxBucket) * 100}%`, minHeight: b ? 3 : 1, background: b ? "var(--accent)" : "var(--border)" }} title={`${b} signals`} />
                      <span className="text-[9px] text-[var(--muted)]">{6 - i === 0 ? "today" : `-${6 - i}d`}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="os-card sm:col-span-2">
                <div className="os-label mb-2">Top tags</div>
                {stats.topTags.length === 0 ? (
                  <div className="text-[11.5px] text-[var(--muted)]">No tags yet.</div>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {stats.topTags.map(([t, n]) => (
                      <button key={t} onClick={() => { setQ(t); setTab("feed"); }} className="os-chip">
                        {t} <span className="opacity-60">{n}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )
        )}

        {tab === "feeds" && (
          <div className="max-w-2xl">
            <div className="mb-3 flex flex-wrap gap-1.5">
              <input value={feedName} onChange={(e) => setFeedName(e.target.value)} placeholder="Feed name" aria-label="Feed name" className="os-input !w-40 !py-1 text-[12px]" />
              <input value={feedUrl} onChange={(e) => setFeedUrl(e.target.value)} placeholder="https://…" aria-label="Feed URL" className="os-input min-w-40 flex-1 !py-1 text-[12px]" />
              <button
                className="os-btn !py-1 text-[11px]"
                disabled={!feedName.trim() || !feedUrl.trim()}
                onClick={() => { intel.addFeed(feedName.trim(), feedUrl.trim()); setFeedName(""); setFeedUrl(""); }}
              >
                + Add feed
              </button>
            </div>
            {intel.feeds.length > 1 && (
              <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-[var(--muted)]">
                <span className="min-w-0 flex-1">Pulling again updates signals already collected instead of duplicating them.</span>
                {busyWith("intel-pullall") ? (
                  <Spinner label="Pulling all…" />
                ) : (
                  <button className="os-btn !px-2 !py-0.5 text-[10.5px]" onClick={() => void pullAll()}>
                    <Icon name="refresh" size={11} /> Pull all
                  </button>
                )}
              </div>
            )}
            {intel.feeds.length === 0 ? (
              <Empty icon="link" title="No feeds" body="Add a news page, a status page, an advisory list — anything the OS proxy can reach. Pulling it extracts structured signals." />
            ) : (
              <div className="space-y-1.5">
                {intel.feeds.map((f) => (
                  <div key={f.id} className="os-card flex flex-wrap items-center gap-2 !py-2">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-medium">{f.name}</span>
                      <span className="block truncate text-[10.5px] text-[var(--muted)]">{f.url}</span>
                    </span>
                    {f.lastPulled && <span className="text-[10px] text-[var(--muted)]">pulled {relTime(f.lastPulled)}</span>}
                    {busyWith(`intel-feed-${f.id}`) ? <Spinner /> : <button className="os-btn !px-2 !py-0.5 text-[10.5px]" onClick={() => void pull(f)}>Pull</button>}
                    <button aria-label={`Remove feed ${f.name}`} className="os-btn !px-2 !py-0.5 text-[10.5px]" onClick={() => intel.removeFeed(f.id)}><Icon name="close" size={11} /></button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === "brief" && (
          brief ? (
            <div className="mx-auto max-w-3xl">
              <div className="mb-2 flex flex-wrap justify-end gap-1.5">
                <button
                  className="os-btn !py-1 text-[11px]"
                  disabled={briefBusy}
                  onClick={() => bus.emit("aios-chat:ask", {
                    prompt: "Here is my latest intelligence brief. Challenge it: what is it over-weighting, what is it missing, and what would change its conclusions?",
                    context: { label: "the Intel brief", text: brief.slice(0, 20_000) },
                  })}
                >
                  <Icon name="spark" size={12} /> Ask AI
                </button>
                <CopyButton text={brief} />
                <button className="os-btn !py-1 text-[11px]" onClick={() => { vfs.write(`/intel/brief-${Date.now()}.md`, brief, { appId: "intel" }); bus.emit("notify", { title: "Brief saved to Files", kind: "success" }); }}>Save</button>
              </div>
              <Markdown text={brief} />
            </div>
          ) : (
            <Empty icon="report" title="No brief yet" body="Collect some signals, then press Brief. It summarises only what you have collected." />
          )
        )}
      </div>
    </div>
  );
}

/* ── one watch ───────────────────────────────────────────────────────────── */

function WatchCard({ watch: w, diff, feeds, now, open, busy, schedule, onToggle, onError }: {
  watch: Watch;
  diff: WatchDiff<Signal>;
  feeds: Feed[];
  now: number;
  open: boolean;
  busy: boolean;
  schedule: ReturnType<typeof scheduleState>;
  onToggle: () => void;
  onError: (msg: string | null) => void;
}) {
  const scope = [
    w.query.trim() ? `"${w.query.trim()}"` : "any words",
    w.minSeverity === "low" ? "any severity" : w.minSeverity === "critical" ? "critical" : `${w.minSeverity}+`,
    w.feedIds.length ? feeds.filter((f) => w.feedIds.includes(f.id)).map((f) => f.name).join(", ") : "all feeds",
  ].join(" · ");

  const refresh = async () => {
    onError(null);
    const msg = await refreshWatch(w.id, "manual");
    if (msg) onError(msg);
  };

  const setSchedule = (match: string) => {
    onError(null);
    if (!match) { unscheduleWatch(w); return; }
    const problem = scheduleWatch(w, match);
    if (problem) onError(problem);
  };

  const toggleFeed = (id: string) => {
    const next = w.feedIds.includes(id) ? w.feedIds.filter((x) => x !== id) : [...w.feedIds, id];
    useIntel.getState().patchWatch(w.id, { feedIds: next });
    // The trigger's objective names the feeds; keep it truthful.
    if (schedule.kind === "scheduled") scheduleWatch({ ...w, feedIds: next }, schedule.match);
  };

  const remove = () => {
    unscheduleWatch(w);
    useIntel.getState().removeWatch(w.id);
  };

  const scheduleValue = schedule.kind === "scheduled" ? schedule.match : "";
  const knownSchedule = WATCH_SCHEDULES.some((s) => s.match === scheduleValue);

  return (
    <div className="os-card !p-2.5">
      <div className="flex flex-wrap items-start gap-2">
        <Icon name="eye" size={14} className="mt-0.5 shrink-0 opacity-70" />
        <div className="min-w-0 flex-1">
          <div className="break-words text-[12.5px] font-medium leading-snug">{w.name}</div>
          <div className="break-words text-[10.5px] text-[var(--muted)]">{scope}</div>
        </div>
        <span className="os-chip !px-1.5 !py-0 !text-[9.5px] tabular-nums" title="Signals matching this watch right now">{diff.matches.length} matching</span>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[10.5px]">
        <span className="text-[var(--muted)]">Since {agoText(w.seenAt, now)}:</span>
        {diff.changed === 0 ? (
          <span className="text-[var(--muted)]">no changes</span>
        ) : (
          <>
            {diff.fresh.length > 0 && <span className="os-chip !px-1.5 !py-0 !text-[9.5px]" style={{ color: "var(--accent)" }}>{diff.fresh.length} new</span>}
            {diff.escalated.length > 0 && <span className="os-chip !px-1.5 !py-0 !text-[9.5px]" style={{ color: "var(--warn)" }}>{diff.escalated.length} escalated</span>}
            {diff.deescalated.length > 0 && <span className="os-chip !px-1.5 !py-0 !text-[9.5px]">{diff.deescalated.length} de-escalated</span>}
            {diff.gone.length > 0 && <span className="os-chip !px-1.5 !py-0 !text-[9.5px]">{diff.gone.length} gone</span>}
          </>
        )}
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10.5px]">
        <Icon name="clock" size={11} className="opacity-70" />
        <select
          className="os-input !w-auto !py-0.5 text-[10.5px]"
          aria-label={`Refresh schedule for ${w.name}`}
          value={scheduleValue}
          onChange={(e) => setSchedule(e.target.value)}
        >
          <option value="">Not scheduled</option>
          {WATCH_SCHEDULES.map((s) => <option key={s.match} value={s.match}>{s.label}</option>)}
          {!knownSchedule && scheduleValue && <option value={scheduleValue}>{scheduleValue}</option>}
        </select>
        {schedule.kind === "scheduled" && (
          <span className="min-w-0 text-[var(--muted)]">
            {!schedule.enabled
              ? "paused in Harness"
              : schedule.nextAt === null
                ? "schedule text no longer parses"
                : schedule.nextAt <= now ? "due on the next trigger check" : `next ${untilText(schedule.nextAt, now)}`}
            {` · fired ${schedule.firedCount}x`}
            {schedule.lastFiredAt !== undefined && `, last ${agoText(schedule.lastFiredAt, now)}`}
          </span>
        )}
        {schedule.kind === "scheduled" && !schedule.enabled && (
          <button className="os-btn !px-1.5 !py-0 !text-[10px]" onClick={() => useTriggers.getState().setEnabled(schedule.triggerId, true)}>Resume</button>
        )}
        {schedule.kind === "missing" && (
          <>
            <span className="text-[var(--muted)]">its trigger was removed in Harness</span>
            <button className="os-btn !px-1.5 !py-0 !text-[10px]" onClick={() => useIntel.getState().patchWatch(w.id, { triggerId: undefined })}>Forget</button>
          </>
        )}
      </div>

      {(w.last || w.lastError) && (
        <div className="mt-1 text-[10.5px] text-[var(--muted)]">
          {w.last && (
            <span>
              Refreshed {agoText(w.last.at, now)}: {w.last.pulled} feed{w.last.pulled === 1 ? "" : "s"} pulled
              {w.last.failed ? `, ${w.last.failed} failed` : ""}, {w.last.added} new row{w.last.added === 1 ? "" : "s"}, {w.last.updated} updated.
            </span>
          )}
          {w.lastError && <span className="block break-words text-[var(--danger)]">{w.lastError}</span>}
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {busy ? (
          <Spinner label="Refreshing…" />
        ) : (
          <button className="os-btn !px-2 !py-0.5 text-[10.5px]" onClick={() => void refresh()} disabled={feeds.length === 0} title={feeds.length ? "Pull this watch's feeds now" : "Add a feed first"}>
            <Icon name="refresh" size={11} /> Refresh
          </button>
        )}
        <button className="os-btn !px-2 !py-0.5 text-[10.5px]" onClick={onToggle} aria-expanded={open}>
          {open ? "Hide changes" : "Show changes"}
        </button>
        <button
          className="os-btn !px-2 !py-0.5 text-[10.5px]"
          disabled={diff.changed === 0}
          onClick={() => useIntel.getState().patchWatch(w.id, markSeen(w, useIntel.getState().signals, feedNameMap(feeds), Date.now()))}
          title="Remember what matches now; later changes are measured from here"
        >
          <Icon name="check" size={11} /> Mark seen
        </button>
        <button className="os-btn !px-2 !py-0.5 text-[10.5px]" onClick={() => saveReport(w, diff, feeds, Date.now())} title="Save the change report as Markdown in Files">
          <Icon name="file" size={11} /> Report
        </button>
        <button className="os-btn !px-2 !py-0.5 text-[10.5px]" onClick={() => askAboutWatch(w, diff, feeds, Date.now())}>
          <Icon name="spark" size={11} /> Ask AI
        </button>
        <button aria-label={`Delete watch ${w.name}`} className="os-btn !px-2 !py-0.5 text-[10.5px]" onClick={remove} title="Delete this watch and its schedule">
          <Icon name="trash" size={11} />
        </button>
      </div>

      {open && (
        <div className="mt-2 space-y-2 border-t border-[var(--border)] pt-2">
          {feeds.length > 1 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[10px] text-[var(--muted)]">Feeds:</span>
              {feeds.map((f) => (
                <button
                  key={f.id}
                  onClick={() => toggleFeed(f.id)}
                  aria-pressed={w.feedIds.includes(f.id)}
                  className={cn("os-chip !px-1.5 !py-0 !text-[9.5px]", w.feedIds.includes(f.id) && "!border-[var(--accent)] !bg-[var(--accent)]/16")}
                >
                  {f.name}
                </button>
              ))}
              <span className="text-[10px] text-[var(--muted)]">{w.feedIds.length ? "" : "(none picked: all feeds)"}</span>
            </div>
          )}
          {diff.changed === 0 && <div className="text-[11px] text-[var(--muted)]">Nothing has changed since you last marked this watch seen.</div>}
          <ChangeList title="New" rows={diff.fresh.map((s) => ({ key: s.id, sev: s.severity, title: s.title, note: s.source }))} />
          <ChangeList title="Escalated" rows={diff.escalated.map((c) => ({ key: c.signal.id, sev: c.signal.severity, title: c.signal.title, note: `was ${c.from}` }))} />
          <ChangeList title="De-escalated" rows={diff.deescalated.map((c) => ({ key: c.signal.id, sev: c.signal.severity, title: c.signal.title, note: `was ${c.from}` }))} />
          <ChangeList title="No longer matching" rows={diff.gone.map((g) => ({ key: g.fp, sev: g.severity, title: g.title, note: "" }))} />
        </div>
      )}
    </div>
  );
}

function ChangeList({ title, rows }: { title: string; rows: Array<{ key: string; sev: Signal["severity"]; title: string; note: string }> }) {
  if (!rows.length) return null;
  return (
    <div>
      <div className="os-label mb-1">{title} ({rows.length})</div>
      <div className="space-y-0.5">
        {rows.slice(0, 50).map((r) => (
          <div key={r.key} className="flex items-start gap-1.5 text-[11px]">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: SEV_COLOR[r.sev] }} />
            <span className="min-w-0 flex-1 break-words">{r.title}</span>
            {r.note && <span className="shrink-0 text-[10px] text-[var(--muted)]">{r.note}</span>}
          </div>
        ))}
        {rows.length > 50 && <div className="text-[10px] text-[var(--muted)]">and {rows.length - 50} more (the report lists them all)</div>}
      </div>
    </div>
  );
}
