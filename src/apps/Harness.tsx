"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppProps } from "@/kernel/types";
import { useHarness } from "@/kernel/harness";
import { useVFS } from "@/kernel/vfs";
import { bus } from "@/kernel/bus";
import { startRun, installHarness } from "@/lib/harness-runtime";
import { createRegistry, builtinTools } from "@/lib/harness/tools";
import { FIXTURES } from "@/lib/harness/fixtures";
import { DEFAULT_LOOP_CONFIG, DOD_EXPLORATORY } from "@/lib/harness/config";
import { SEED_TASKS } from "@/lib/harness/tasks";
import type { DefinitionOfDone, RunResult, ToolDef } from "@/lib/harness/types";
import { Tabs, Empty, ErrorNote, Spinner, Markdown } from "./_ui";
import { relTime } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Icon } from "@/shell/icons";

/* ────────────────────────────────────────────────────────────────────────────
   The harness.

   An agent is not a model — it is a controlled workflow, and the model is the
   smallest, most swappable part of it. This app is the other parts made
   visible: what may start a run, how far it is allowed to go, which numbers
   are computed rather than improvised, what it was allowed to read, who
   decides it is done, and the receipt afterwards.

   The one rule the UI enforces rather than merely suggests: a run needs a
   definition of done before it can start. A run nobody can judge is a run that
   always looks like it worked.
   ──────────────────────────────────────────────────────────────────────────── */

const TOOL_LIST: ToolDef[] = (() => {
  const r = createRegistry();
  for (const t of builtinTools({ fixtures: FIXTURES })) r.register(t);
  return r.list();
})();

