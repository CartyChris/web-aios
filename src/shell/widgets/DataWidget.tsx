"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { bus } from "@/kernel/bus";
import { SERVICES, type ServiceDef } from "@/lib/services";
import { fetchServiceText } from "@/lib/service-fetch";
import { normaliseDataConfig, compactRows, presetArgs, DATA_PRESETS, type CompactRow, type DataWidgetConfig } from "@/lib/datawidget";
import { useNow } from "@/lib/useNow";
import { Icon } from "@/shell/icons";

/* Any of the catalogue's free services, pinned to the desktop. The three ways
   it can come up empty are shown as three different things, exactly as in the
   Open Data app: unreachable, unreadable, and genuinely nothing. */

type Load =
  | { rows: CompactRow[]; at: number; empty: boolean }
  | { error: string; kind: "transport" | "parse" }
  | null;

function withTodaysArgs(c: DataWidgetConfig): DataWidgetConfig {
  // A dated preset (On This Day) must recompute its date, or it shows the day
  // it was pinned on forever.
  const fresh = c.presetId ? presetArgs(c.presetId, Date.now()) : null;
  return fresh ? { ...c, args: { ...c.args, ...fresh } } : c;
}

export function DataWidget({ config, onConfig }: { config?: Record<string, unknown>; onConfig?: (next: Record<string, unknown>) => void }) {
  const norm = normaliseDataConfig(config ?? {}, SERVICES);
  const [editing, setEditing] = useState(!norm.ok);
  if (editing || !norm.ok) {
    return <DataSettings initial={config} reason={norm.ok ? undefined : norm.reason} onSave={(c) => { onConfig?.(c); setEditing(false); }} onCancel={norm.ok ? () => setEditing(false) : undefined} />;
  }
  return <DataView config={norm.config} onEdit={() => setEditing(true)} />;
}

function DataView({ config, onEdit }: { config: DataWidgetConfig; onEdit: () => void }) {
  const def = SERVICES.find((s) => s.id === config.serviceId) as ServiceDef;
  const [load, setLoad] = useState<Load>(null);
  const now = useNow(30_000);
  const abort = useRef<AbortController | null>(null);

  const fetchNow = useCallback(async () => {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    const c = withTodaysArgs(config);
    let body: string;
    try {
      ({ body } = await fetchServiceText(def, c.args, ctrl.signal));
    } catch (e) {
      if ((e as Error).name !== "AbortError") setLoad({ error: e instanceof Error ? e.message : "Unreachable.", kind: "transport" });
      return;
    }
    try {
      const r = def.parse(body);
      setLoad({ rows: compactRows(r, c.rows), at: Date.now(), empty: r.empty });
    } catch (e) {
      setLoad({ error: e instanceof Error ? e.message : "Unreadable reply.", kind: "parse" });
    }
  }, [config, def]);

  useEffect(() => {
    void fetchNow();
    const t = setInterval(() => { void fetchNow(); }, config.refreshMin * 60_000);
    return () => { clearInterval(t); abort.current?.abort(); };
  }, [fetchNow, config.refreshMin]);

  const age = load && "at" in load ? Math.max(0, Math.round((now - load.at) / 60_000)) : null;
  return (
    <div className="flex h-full flex-col text-[11px]">
      <div className="mb-1 flex items-center gap-1.5">
        <Icon name="signals" size={12} style={{ color: "var(--accent)" }} />
        <span className="min-w-0 flex-1 truncate font-medium">{def.name}</span>
        {age !== null && <span className="text-[9.5px] text-[var(--muted)]">{age === 0 ? "now" : `${age}m`}</span>}
        <button className="opacity-60 hover:opacity-100" title="Refresh" aria-label="Refresh" onClick={() => void fetchNow()}><Icon name="refresh" size={11} /></button>
        <button className="opacity-60 hover:opacity-100" title="Configure" aria-label="Configure" onClick={onEdit}><Icon name="tune" size={11} /></button>
      </div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
        {load === null && <p className="text-[var(--muted)]">Loading…</p>}
        {load && "error" in load && <p className="text-[var(--muted)]">{load.kind === "transport" ? "Could not reach it" : "Replied in a shape this reader does not know"} — {load.error}</p>}
        {load && "rows" in load && load.empty && <p className="text-[var(--muted)]">Answered normally; nothing matched.</p>}
        {load && "rows" in load && load.rows.map((r, i) => {
          const inner = (
            <>
              <span className="flex justify-between gap-2"><span className="truncate">{r.title}</span>{r.meta && <span className="shrink-0 tabular-nums text-[var(--accent)]">{r.meta}</span>}</span>
              {r.detail && <span className="block truncate text-[9.5px] text-[var(--muted)]">{r.detail}</span>}
            </>
          );
          return r.url
            ? <a key={i} href={r.url} target="_blank" rel="noopener noreferrer" className="block rounded px-1 hover:bg-[var(--accent)]/12">{inner}</a>
            : <div key={i} className="px-1">{inner}</div>;
        })}
      </div>
      <p className="mt-1 truncate text-[9px] text-[var(--muted)]">{def.provider} · {def.licence}</p>
    </div>
  );
}

