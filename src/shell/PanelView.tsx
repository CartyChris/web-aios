"use client";

import { useState } from "react";
import { bus } from "@/kernel/bus";
import { getApp } from "@/kernel/registry";
import type { Panel } from "@/lib/aios-agent";
import { chartLayout } from "@/lib/panelchart";
import { cn } from "@/lib/cn";
import { DiffTable } from "./DiffTable";

/* Renders an allowlisted panel (lib/aios-agent.ts parsePanel). Shared by AIOS
   Chat and the Desk. Everything from the model is text; nothing becomes HTML.
   A chart is drawn by this file from the layout in lib/panelchart.ts, a diff is
   computed by lib/textdiff.ts, and a timeline link opens only an app that
   exists. Choices and forms answer by asking AIOS Chat, so they work the same
   from the Desk as from the chat. */

const ask = (prompt: string) => bus.emit("aios-chat:ask", { prompt });

export function PanelView({ panel }: { panel: Panel }) {
  const [done, setDone] = useState<boolean[]>(() => (panel.type === "checklist" ? panel.items.map((i) => !!i.done) : []));
  const [values, setValues] = useState<Record<string, string>>({});
  if (panel.type === "table") {
    return (
      <div className="mt-1.5 overflow-x-auto" data-aios-panel="table">
        <table className="w-full border-collapse text-[11px]">
          <thead><tr>{panel.columns.map((c) => <th key={c} className="border-b border-white/15 px-1.5 py-1 text-left font-medium">{c}</th>)}</tr></thead>
          <tbody>{panel.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="border-b border-white/5 px-1.5 py-1">{c}</td>)}</tr>)}</tbody>
        </table>
      </div>
    );
  }
  if (panel.type === "checklist") {
    return (
      <div className="mt-1.5 space-y-0.5" data-aios-panel="checklist">
        {panel.items.map((it, i) => (
          <label key={i} className="flex items-center gap-1.5 text-[11.5px]">
            <input type="checkbox" checked={done[i] ?? false} onChange={(e) => setDone((d) => d.map((x, k) => (k === i ? e.target.checked : x)))} />
            <span className={cn(done[i] && "line-through opacity-60")}>{it.text}</span>
          </label>
        ))}
      </div>
    );
  }
  if (panel.type === "choices") {
    return (
      <div className="mt-1.5 flex flex-wrap gap-1.5" data-aios-panel="choices">
        {panel.options.map((o) => <button key={o.label} className="os-btn !py-0.5 text-[11px]" aria-label={o.label} onClick={() => ask(o.reply)}>{o.label}</button>)}
      </div>
    );
  }
  if (panel.type === "form") {
    return (
      <form className="mt-1.5 space-y-1" data-aios-panel="form" onSubmit={(e) => { e.preventDefault(); ask(`${panel.submit}: ${panel.fields.map((f) => `${f.label} = ${values[f.name] ?? ""}`).join("; ")}`); }}>
        {panel.fields.map((f) => (
          <label key={f.name} className="block text-[11px]">
            {f.label}
            <input className="os-input mt-0.5 !py-0.5 text-[11.5px]" type={f.kind} value={values[f.name] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))} />
          </label>
        ))}
        <button type="submit" className="os-btn !py-0.5 text-[11px]" aria-label={panel.submit}>{panel.submit}</button>
      </form>
    );
  }
  if (panel.type === "chart") return <ChartPanel panel={panel} />;
  if (panel.type === "timeline") {
    return (
      <ol className="mt-1.5 border-l border-white/15 pl-2 text-[11.5px]" data-aios-panel="timeline">
        {panel.items.map((it, i) => {
          const app = it.appId ? getApp(it.appId) : undefined;
          return (
            <li key={i} className="relative flex items-baseline gap-2 py-0.5" data-timeline-item={i}>
              <span className="absolute -left-[11.5px] top-[7px] h-[5px] w-[5px] rounded-full bg-[var(--accent)]" aria-hidden />
              <span className="w-20 shrink-0 text-[10.5px] text-[var(--muted)]">{it.when}</span>
              <span className="min-w-0 flex-1 break-words">{it.text}</span>
              {app && (
                <button
                  className="os-btn shrink-0 !px-1.5 !py-0 text-[10px]"
                  onClick={() => bus.emit("app:open", { appId: app.id, args: it.path ? { path: it.path } : undefined })}
                  aria-label={`Open ${it.text} in ${app.name}`}
                >
                  Open
                </button>
              )}
            </li>
          );
        })}
      </ol>
    );
  }
  return (
    <div className="mt-1.5" data-aios-panel="diff">
      {panel.title && <div className="mb-0.5 text-[10.5px] text-[var(--muted)]">{panel.title}</div>}
      <DiffTable before={panel.before} after={panel.after} leftLabel="Before" rightLabel="After" />
    </div>
  );
}

