"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSettings } from "@/kernel/settings";
import { PROVIDERS, getProvider } from "@/lib/providers";
import { cn } from "@/lib/cn";
import { Icon } from "./icons";

/* ────────────────────────────────────────────────────────────────────────────
   The model picker.

   OpenRouter alone lists 445 models. A <select> of 445 options is not a
   choice, it is a wall — so this is a search field with a filtered list under
   it, the same shape as the command palette, and you reach it by clicking the
   model you are currently using. That is where everyone looks first.

   Filtering is on the model's whole identity, not just its id: typing "vision"
   finds models that can see, "free" finds the free tier, "opus" finds Anthropic
   through OpenRouter. Each row carries the two facts that actually decide a
   choice — context window and price — because a picker that shows only names
   makes you leave to compare them.
   ──────────────────────────────────────────────────────────────────────────── */

export interface ModelEntry {
  id: string;
  name: string;
  context?: number;
  vision?: boolean;
  image?: boolean;
  tools?: boolean;
  inUsd?: number;
  outUsd?: number;
  free?: boolean;
}

const fmtContext = (n?: number) =>
  !n ? "" : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);

const fmtPrice = (n?: number) =>
  n === undefined ? "" : n === 0 ? "free" : n < 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(n < 10 ? 1 : 0)}`;

export function ModelPicker({ onClose }: { onClose: () => void }) {
  const s = useSettings();
  const [providerId, setProviderId] = useState(s.ai.provider);
  const [query, setQuery] = useState("");

  return (
    <div className="fixed inset-0 z-[9900] flex items-start justify-center p-4 pt-[8vh]" role="dialog" aria-label="Choose a model">
      <div className="absolute inset-0 bg-black/45" onClick={onClose} />
      <div
        className="glass relative flex max-h-[76vh] w-full max-w-2xl flex-col overflow-hidden shadow-2xl"
        style={{ borderRadius: "var(--radius)", animation: "os-fade-up 160ms ease-out" }}
      >
        {/* Providers */}
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--border)] px-2 py-1.5">
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              onClick={() => setProviderId(p.id)}
              className={cn(
                "shrink-0 rounded-full px-2.5 py-1 text-[11.5px] transition",
                providerId === p.id ? "bg-[var(--accent)]/20 text-[var(--text)] ring-1 ring-[var(--accent)]" : "text-[var(--muted)] hover:bg-white/6",
              )}
            >
              {p.name}
              {s.ai.keys[p.id] && <span className="ml-1 opacity-60" title="Key stored">•</span>}
            </button>
          ))}
        </div>

        {/* Keyed on the provider so switching starts a genuinely fresh list.
            That is also what keeps the fetch out of trouble: the component
            mounts with no models and only ever sets state after an await, so
            nothing is written synchronously from inside an effect. */}
        <ModelResults key={providerId} providerId={providerId} query={query} setQuery={setQuery} onClose={onClose} />
      </div>
    </div>
  );
}

function ModelResults({ providerId, query, setQuery, onClose }: {
  providerId: string;
  query: string;
  setQuery: (q: string) => void;
  onClose: () => void;
}) {
  const s = useSettings();
  /** null means "still asking" — a separate boolean would have to be set
   *  synchronously at mount, which is the cascading render React warns about. */
  const [models, setModels] = useState<ModelEntry[] | null>(null);
  const [source, setSource] = useState<"live" | "catalog">("catalog");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const provider = getProvider(providerId);

  useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();
    (async () => {
      try {
        const { keys, baseUrls } = useSettings.getState().ai;
        const key = keys[providerId] ?? "";
        const base = baseUrls[providerId];
        const res = await fetch(
          `/api/ai/models?provider=${encodeURIComponent(providerId)}${base ? `&baseUrl=${encodeURIComponent(base)}` : ""}`,
          { headers: key ? { "x-api-key": key } : {}, signal: ctrl.signal },
        );
        const data = (await res.json()) as { models?: Array<ModelEntry | string>; source?: "live" | "catalog" };
        if (!alive) return;
        // The route used to return bare strings; tolerate both so a stale
        // cached response cannot blank the list.
        setModels((data.models ?? []).map((m) => (typeof m === "string" ? { id: m, name: m } : m)));
        setSource(data.source ?? "catalog");
      } catch {
        if (!alive) return;
        setModels((getProvider(providerId)?.models ?? []).map((m) => ({ id: m, name: m })));
        setSource("catalog");
      }
    })();
    return () => { alive = false; ctrl.abort(); };
  }, [providerId]);

  const filtered = useMemo(() => {
    const all = models ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    const terms = q.split(/\s+/);
    return all.filter((m) => {
      // One haystack per model, so "free vision" narrows on both at once.
      const hay = [
        m.id, m.name,
        m.vision ? "vision sees image multimodal" : "",
        m.image ? "image generation draw" : "",
        m.tools ? "tools functions" : "",
        m.free ? "free" : "",
      ].join(" ").toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [models, query]);

  const choose = useCallback((m: ModelEntry) => {
    s.setAI("provider", providerId);
    s.setAI("model", m.id);
    onClose();
  }, [s, providerId, onClose]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { onClose(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => {
        const next = Math.max(0, Math.min(filtered.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
        listRef.current?.querySelectorAll("[data-row]")[next]?.scrollIntoView({ block: "nearest" });
        return next;
      });
    }
    if (e.key === "Enter" && filtered[active]) { e.preventDefault(); choose(filtered[active]); }
  };

  const loading = models === null;

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKey}>
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 py-2.5">
        <Icon name="search" size={15} style={{ color: "var(--muted)" }} />
        <input
          autoFocus
          value={query}
          onChange={(e) => { setQuery(e.target.value); setActive(0); }}
          placeholder={`Search ${models?.length || ""} models — name, "vision", "free"…`}
          className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-[var(--muted)]"
        />
        {loading && <span className="inline-block h-3.5 w-3.5 shrink-0 rounded-full border-2 border-[var(--accent)] border-t-transparent" style={{ animation: "os-spin 700ms linear infinite" }} />}
        <button onClick={onClose} className="shrink-0 opacity-50 hover:opacity-100" aria-label="Close"><Icon name="close" size={13} /></button>
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {!loading && filtered.length === 0 && (
          <div className="px-3 py-10 text-center text-[12.5px] text-[var(--muted)]">
            {(models?.length ?? 0) === 0
              ? `No model list for ${provider?.name}. Add a key in Settings → Providers and try again.`
              : `Nothing matches “${query}”.`}
          </div>
        )}
        {filtered.map((m, i) => {
          const current = s.ai.provider === providerId && s.ai.model === m.id;
          return (
            <button
              key={m.id}
              data-row
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(m)}
              className={cn(
                "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition",
                i === active && "bg-[var(--accent)]/14",
                current && "ring-1 ring-[var(--accent)]",
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[13px]">{m.name}</span>
                  {current && <span className="os-chip !px-1.5 !py-0 !text-[9px]">current</span>}
                </div>
                <div className="truncate font-[family-name:var(--font-mono)] text-[10px] text-[var(--muted)]">{m.id}</div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {m.vision && <span className="os-chip !px-1.5 !py-0 !text-[9px]" title="Can see images"><Icon name="eye" size={9} /></span>}
                {m.image && <span className="os-chip !px-1.5 !py-0 !text-[9px]" title="Can generate images"><Icon name="image" size={9} /></span>}
                {m.tools && <span className="os-chip !px-1.5 !py-0 !text-[9px]" title="Supports tool calling"><Icon name="tune" size={9} /></span>}
                {m.context ? <span className="os-chip !px-1.5 !py-0 !text-[9px] tabular-nums" title="Context window">{fmtContext(m.context)}</span> : null}
                {m.inUsd !== undefined && (
                  <span className="os-chip !px-1.5 !py-0 !text-[9px] tabular-nums" title="USD per million tokens, in / out">
                    {m.free ? "free" : `${fmtPrice(m.inUsd)}/${fmtPrice(m.outUsd)}`}
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-[var(--border)] px-3 py-1.5 text-[10.5px] text-[var(--muted)]">
        <span>{filtered.length} of {models?.length ?? 0}</span>
        <span className="opacity-50">·</span>
        <span>{source === "live" ? "live from the provider" : "built-in list"}</span>
        <div className="flex-1" />
        <label className="flex items-center gap-1.5" title="OpenRouter can hand any model a live web search tool">
          <input type="checkbox" checked={s.ai.webAccess} onChange={(e) => s.setAI("webAccess", e.target.checked)} />
          Web access
        </label>
        <span className="opacity-50">·</span>
        <span>↑↓ then ↩</span>
      </div>
    </div>
  );
}
