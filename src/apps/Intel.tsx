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

/* ────────────────────────────────────────────────────────────────────────────
   Signals — ported from the "add-fifteen-new-features" intel dashboard.

   The original was a Postgres-backed Next.js app with seeded demo data. A
   desktop app cannot assume a database, so the model is inverted: you add feeds
   and signals yourself (or pull them through the OS proxy), and the dashboard
   is a live view over what you actually collected. No seeded fiction — a chart
   of invented numbers is worse than an empty one, because it looks like data.
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
}

export interface Feed { id: string; name: string; url: string; lastPulled?: number }

interface IntelState {
  signals: Signal[];
  feeds: Feed[];
  addSignal: (s: Omit<Signal, "id" | "ts">) => void;
  addMany: (s: Array<Omit<Signal, "id" | "ts">>) => void;
  patch: (id: string, p: Partial<Signal>) => void;
  remove: (id: string) => void;
  addFeed: (name: string, url: string) => void;
  removeFeed: (id: string) => void;
  touchFeed: (id: string) => void;
  clear: () => void;
}

const useIntel = create<IntelState>()(
  persist(
    (set) => ({
      signals: [], feeds: [],
      addSignal: (s) => set((st) => ({ signals: [{ ...s, id: uid("sig"), ts: Date.now() }, ...st.signals] })),
      addMany: (list) => set((st) => ({ signals: [...list.map((s) => ({ ...s, id: uid("sig"), ts: Date.now() })), ...st.signals].slice(0, 500) })),
      patch: (id, p) => set((st) => ({ signals: st.signals.map((s) => (s.id === id ? { ...s, ...p } : s)) })),
      remove: (id) => set((st) => ({ signals: st.signals.filter((s) => s.id !== id) })),
      addFeed: (name, url) => set((st) => ({ feeds: [...st.feeds, { id: uid("feed"), name, url }] })),
      removeFeed: (id) => set((st) => ({ feeds: st.feeds.filter((f) => f.id !== id) })),
      touchFeed: (id) => set((st) => ({ feeds: st.feeds.map((f) => (f.id === id ? { ...f, lastPulled: Date.now() } : f)) })),
      clear: () => set({ signals: [] }),
    }),
    { name: "webaios.intel.v1", storage: createJSONStorage(() => localStorage) },
  ),
);

const SEVERITIES: Signal["severity"][] = ["low", "medium", "high", "critical"];
const SEV_COLOR: Record<Signal["severity"], string> = {
  low: "var(--muted)", medium: "var(--accent)", high: "var(--warn)", critical: "var(--danger)",
};

export default function Intel({}: AppProps) {
  const intel = useIntel();
  const vfs = useVFS();
  const [tab, setTab] = useState("feed");
  const [q, setQ] = useState("");
  const [sev, setSev] = useState("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [brief, setBrief] = useState("");
  const [feedName, setFeedName] = useState("");
  // Buckets are relative to the clock, so it comes from state rather than a
  // Date.now() read during render.
  const now = useNow(60_000);
  const [feedUrl, setFeedUrl] = useState("");

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

  const pull = useCallback(async (feed: Feed) => {
    setBusy(feed.id); setError(null);
    try {
      const res = await fetch(`/api/proxy?url=${encodeURIComponent(feed.url)}&mode=text`);
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? `${res.status}`);
      const extracted = await ask({
        messages: [{ role: "user", content: `Source: ${feed.name} (${data.url})\n\n${(data.text ?? "").slice(0, 40_000)}` }],
        system: `Extract distinct newsworthy items from this page.

Return ONLY a JSON array: [{"title": "...", "body": "<one or two sentences>", "severity": "low"|"medium"|"high"|"critical", "tags": ["..."]}]

At most 15 items. Severity reflects how consequential the item is, not how dramatic its headline is. If the page has no real items — a nav page, a paywall, an error — return an empty array rather than inventing entries.`,
        maxTokens: 2200,
      });
      const s = extracted.text.indexOf("[");
      const e = extracted.text.lastIndexOf("]");
      const parsed = JSON.parse(s !== -1 && e > s ? extracted.text.slice(s, e + 1) : extracted.text);
      if (!Array.isArray(parsed)) throw new Error("Unexpected response shape.");
      if (!parsed.length) { setError(`${feed.name}: no items found on that page.`); }
      intel.addMany(parsed.filter((x) => x?.title).map((x) => ({
        title: String(x.title),
        body: String(x.body ?? ""),
        source: feed.name,
        url: data.url,
        severity: SEVERITIES.includes(x.severity) ? x.severity : "low",
        tags: Array.isArray(x.tags) ? x.tags.map(String) : [],
      })));
      intel.touchFeed(feed.id);
      bus.emit("notify", { title: `${parsed.length} signals from ${feed.name}`, kind: "success" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Pull failed.");
    } finally { setBusy(null); }
  }, [intel]);

  const writeBrief = useCallback(async () => {
    if (!intel.signals.length) return;
    setBusy("brief"); setError(null); setBrief("");
    try {
      const res = await ask({
        messages: [{ role: "user", content: intel.signals.slice(0, 80).map((s) => `[${s.severity}] ${s.title} — ${s.body} (${s.source})`).join("\n") }],
        system: "Write a short intelligence brief over these signals: what matters most, what the patterns are, and what is probably noise. Cite sources by name. End with 'What is missing' — the questions these signals do not answer.",
        maxTokens: 1600,
        onDelta: (_d, f) => setBrief(f),
      });
      setBrief(res.text);
      setTab("brief");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Brief failed.");
    } finally { setBusy(null); }
  }, [intel.signals]);

  const maxBucket = Math.max(1, ...stats.buckets);

  return (
    <div className="flex h-full flex-col">
      <Tabs
        tabs={[
          { id: "feed", label: `Signals (${intel.signals.length})`, icon: "intel" },
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
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter signals…" className="os-input min-w-28 flex-1 !py-1 text-[12px]" />
          {["all", ...SEVERITIES].map((s) => (
            <button key={s} onClick={() => setSev(s)} className={cn("os-btn !px-2 !py-0.5 text-[10.5px]", sev === s && "!border-[var(--accent)] !bg-[var(--accent)]/16")}>{s}</button>
          ))}
          {busy === "brief" ? <Spinner label="Writing…" /> : <button className="os-btn !py-1 text-[11px]" onClick={writeBrief} disabled={!intel.signals.length}>Brief</button>}
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
                      <div className="text-[12.5px] font-medium leading-snug">{s.title}</div>
                      {s.body && <div className="mt-0.5 text-[11.5px] leading-relaxed text-[var(--muted)]">{s.body}</div>}
                      <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-[var(--muted)]">
                        <span>{s.source}</span>
                        <span>· {relTime(s.ts)}</span>
                        {s.tags.map((t) => <span key={t} className="os-chip !px-1.5 !py-0 !text-[9px]">{t}</span>)}
                        {s.url && <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] underline">source ↗</a>}
                      </div>
                    </div>
                    <button className="shrink-0 text-[10px] opacity-60 hover:opacity-100" onClick={() => intel.remove(s.id)}><Icon name="close" size={11} /></button>
                  </div>
                </div>
              ))}
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
              <input value={feedName} onChange={(e) => setFeedName(e.target.value)} placeholder="Feed name" className="os-input !w-40 !py-1 text-[12px]" />
              <input value={feedUrl} onChange={(e) => setFeedUrl(e.target.value)} placeholder="https://…" className="os-input min-w-40 flex-1 !py-1 text-[12px]" />
              <button
                className="os-btn !py-1 text-[11px]"
                disabled={!feedName.trim() || !feedUrl.trim()}
                onClick={() => { intel.addFeed(feedName.trim(), feedUrl.trim()); setFeedName(""); setFeedUrl(""); }}
              >
                + Add feed
              </button>
            </div>
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
                    {busy === f.id ? <Spinner /> : <button className="os-btn !px-2 !py-0.5 text-[10.5px]" onClick={() => pull(f)}>Pull</button>}
                    <button className="os-btn !px-2 !py-0.5 text-[10.5px]" onClick={() => intel.removeFeed(f.id)}><Icon name="close" size={11} /></button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === "brief" && (
          brief ? (
            <div className="mx-auto max-w-3xl">
              <div className="mb-2 flex justify-end gap-1.5">
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