function DataSettings({ initial, reason, onSave, onCancel }: {
  initial?: Record<string, unknown>; reason?: string; onSave: (c: Record<string, unknown>) => void; onCancel?: () => void;
}) {
  const [serviceId, setServiceId] = useState(typeof initial?.serviceId === "string" ? initial.serviceId : SERVICES[0]?.id ?? "");
  const [args, setArgs] = useState<Record<string, string>>(() => (initial?.args && typeof initial.args === "object" ? (initial.args as Record<string, string>) : {}));
  const [refreshMin, setRefreshMin] = useState(typeof initial?.refreshMin === "number" ? initial.refreshMin : 30);
  const def = SERVICES.find((s) => s.id === serviceId);
  const draft = normaliseDataConfig({ serviceId, args, refreshMin, rows: 4 }, SERVICES);

  const commit = (c: Record<string, unknown>) => {
    const d = SERVICES.find((s) => s.id === c.serviceId);
    bus.emit("activity", { source: "service", text: `${d?.name ?? ""} ${Object.values((c.args as Record<string, string>) ?? {}).join(" ")}`.trim() });
    onSave(c);
  };

  return (
    <div className="flex h-full flex-col gap-1 overflow-y-auto text-[11px]">
      {reason && <p className="text-[var(--muted)]">{reason}</p>}
      <span className="os-label !mb-0">Presets</span>
      <div className="flex flex-wrap gap-1">
        {DATA_PRESETS.map((p) => (
          <button key={p.id} className="os-chip !py-0 !text-[10px]"
            onClick={() => commit({ serviceId: p.serviceId, args: p.dated ? { ...p.args, ...(presetArgs(p.id, Date.now()) ?? {}) } : p.args, refreshMin, rows: 4, ...(p.dated ? { presetId: p.id } : {}) })}>
            {p.name}
          </button>
        ))}
      </div>
      <span className="os-label !mb-0 mt-1">Or any service</span>
      <select className="os-input !py-1 text-[11px]" value={serviceId} onChange={(e) => { setServiceId(e.target.value); setArgs({}); }}>
        {SERVICES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      {def?.params.map((p) => (
        <input key={p.name} className="os-input !py-1 text-[11px]" placeholder={`${p.label}${p.required ? " *" : ""} — ${p.placeholder}`}
          value={args[p.name] ?? ""} onChange={(e) => setArgs((a) => ({ ...a, [p.name]: e.target.value }))} />
      ))}
      <label className="flex items-center justify-between gap-2">
        <span className="text-[var(--muted)]">Refresh (min)</span>
        <input type="number" min={5} max={1440} className="os-input !w-20 !py-1 text-[11px]" value={refreshMin} onChange={(e) => setRefreshMin(Number(e.target.value))} />
      </label>
      {!draft.ok && <p className="text-[var(--muted)]">{draft.reason}</p>}
      <div className="mt-auto flex gap-1">
        <button className="os-btn flex-1 !py-1 text-[11px]" data-variant="primary" disabled={!draft.ok} onClick={() => draft.ok && commit({ ...draft.config })}>Show</button>
        {onCancel && <button className="os-btn !py-1 text-[11px]" onClick={onCancel}>Cancel</button>}
      </div>
    </div>
  );
}