export default function Harness({}: AppProps) {
  const store = useHarness();
  const vfs = useVFS();
  const [tab, setTab] = useState("run");
  const [objective, setObjective] = useState("");
  const [dodId, setDodId] = useState(DOD_EXPLORATORY.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<string[]>([]);
  const [result, setResult] = useState<RunResult | null>(null);
  const [openTrace, setOpenTrace] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => { installHarness(); }, []);

  const dod: DefinitionOfDone =
    store.dods.find((d) => d.id === dodId) ?? DOD_EXPLORATORY;

  const launch = useCallback(async () => {
    if (!objective.trim() || busy) return;
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBusy(true); setError(null); setLive([]); setResult(null);
    try {
      const r = await startRun({
        objective,
        dod,
        signal: ctrl.signal,
        // Layer 4: the agent reads what a person allowed, not the whole disk.
        factPaths: vfs.list("/notes").map((n) => n.path).slice(0, 12),
        // Layer 5: destructive tools stop and ask. Approving from here names
        // the person who approved it, and that name lands in the trace.
        approve: async (tool) =>
          window.confirm(`Allow the agent to run "${tool.name}"?\n\n${tool.description}`)
            ? "you"
            : null,
        onSpan: (s) => setLive((prev) => [...prev, `${s.role ?? s.kind} · ${s.name}`].slice(-40)),
      });
      setResult(r);
      bus.emit("notify", {
        title: r.verdict?.pass ? "Run passed its definition of done" : `Run ${r.status}`,
        body: r.verdict?.reason,
        kind: r.verdict?.pass ? "success" : "warn",
      });
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError(e instanceof Error ? e.message : "The run failed to start.");
    } finally { setBusy(false); abort.current = null; }
  }, [objective, busy, dod, vfs]);

  return (
    <div className="flex h-full flex-col">
      <Tabs
        tabs={[
          { id: "run", label: "Run", icon: "loop" },
          { id: "runs", label: `Receipts (${store.runs.length})`, icon: "report" },
          { id: "tools", label: `Tools (${TOOL_LIST.length})`, icon: "tune" },
          { id: "done", label: "Definition of done", icon: "gate" },
          { id: "golden", label: `Golden set (${store.tasks.length + SEED_TASKS.length})`, icon: "doubleCheck" },
        ]}
        active={tab}
        onChange={setTab}
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <ErrorNote error={error} onDismiss={() => setError(null)} />

        {tab === "run" && (
          <div className="max-w-3xl">
            <p className="mb-3 text-[12px] leading-relaxed text-[var(--muted)]">
              A ReAct loop: thought, action, observation, repeated until it finishes or hits a limit you set.
              Every model call and every tool call is a span, so the run leaves a receipt whether it works or not.
            </p>

            <textarea
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              rows={3}
              placeholder="What should the agent achieve? e.g. What was Q1 2026 ARR for enterprise, and which policy governs exporting it?"
              className="os-input mb-2 resize-y !py-1.5 text-[12.5px]"
            />

            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <span className="os-label">Done when</span>
              <select value={dodId} onChange={(e) => setDodId(e.target.value)} className="os-input !w-auto !py-1 text-[11px]">
                {store.dods.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
              </select>
              <span className="os-chip">{dod.criteria.length} criteria · owner {dod.owner}</span>
              <div className="flex-1" />
              {busy
                ? <button className="os-btn !py-1 text-[11px]" onClick={() => abort.current?.abort()}>Stop</button>
                : <button className="os-btn !py-1 text-[11px]" data-variant="primary" onClick={launch} disabled={!objective.trim()}>
                    <Icon name="play" size={11} className="mr-1" />Run
                  </button>}
            </div>

            <div className="mb-3 flex flex-wrap gap-1.5 text-[10.5px] text-[var(--muted)]">
              <span className="os-chip">max {DEFAULT_LOOP_CONFIG.maxSteps} steps</span>
              <span className="os-chip">stop at ${DEFAULT_LOOP_CONFIG.maxCostUsd.toFixed(2)}</span>
              <span className="os-chip">approvals: {DEFAULT_LOOP_CONFIG.approvals}</span>
              <span className="os-chip">judge ≠ worker</span>
            </div>

            {busy && (
              <div className="os-card mb-3">
                <Spinner label="Running" />
                <div className="mt-2 max-h-40 space-y-0.5 overflow-y-auto font-[family-name:var(--font-mono)] text-[10.5px] text-[var(--muted)]">
                  {live.map((l, i) => <div key={i}>{l}</div>)}
                </div>
              </div>
            )}

            {result && <RunReport result={result} />}
          </div>
        )}

        {tab === "runs" && (
          store.runs.length === 0 ? (
            <Empty icon="report" title="No runs yet" body="Every run writes a receipt here and a full trace into Files under /harness/runs." />
          ) : (
            <div className="max-w-3xl space-y-1.5">
              <div className="mb-2 flex items-center gap-2">
                <span className="os-label">Receipts</span>
                <div className="flex-1" />
                <button className="os-btn !py-0.5 text-[10.5px]" onClick={() => store.clearRuns()}>Clear</button>
              </div>
              {store.runs.map((r) => (
                <div key={r.runId} className="os-card !p-2">
                  <div className="flex items-center gap-1.5">
                    <Icon
                      name={r.pass ? "check" : r.status === "finished" ? "warning" : "close"}
                      size={12}
                      style={{ color: r.pass ? "var(--ok)" : "var(--warn)" }}
                    />
                    <span className="min-w-0 flex-1 truncate text-[12px]">{r.objective}</span>
                    <span className="os-chip !px-1.5 !py-0 !text-[9px]">{r.status}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1 text-[10px] text-[var(--muted)]">
                    <span>{r.steps} steps</span><span>·</span>
                    <span>${r.costUsd.toFixed(4)}</span><span>·</span>
                    <span>{relTime(r.startedAt)}</span>
                    {r.pendingHuman.length > 0 && <span className="os-chip !px-1.5 !py-0 !text-[9px]">awaiting a person</span>}
                    {r.flags.map((f) => <span key={f} className="os-chip !px-1.5 !py-0 !text-[9px]">{f}</span>)}
                    <div className="flex-1" />
                    <button
                      className="os-btn !px-2 !py-0 !text-[10px]"
                      onClick={() => setOpenTrace(openTrace === r.runId ? null : r.runId)}
                    >
                      {openTrace === r.runId ? "Hide trace" : "Read the trace"}
                    </button>
                  </div>
                  {openTrace === r.runId && (
                    <div className="mt-2 max-h-96 overflow-y-auto border-t border-[var(--border)] pt-2">
                      <Markdown text={vfs.read(r.tracePath)?.content ?? "The trace is no longer in Files."} className="!text-[11px]" />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )
        )}

        {tab === "tools" && (
          <div className="max-w-3xl">
            <p className="mb-3 text-[12px] leading-relaxed text-[var(--muted)]">
              A number that must never vary runs as fixed logic behind the agent, so the same question returns the
              same figure every time. The model does not improvise these — it calls them, and the call is in the trace.
            </p>
            <div className="space-y-1.5">
              {TOOL_LIST.map((t) => (
                <div key={t.name} className="os-card !p-2">
                  <div className="flex items-center gap-1.5">
                    <span className="font-[family-name:var(--font-mono)] text-[12px]">{t.name}</span>
                    <span className={cn("os-chip !px-1.5 !py-0 !text-[9px]", t.deterministic && "!border-[var(--ok)]")}>
                      {t.deterministic ? "deterministic" : "varies"}
                    </span>
                    {t.annotations?.requiresApproval && <span className="os-chip !px-1.5 !py-0 !text-[9px]">needs approval</span>}
                  </div>
                  <div className="mt-0.5 text-[11px] text-[var(--muted)]">{t.description}</div>
                  <div className="mt-0.5 font-[family-name:var(--font-mono)] text-[10px] text-[var(--muted)]">{t.example}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === "done" && (
          <div className="max-w-3xl">
            <p className="mb-3 text-[12px] leading-relaxed text-[var(--muted)]">
              Writing down what good looks like is the highest-leverage act in the whole system — everything else
              compounds on top of it. A definition with no criterion that can fail is rejected, because one that
              always passes is worse than none.
            </p>
            {store.dods.map((d) => (
              <div key={d.id} className="os-card mb-2">
                <div className="flex items-center gap-1.5">
                  <span className="flex-1 text-[12.5px] font-medium">{d.label}</span>
                  <span className="os-chip !px-1.5 !py-0 !text-[9px]">owner {d.owner}</span>
                </div>
                {d.criteria.map((c) => (
                  <div key={c.id} className="mt-1.5 border-l-2 border-[var(--border)] pl-2">
                    <div className="text-[11.5px]">{c.label} {c.required && <span className="text-[var(--muted)]">· required</span>}</div>
                    <div className="text-[10.5px] text-[var(--muted)]">{c.expectation}</div>
                    <div className="text-[10px] text-[var(--muted)]">decided by {c.by} · {c.check.kind}</div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

        {tab === "golden" && (
          <div className="max-w-3xl">
            <p className="mb-3 text-[12px] leading-relaxed text-[var(--muted)]">
              A fixed set of tasks to re-run after every change. Every task carries an anti-case — a deliberately
              wrong answer its check must reject — because a check that passes on both is decoration, not a test.
            </p>
            <div className="space-y-1.5">
              {[...store.tasks, ...SEED_TASKS].map((t) => (
                <div key={t.id} className="os-card !p-2">
                  <div className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-[12px]">{t.title}</span>
                    <span className="os-chip !px-1.5 !py-0 !text-[9px]">{t.category}</span>
                  </div>
                  <div className="mt-0.5 text-[10.5px] text-[var(--muted)]">{t.objective}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** What a finished run actually produced, with its verdict spelled out. */
function RunReport({ result }: { result: RunResult }) {
  const verdict = result.verdict;
  const failed = useMemo(
    () => (verdict?.outcomes ?? []).filter((o) => o.met === false),
    [verdict],
  );
  return (
    <div className="os-card" style={{ borderColor: verdict?.pass ? "var(--ok)" : "var(--warn)" }}>
      <div className="mb-1.5 flex items-center gap-1.5">
        <Icon name={verdict?.pass ? "check" : "warning"} size={13} style={{ color: verdict?.pass ? "var(--ok)" : "var(--warn)" }} />
        <span className="text-[12.5px] font-medium">
          {verdict?.pass ? "Passed its definition of done" : `Did not pass · ${result.status}`}
        </span>
        <div className="flex-1" />
        <span className="os-chip !px-1.5 !py-0 !text-[9px]">{result.totals.steps} steps</span>
        <span className="os-chip !px-1.5 !py-0 !text-[9px]">${result.totals.costUsd.toFixed(4)}</span>
      </div>

      {result.answer
        ? <Markdown text={result.answer} className="!text-[12px]" />
        : <div className="text-[12px] text-[var(--muted)]">
            No answer. The run ended as <strong>{result.status}</strong> before producing one — reported as empty
            rather than as a guess, because a guess at the limit is success it did not achieve.
          </div>}

      {verdict?.reason && <div className="mt-2 text-[11px] text-[var(--muted)]">{verdict.reason}</div>}
      {failed.length > 0 && (
        <div className="mt-2">
          <div className="os-label mb-1">Unmet</div>
          {failed.map((o) => <div key={o.criterionId} className="text-[11px] text-[var(--muted)]">· {o.observed || o.criterionId}</div>)}
        </div>
      )}
      {(verdict?.pendingHuman.length ?? 0) > 0 && (
        <div className="mt-2 text-[11px] text-[var(--muted)]">
          Waiting on a person for: {verdict!.pendingHuman.join(", ")}. The agent advises; a named person decides.
        </div>
      )}
    </div>
  );
}