const SERIES_COLOR = ["var(--accent)", "var(--warn)", "var(--ok)"];
const W = 280, H = 150;

function ChartPanel({ panel }: { panel: Extract<Panel, { type: "chart" }> }) {
  const L = chartLayout({ kind: panel.kind, labels: panel.labels, series: panel.series }, { w: W, h: H, left: 34, bottom: 18, top: 6, right: 6 });
  const unit = panel.unit ? ` ${panel.unit}` : "";
  // A text description of the whole chart, for screen readers and for anyone
  // who wants the exact numbers.
  const summary = panel.series
    .map((s) => `${s.name || "values"}: ${panel.labels.map((l, i) => `${l} ${s.values[i] ?? "no value"}${s.values[i] === null ? "" : unit}`).join(", ")}`)
    .join(". ");
  return (
    <figure className="mt-1.5" data-aios-panel="chart" data-chart-kind={panel.kind}>
      {panel.title && <figcaption className="mb-0.5 text-[11px] font-medium">{panel.title}{unit && <span className="font-normal text-[var(--muted)]"> ({panel.unit})</span>}</figcaption>}
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[420px]" role="img" aria-label={`${panel.title || "Chart"}. ${summary}`}>
        {L.ticks.map((t) => (
          <g key={t.v}>
            <line x1={L.plot.x} x2={L.plot.x + L.plot.w} y1={t.y} y2={t.y} stroke="currentColor" strokeOpacity={t.v === 0 ? 0.45 : 0.1} strokeWidth={1} />
            <text x={L.plot.x - 4} y={t.y + 3} textAnchor="end" fontSize={9} fill="currentColor" fillOpacity={0.6}>{t.label}</text>
          </g>
        ))}
        {L.bars.map((b, i) => (
          <rect key={i} x={b.x} y={b.y} width={Math.max(0.5, b.w - 1)} height={Math.max(b.v === 0 ? 0 : 0.5, b.h)} fill={SERIES_COLOR[b.series]} rx={1.5} data-value={b.v}>
            <title>{`${b.label}: ${b.v}${unit}`}</title>
          </rect>
        ))}
        {L.lines.map((ln) => ln.runs.map((run, r) => (
          <g key={`${ln.series}-${r}`}>
            {run.length > 1 && <polyline points={run.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={SERIES_COLOR[ln.series]} strokeWidth={1.8} strokeLinejoin="round" />}
            {run.map((p, k) => <circle key={k} cx={p.x} cy={p.y} r={2.2} fill={SERIES_COLOR[ln.series]} data-value={p.v} />)}
          </g>
        )))}
        {L.xLabels.map((l, i) => (
          <text key={i} x={l.x} y={H - 5} textAnchor="middle" fontSize={9} fill="currentColor" fillOpacity={0.7}>{l.text}</text>
        ))}
      </svg>
      {panel.series.length > 1 && (
        <div className="mt-0.5 flex flex-wrap gap-2 text-[10.5px] text-[var(--muted)]">
          {panel.series.map((s, i) => (
            <span key={i} className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm" style={{ background: SERIES_COLOR[i] }} />{s.name || `Series ${i + 1}`}</span>
          ))}
        </div>
      )}
    </figure>
  );
}
