"use client";

import { useMemo, useState } from "react";
import { useSettings } from "@/kernel/settings";
import type { AppProps } from "@/kernel/types";
import { relTime, download } from "@/lib/format";
import { useNow } from "@/lib/useNow";
import { Tabs, Empty, CopyButton } from "./_ui";
import { useSpans } from "@/kernel/spans";
import { cn } from "@/lib/cn";
import { Icon } from "@/shell/icons";
import { filterSpans, costPerTask, type SpanFilter } from "@/lib/span-query";

/* ────────────────────────────────────────────────────────────────────────────
   Observatory — ported from aurora-os.html.

   Span trees over model calls, plus local heuristics that flag a bad run
   WITHOUT a second model call. That constraint is the point: paying a model to
   judge whether your model call went badly doubles the cost of every bad run,
   exactly when you least want to. Repetition, empty steps, runaway length and
   cost spikes are all detectable with string comparisons.
   ──────────────────────────────────────────────────────────────────────────── */

export interface Span {
  id: string;
  parentId: string | null;
  name: string;
  kind: "model" | "tool" | "app" | "system";
  startedAt: number;
  endedAt?: number;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  text?: string;
  error?: string;
}

/** Heuristics applied to a run. Each returns a flag or nothing. */
function analyse(spans: Span[]): Array<{ severity: "warn" | "error"; label: string; detail: string }> {
  const flags: Array<{ severity: "warn" | "error"; label: string; detail: string }> = [];
  const model = spans.filter((s) => s.kind === "model");

  // Circular reasoning: near-identical outputs in consecutive model spans.
  for (let i = 1; i < model.length; i++) {
    const a = (model[i - 1].text ?? "").slice(0, 400);
    const b = (model[i].text ?? "").slice(0, 400);
    if (a.length > 80 && similarity(a, b) > 0.9) {
      flags.push({ severity: "warn", label: "Repetition", detail: `"${model[i].name}" produced output ~identical to the step before it. The loop may not be making progress.` });
      break;
    }
  }

  const empty = model.filter((s) => (s.text ?? "").trim().length < 20 && !s.error);
  if (empty.length) flags.push({ severity: "warn", label: "Empty steps", detail: `${empty.length} model call(s) returned almost nothing.` });

  const errors = spans.filter((s) => s.error);
  if (errors.length) flags.push({ severity: "error", label: "Errors", detail: `${errors.length} span(s) failed: ${errors.slice(0, 3).map((e) => e.error).join("; ")}` });

  const costs = model.map((s) => s.costUsd ?? 0);
  if (costs.length > 2) {
    const mean = costs.reduce((a, b) => a + b, 0) / costs.length;
    const spike = model.find((s) => (s.costUsd ?? 0) > mean * 4 && (s.costUsd ?? 0) > 0.01);
    if (spike) flags.push({ severity: "warn", label: "Cost spike", detail: `"${spike.name}" cost ~$${spike.costUsd!.toFixed(4)}, over 4× the run average.` });
  }

  const slow = spans.find((s) => s.endedAt && s.endedAt - s.startedAt > 60_000);
  if (slow) flags.push({ severity: "warn", label: "Long span", detail: `"${slow.name}" took ${Math.round((slow.endedAt! - slow.startedAt) / 1000)}s.` });

  return flags;
}

/** Cheap token-set similarity — no embedding call, no dependency. */
function similarity(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const tb = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  const shared = [...ta].filter((t) => tb.has(t)).length;
  return shared / Math.max(ta.size, tb.size);
}

