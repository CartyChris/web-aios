"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { bus } from "@/kernel/bus";
import { NEWS_SOURCES, parseFeed, relativeAge, safeUrl, FeedParseError, type FeedItem } from "@/lib/feeds";
import { useNow } from "@/lib/useNow";
import { Icon } from "@/shell/icons";

/* Headlines from a free feed. Every feed goes through the relay: almost none
   send CORS headers, and the relay is SSRF-guarded. */

type Load = { items: FeedItem[]; at: number } | { error: string; kind: "transport" | "parse" } | null;

const clampRefresh = (n: unknown) => Math.min(720, Math.max(10, typeof n === "number" && Number.isFinite(n) ? n : 30));

export function NewsWidget({ config, onConfig }: { config?: Record<string, unknown>; onConfig?: (next: Record<string, unknown>) => void }) {
  const sourceId = typeof config?.sourceId === "string" ? config.sourceId : undefined;
  const custom = typeof config?.url === "string" ? safeUrl(config.url) : undefined;
  const source = NEWS_SOURCES.find((s) => s.id === sourceId) ?? NEWS_SOURCES[0];
  const url = custom ?? source?.url ?? "";
  const refreshMin = clampRefresh(config?.refreshMin);
  const limit = Math.min(20, Math.max(3, typeof config?.limit === "number" ? config.limit : 8));

  const [load, setLoad] = useState<Load>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftUrl, setDraftUrl] = useState(custom ?? "");
  const now = useNow(60_000);
  const abort = useRef<AbortController | null>(null);

  const fetchNow = useCallback(async () => {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      const res = await fetch(`/api/proxy?mode=raw&url=${encodeURIComponent(url)}`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`The feed answered HTTP ${res.status}.`);
      const body = await res.text();
      try {
        setLoad({ items: parseFeed(body, custom ? undefined : source?.name).slice(0, limit), at: Date.now() });
      } catch (e) {
        // Reached, but not a feed — usually a moved URL serving an HTML page.
        setLoad({ error: e instanceof FeedParseError ? e.message : "The reply is not a feed.", kind: "parse" });
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setLoad({ error: e instanceof Error ? e.message : "The feed could not be reached.", kind: "transport" });
    } finally {
      if (!ctrl.signal.aborted) setBusy(false);
    }
  }, [url, limit, custom, source?.name]);

  useEffect(() => {
    if (!url) return;
    void fetchNow();
    const t = setInterval(() => { void fetchNow(); }, refreshMin * 60_000);
    return () => { clearInterval(t); abort.current?.abort(); };
  }, [url, refreshMin, fetchNow]);

  const save = (patch: Record<string, unknown>) => { onConfig?.({ ...config, ...patch }); setEditing(false); };

  if (editing) {
    return (
      <div className="flex h-full flex-col gap-1.5 overflow-y-auto text-[11px]">
        <span className="os-label !mb-0">Source</span>
        <select className="os-input !py-1 text-[11px]" value={custom ? "" : source?.id} onChange={(e) => save({ sourceId: e.target.value, url: undefined })}>
          {NEWS_SOURCES.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.category}</option>)}
        </select>
        <span className="os-label !mb-0 mt-1">Or any RSS / Atom / JSON Feed URL</span>
        <div className="flex gap-1">
          <input className="os-input min-w-0 flex-1 !py-1 text-[11px]" placeholder="https://…" value={draftUrl} onChange={(e) => setDraftUrl(e.target.value)} />
          <button className="os-btn !py-1 text-[11px]" disabled={!safeUrl(draftUrl)} onClick={() => save({ url: safeUrl(draftUrl) })}>Use</button>
        </div>
        <label className="mt-1 flex items-center justify-between gap-2">
          <span className="text-[var(--muted)]">Refresh every (min)</span>
          <input type="number" min={10} max={720} className="os-input !w-20 !py-1 text-[11px]" defaultValue={refreshMin}
            onBlur={(e) => save({ refreshMin: clampRefresh(Number(e.target.value)) })} />
        </label>
        <button className="os-btn mt-auto !py-1 text-[11px]" onClick={() => setEditing(false)}>Done</button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col text-[11px]">
      <div className="mb-1 flex items-center gap-1.5">
        <Icon name="report" size={12} style={{ color: "var(--accent)" }} />
        <span className="min-w-0 flex-1 truncate font-medium">{custom ? new URL(custom).hostname : source?.name}</span>
        <button className="opacity-60 hover:opacity-100" title="Refresh" aria-label="Refresh" onClick={() => { setBusy(true); void fetchNow(); }}>
          <Icon name="refresh" size={11} className={busy ? "animate-spin" : undefined} />
        </button>
        <button className="opacity-60 hover:opacity-100" title="Choose a feed" aria-label="Choose a feed" onClick={() => setEditing(true)}>
          <Icon name="tune" size={11} />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        {load === null && <p className="text-[var(--muted)]">Loading headlines…</p>}
        {load && "error" in load && (
          <p className="text-[var(--muted)]">
            {load.kind === "transport" ? "Could not reach the feed" : "Reached it, but it is not a feed"} — {load.error}
          </p>
        )}
        {load && "items" in load && load.items.length === 0 && <p className="text-[var(--muted)]">The feed is empty right now.</p>}
        {load && "items" in load && load.items.map((it) => (
          <a key={it.id} href={it.url} target="_blank" rel="noopener noreferrer"
            onClick={() => bus.emit("activity", { source: "search", text: it.title })}
            className="block rounded px-1 py-0.5 hover:bg-[var(--accent)]/12">
            <span className="line-clamp-2 leading-snug">{it.title}</span>
            <span className="text-[9.5px] text-[var(--muted)]">{[it.source, relativeAge(it.publishedAt, now)].filter(Boolean).join(" · ")}</span>
          </a>
        ))}
      </div>
    </div>
  );
}