export default function Observatory({}: AppProps) {
  const settings = useSettings();
  // The ring lives in the kernel now: a trace you lose by closing the window
  // is exactly the trace you wanted afterwards.
  const spanStore = useSpans();
  const spans = spanStore.spans as unknown as Span[];
  const [tab, setTab] = useState("spans");
  const [sel, setSel] = useState<string | null>(null);
  const [filter, setFilter] = useState<SpanFilter>({ query: "", kind: "all", status: "all" });
  // An unfinished span is measured to "now", which must not be read mid-render.
  const now = useNow(1_000);

  // No subscription here. The shell subscribes once at boot, so a run that
  // happens while this window is shut is still recorded — which is the point
  // of moving the ring out of the component.

  const flags = useMemo(() => analyse(spans), [spans]);
  const totals = useMemo(() => ({
    calls: spans.filter((s) => s.kind === "model").length,
    cost: spans.reduce((a, s) => a + (s.costUsd ?? 0), 0),
    tokensIn: spans.reduce((a, s) => a + (s.tokensIn ?? 0), 0),
    tokensOut: spans.reduce((a, s) => a + (s.tokensOut ?? 0), 0),
    ms: spans.reduce((a, s) => a + ((s.endedAt ?? now) - s.startedAt), 0),
  }), [spans, now]);

  const roots = spans.filter((s) => !s.parentId);
  const filtering = Boolean(filter.query.trim()) || filter.kind !== "all" || filter.status !== "all";
  const matched = useMemo(() => (filtering ? filterSpans(spans, filter) : []), [spans, filter, filtering]);
  const kinds = useMemo(() => Array.from(new Set(spans.map((s) => s.kind))).sort(), [spans]);
  const tasks = useMemo(() => costPerTask(spans), [spans]);
  const selected = spans.find((s) => s.id === sel) ?? null;

  return (
    <div className="flex h-full flex-col">
      <Tabs
        tabs={[{ id: "spans", label: `Spans (${spans.length})`, icon: "gate" }, { id: "flags", label: `Flags (${flags.length})`, icon: "warning" }, { id: "cost", label: "Cost", icon: "claim" }]}
        active={tab}
        onChange={setTab}
      />

      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border)] px-2.5 py-1.5 text-[11px]">
        <span className="os-chip">{totals.calls} model calls</span>
        <span className="os-chip">~${totals.cost.toFixed(4)}</span>
        <span className="os-chip">{(totals.tokensIn + totals.tokensOut).toLocaleString()} tokens</span>
        <div className="flex-1" />
        <button className="os-btn !py-1 text-[11px]" onClick={() => spanStore.clear()}>Clear</button>
        <button className="os-btn !py-1 text-[11px]" onClick={() => download(`trace-${Date.now()}.json`, JSON.stringify({ spans, flags }, null, 2), "application/json")}>Export trace</button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === "spans" && (
          spans.length === 0 ? (
            <Empty
              icon="observatory"
              title="No spans recorded"
              body="Apps that emit tracing publish a `span` event on the OS bus and it appears here. Nothing is sent anywhere — the analysis below runs locally, with no extra model calls."
            />
          ) : (
            <div className="flex flex-wrap gap-3">
              <div className="min-w-0 flex-1">
                <div className="mb-2 flex flex-wrap items-center gap-1.5">
                  <input
                    value={filter.query}
                    onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))}
                    placeholder="Search name, text, input, error, run id"
                    aria-label="Search spans"
                    className="os-input min-w-0 flex-1 !py-1 text-[11.5px]"
                    style={{ fontSize: 16 }}
                  />
                  <select className="os-input !w-auto !py-1 text-[11px]" value={filter.kind} onChange={(e) => setFilter((f) => ({ ...f, kind: e.target.value }))} aria-label="Span kind">
                    <option value="all">all kinds</option>
                    {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
                  </select>
                  <select className="os-input !w-auto !py-1 text-[11px]" value={filter.status} onChange={(e) => setFilter((f) => ({ ...f, status: e.target.value as SpanFilter["status"] }))} aria-label="Span status">
                    <option value="all">any status</option>
                    <option value="ok">finished</option>
                    <option value="open">still open</option>
                    <option value="error">errored</option>
                  </select>
                  {filtering && (
                    <button className="os-btn !py-1 text-[11px]" onClick={() => setFilter({ query: "", kind: "all", status: "all" })}>Clear filter</button>
                  )}
                </div>
                {filtering ? (
                  <>
                    <div className="mb-1 text-[10.5px] text-[var(--muted)]">{matched.length} of {spans.length} spans match</div>
                    {matched.map((s) => <SpanNode key={s.id} span={s} all={[]} depth={0} sel={sel} onSelect={setSel} />)}
                  </>
                ) : (
                  roots.map((r) => <SpanNode key={r.id} span={r} all={spans} depth={0} sel={sel} onSelect={setSel} />)
                )}
              </div>
              {selected && (
                <div className="w-72 max-w-full shrink-0">
                  <div className="os-card">
                    <div className="mb-1.5 flex items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{selected.name}</span>
                      <button className="text-[10px] opacity-60" onClick={() => setSel(null)} aria-label="Close span detail"><Icon name="close" size={11} /></button>
                    </div>
                    <div className="space-y-0.5 text-[11px] text-[var(--muted)]">
                      <div>kind: {selected.kind}</div>
                      <div>started: {relTime(selected.startedAt)}</div>
                      {selected.endedAt && <div>duration: {((selected.endedAt - selected.startedAt) / 1000).toFixed(2)}s</div>}
                      {selected.costUsd !== undefined && <div>cost: ~${selected.costUsd.toFixed(5)}</div>}
                      {selected.tokensIn !== undefined && <div>tokens: {selected.tokensIn} in / {selected.tokensOut ?? 0} out</div>}
                    </div>
                    {selected.error && <div className="mt-2 text-[11px] text-[var(--danger)]">{selected.error}</div>}
                    {selected.text && (
                      <>
                        <div className="mt-2 flex justify-end"><CopyButton text={selected.text} /></div>
                        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words text-[10.5px]">{selected.text.slice(0, 4000)}</pre>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          )
        )}

        {tab === "flags" && (
          flags.length === 0 ? (
            <Empty icon="check" title="Nothing flagged" body="The local heuristics found no repetition, empty steps, errors, cost spikes or unusually long spans in this trace." />
          ) : (
            <div className="space-y-2">
              {flags.map((f, i) => (
                <div key={i} className="os-card" style={{ borderColor: f.severity === "error" ? "var(--danger)" : "var(--warn)" }}>
                  <div className="mb-1 flex items-center gap-2">
                    <Icon name={f.severity === "error" ? "close" : "warning"} size={13} style={{ color: f.severity === "error" ? "var(--danger)" : "var(--warn)" }} />
                    <span className="font-medium text-[12.5px]">{f.label}</span>
                  </div>
                  <div className="text-[12px] text-[var(--muted)]">{f.detail}</div>
                </div>
              ))}
            </div>
          )
        )}

        {tab === "cost" && (
          <div className="max-w-xl">
            <div className="os-card mb-3">
              <div className="os-label mb-2">This trace</div>
              {([
                ["Model calls", String(totals.calls)],
                ["Input tokens", totals.tokensIn.toLocaleString()],
                ["Output tokens", totals.tokensOut.toLocaleString()],
                ["Estimated cost", `$${totals.cost.toFixed(4)}`],
                ["Wall time", `${(totals.ms / 1000).toFixed(1)}s`],
                ["Cost per call", totals.calls ? `$${(totals.cost / totals.calls).toFixed(5)}` : "—"],
              ] as [string, string][]).map(([k, v]) => (
                <div key={k} className="flex justify-between text-[12px]"><span className="text-[var(--muted)]">{k}</span><span className="tabular-nums">{v}</span></div>
              ))}
            </div>
            <div className="os-card mb-3">
              <div className="os-label mb-2">Cost per completed task</div>
              {([
                ["Tasks (runs, or root spans without a run)", String(tasks.tasks.length)],
                ["Completed", String(tasks.completed)],
                ["Failed", String(tasks.failed)],
                ["Still running", String(tasks.running)],
                ["Spent on finished tasks", `$${tasks.spentUsd.toFixed(4)}`],
                ["Cost per completed task", tasks.costPerCompletedUsd === null ? "no completed task yet" : `$${tasks.costPerCompletedUsd.toFixed(5)}`],
                ["Success rate", tasks.successRate === null ? "—" : `${Math.round(tasks.successRate * 100)}%`],
              ] as [string, string][]).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-2 text-[12px]"><span className="text-[var(--muted)]">{k}</span><span className="tabular-nums">{v}</span></div>
              ))}
              <div className="mt-2 text-[10.5px] text-[var(--muted)]">
                Failed tasks&apos; spend is charged to the completed ones: a cheaper run that fails more often is not cheaper.
                A task failed if any span errored or every model call in it returned nothing.
              </div>
              {tasks.tasks.length > 0 && (
                <div className="mt-2 max-h-48 overflow-y-auto">
                  {tasks.tasks.slice().sort((a, b) => b.costUsd - a.costUsd).slice(0, 30).map((t) => (
                    <div key={t.key} className="flex items-center gap-2 text-[11px]">
                      <span className="shrink-0" style={{ color: t.status === "failed" ? "var(--danger)" : t.status === "running" ? "var(--muted)" : "var(--ok)" }}>
                        <Icon name={t.status === "failed" ? "close" : t.status === "running" ? "circle" : "check"} size={10} />
                      </span>
                      <span className="min-w-0 flex-1 truncate">{t.label}</span>
                      <span className="shrink-0 text-[10px] text-[var(--muted)]">{t.spans} spans</span>
                      <span className="shrink-0 tabular-nums">${t.costUsd.toFixed(4)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="os-card">
              <div className="os-label mb-2">Session total</div>
              <div className="flex justify-between text-[12px]">
                <span className="text-[var(--muted)]">Spent across all apps</span>
                <span className="tabular-nums">${settings.ai.spentUsd.toFixed(4)} / ${settings.ai.budgetUsd.toFixed(2)}</span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full" style={{ width: `${Math.min(100, (settings.ai.spentUsd / Math.max(0.0001, settings.ai.budgetUsd)) * 100)}%`, background: "var(--accent)" }} />
              </div>
              <div className="mt-2 text-[10.5px] text-[var(--muted)]">
                All figures are estimates from token counts and a published price table, not billed amounts.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SpanNode({ span, all, depth, sel, onSelect }: { span: Span; all: Span[]; depth: number; sel: string | null; onSelect: (id: string) => void }) {
  const children = all.filter((s) => s.parentId === span.id);
  const dur = span.endedAt ? span.endedAt - span.startedAt : 0;
  return (
    <>
      <button
        onClick={() => onSelect(span.id)}
        className={cn("mb-0.5 flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11.5px]", sel === span.id ? "bg-[var(--accent)]/16" : "hover:bg-white/6")}
        style={{ paddingLeft: 8 + depth * 16 }}
      >
        <span className="shrink-0" style={{ color: span.error ? "var(--danger)" : span.kind === "model" ? "var(--accent)" : "var(--muted)" }}>
          <Icon name={span.kind === "model" ? "diamond" : span.kind === "tool" ? "caret" : "circle"} size={9} />
        </span>
        <span className="min-w-0 flex-1 truncate">{span.name}</span>
        {dur > 0 && <span className="shrink-0 text-[10px] text-[var(--muted)]">{(dur / 1000).toFixed(2)}s</span>}
        {span.costUsd !== undefined && span.costUsd > 0 && <span className="shrink-0 text-[10px] text-[var(--muted)]">${span.costUsd.toFixed(4)}</span>}
      </button>
      {children.map((c) => <SpanNode key={c.id} span={c} all={all} depth={depth + 1} sel={sel} onSelect={onSelect} />)}
    </>
  );
}
