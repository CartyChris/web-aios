"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppProps } from "@/kernel/types";
import { useHarness, type RunSummary } from "@/kernel/harness";
import { useVFS } from "@/kernel/vfs";
import { bus } from "@/kernel/bus";
import { startRun, installHarness } from "@/lib/harness-runtime";
import { createRegistry, builtinTools } from "@/lib/harness/tools";
import { FIXTURES } from "@/lib/harness/fixtures";
import { DEFAULT_LOOP_CONFIG, DOD_EXPLORATORY } from "@/lib/harness/config";
import { SEED_TASKS } from "@/lib/harness/tasks";
import type { DefinitionOfDone, RunResult, ToolDef } from "@/lib/harness/types";
import { Tabs, Empty, ErrorNote, Spinner, Markdown, CopyButton } from "./_ui";
import { useTriggers } from "@/kernel/triggers";
import { runGoldenSet, allTasks, invalidTasks, baselineFrom, compare, currentFingerprint, installEvals, DEFAULT_EVAL_CONCURRENCY } from "@/lib/harness-evals";
import { suiteToMarkdown } from "@/lib/harness/evals";
import { minePatterns, proposeTask } from "@/lib/harness/patterns";
import type { EvalBaseline, EvalSuiteResult } from "@/lib/harness/types";
import { download } from "@/lib/format";
import { fireNow } from "@/lib/harness-triggers";
import { newTrigger, validateTrigger, MIN_INTERVAL_MS } from "@/lib/harness/triggers";
import type { TriggerKind, TriggerSpec } from "@/lib/harness/types";
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
  const triggers = useTriggers();
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

  useEffect(() => { installHarness(); installEvals(); }, []);

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
          { id: "patterns", label: "Patterns", icon: "signals" },
          { id: "triggers", label: `Triggers (${triggers.triggers.length})`, icon: "trigger" },
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

        {tab === "golden" && <GoldenPanel />}
        {tab === "patterns" && <PatternsPanel runs={store.runs} />}
        {tab === "triggers" && <TriggersPanel dods={store.dods} />}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   The golden set, with a button.

   The suite runner, the seed tasks and the baseline diff have all existed and
   been tested for a while; nothing called any of them. A suite nobody runs is
   the same as no suite, except that it looks like coverage.

   The panel leads with the rejected tasks rather than the results, because a
   task refused at registration — no anti-case, a definition of done that
   cannot fail — is a task silently covering nothing, and that is invisible in
   a pass count.
   ──────────────────────────────────────────────────────────────────────────── */

const BASELINE_PATH = "/harness/evals/baseline.json";

function GoldenPanel() {
  const vfs = useVFS();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const [result, setResult] = useState<EvalSuiteResult | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const tasks = allTasks();
  const invalid = invalidTasks();

  const baseline: EvalBaseline | null = (() => {
    const node = vfs.read(BASELINE_PATH);
    if (!node?.content) return null;
    try { return JSON.parse(node.content) as EvalBaseline; } catch { return null; }
  })();

  const deltas = result ? compare(result, baseline) : [];

  const launch = async () => {
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBusy(true); setNote(null); setResult(null); setProgress(null);
    try {
      const r = await runGoldenSet({
        baseline,
        signal: ctrl.signal,
        concurrency: DEFAULT_EVAL_CONCURRENCY,
        onProgress: (done, total, taskId) => setProgress({ done, total, label: taskId }),
      });
      setResult(r);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "The suite failed to start.");
    } finally {
      setBusy(false);
      abort.current = null;
      setProgress(null);
    }
  };

  const pin = () => {
    if (!result) return;
    const b = baselineFrom(result);
    if (!b.ok) { setNote(b.reason); return; }
    vfs.write(BASELINE_PATH, JSON.stringify(b.baseline, null, 2), { appId: "harness" });
    setNote("Baseline pinned. The next suite is compared against this one.");
  };

  return (
    <div className="max-w-3xl">
      <p className="mb-2.5 text-[12px] leading-relaxed text-[var(--muted)]">
        A fixed set of tasks to re-run after every change. Every task carries an anti-case — an objective its
        definition of done must NOT pass — because a check that passes on both is decoration, not a test. A suite is
        green only when every task passes AND every anti-case fails.
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {busy ? (
          <button className="os-btn" onClick={() => abort.current?.abort()}>
            <Icon name="stop" size={13} /> Stop
          </button>
        ) : (
          <button className="os-btn" data-variant="primary" onClick={() => void launch()} disabled={tasks.length === 0}>
            <Icon name="play" size={13} /> Run {tasks.length} tasks
          </button>
        )}
        <span className="text-[11px] text-[var(--muted)]">
          {tasks.length * 2} runs minimum — each task plus its anti-case, one at a time.
        </span>
        <div className="flex-1" />
        <span className="os-chip !px-1.5 !py-0 !text-[9px]" title="Prompt shape, tool catalogue, fixtures and model. A baseline taken against a different surface is not comparable.">
          surface {currentFingerprint().slice(0, 10)}
        </span>
        {baseline && (
          <span className="os-chip !px-1.5 !py-0 !text-[9px]">
            baseline {new Date(baseline.at).toISOString().slice(0, 10)}
          </span>
        )}
      </div>

      {note && <p className="mb-2.5 text-[11px] leading-relaxed text-[var(--muted)]">{note}</p>}

      {busy && (
        <div className="mb-3">
          <Spinner label={progress ? `${progress.done}/${progress.total} runs — ${progress.label}` : "Starting…"} />
        </div>
      )}

      {invalid.length > 0 && (
        <div className="os-card mb-3 !p-2.5" style={{ borderColor: "var(--warn)" }}>
          <div className="mb-1 flex items-center gap-1.5">
            <Icon name="warning" size={13} style={{ color: "var(--warn)" }} />
            <span className="text-[12px] font-medium">{invalid.length} task(s) would be refused before running</span>
          </div>
          <p className="mb-1.5 text-[10.5px] leading-snug text-[var(--muted)]">
            A refused task covers nothing, and a pass count cannot show you that.
          </p>
          {invalid.map((t) => (
            <div key={t.id} className="text-[10.5px] text-[var(--muted)]">
              · <span className="text-[var(--fg)]">{t.title}</span> — {t.reasons.join(" ")}
            </div>
          ))}
        </div>
      )}

      {result && (
        <div className="os-card mb-3 !p-2.5" style={{ borderColor: result.green ? "var(--ok)" : "var(--warn)" }}>
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            <Icon name={result.green ? "check" : "warning"} size={13} style={{ color: result.green ? "var(--ok)" : "var(--warn)" }} />
            <span className="text-[12.5px] font-medium">{result.green ? "Green" : "Not green"}</span>
            <span className="os-chip !px-1.5 !py-0 !text-[9px]">{result.passed} passed</span>
            <span className="os-chip !px-1.5 !py-0 !text-[9px]">{result.failed} failed</span>
            {result.nonDiscriminating > 0 && (
              <span className="os-chip !px-1.5 !py-0 !text-[9px]" style={{ color: "var(--warn)" }}>
                {result.nonDiscriminating} non-discriminating
              </span>
            )}
            <span className="os-chip !px-1.5 !py-0 !text-[9px]">${result.totals.costUsd.toFixed(4)}</span>
            <div className="flex-1" />
            <button className="os-btn !px-1.5 !py-0 !text-[10px]" onClick={pin}>Pin as baseline</button>
            <button
              className="os-btn !px-1.5 !py-0 !text-[10px]"
              onClick={() => download(`golden-${result.startedAt}.md`, suiteToMarkdown(result), "text/markdown")}
            >
              Export
            </button>
          </div>

          {result.stale && (
            <p className="mb-1.5 text-[11px] leading-snug text-[var(--muted)]">
              The surface changed since the baseline was taken, so the comparison below is between two different
              measurements. Re-pin before reading a regression into it.
            </p>
          )}
          {result.nonDiscriminating > 0 && (
            <p className="mb-1.5 text-[11px] leading-snug text-[var(--muted)]">
              A non-discriminating task passed its objective AND its anti-case. That is counted as not green: a check
              that accepts the wrong answer too is not measuring anything.
            </p>
          )}

          <div className="space-y-0.5">
            {result.results.map((r) => (
              <div key={r.taskId} className="flex items-start gap-1.5 text-[10.5px]">
                <Icon
                  name={r.discriminates && r.pass ? "check" : "close"}
                  size={11}
                  className="mt-0.5 shrink-0"
                  style={{ color: r.discriminates && r.pass ? "var(--ok)" : "var(--danger)" }}
                />
                <span className="w-40 shrink-0 truncate font-medium">{r.taskId}</span>
                <span className="min-w-0 flex-1 text-[var(--muted)]">
                  {r.error
                    ? r.error
                    : r.pass && !r.discriminates
                      ? "passed, but the anti-case passed too"
                      : r.verdict.reason}
                </span>
              </div>
            ))}
          </div>

          {deltas.length > 0 && (
            <div className="mt-2 border-t border-[var(--border)] pt-2">
              <div className="os-label mb-1">Against the baseline</div>
              {deltas.map((d) => (
                <div key={`${d.taskId}:${d.kind}`} className="text-[10.5px] text-[var(--muted)]">
                  · <span className="text-[var(--fg)]">{d.taskId}</span> {d.kind} — {d.detail}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="os-label mb-1">Tasks</div>
      <div className="space-y-1.5">
        {tasks.map((t) => (
          <div key={t.id} className="os-card !p-2">
            <div className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-[12px]">{t.title}</span>
              {t.origin === "production_failure" && (
                <span className="os-chip !px-1.5 !py-0 !text-[9px]" title="Added from a real failure. It never leaves the set.">
                  from a failure
                </span>
              )}
              <span className="os-chip !px-1.5 !py-0 !text-[9px]">{t.category}</span>
            </div>
            <div className="mt-0.5 text-[10.5px] text-[var(--muted)]">{t.objective}</div>
            <div className="mt-0.5 text-[10.5px] text-[var(--muted)] opacity-80">
              <span className="opacity-70">Must NOT pass: </span>{t.anti.objective}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Layer 1, made visible.

   The reason this panel leads with the attempt ledger rather than the trigger
   list: a trigger layer's characteristic failure is silence, and a trigger
   that has never fired looks identical whether its pattern is wrong, its
   events never happen, or it fired and was correctly deduplicated. Writing
   down every decision — including the refusals, with their reason — is the
   only thing that tells those apart.
   ──────────────────────────────────────────────────────────────────────────── */

const TRIGGER_KINDS: Array<{ id: TriggerKind; label: string; hint: string; placeholder: string }> = [
  { id: "event", label: "Bus event", hint: "Fires when an app publishes a matching event. Use prefix:* to widen.", placeholder: "artifact:created" },
  { id: "schedule", label: "Schedule", hint: `every:15m, every:2h or at:09:30. Minimum interval ${MIN_INTERVAL_MS / 1000}s.`, placeholder: "every:30m" },
  { id: "file", label: "File written", hint: "Fires when a file is written under this VFS path.", placeholder: "/notes" },
];

function TriggersPanel({ dods }: { dods: DefinitionOfDone[] }) {
  const t = useTriggers();
  const [kind, setKind] = useState<TriggerKind>("event");
  const [match, setMatch] = useState("");
  const [objective, setObjective] = useState("");
  const [dodId, setDodId] = useState(dods[0]?.id ?? DOD_EXPLORATORY.id);
  const [problem, setProblem] = useState<string | null>(null);

  const draft: TriggerSpec = newTrigger({
    id: "draft", createdAt: 0, kind, match, objectiveTemplate: objective, dodId, configId: "default", enabled: true,
  });
  const check = validateTrigger(draft);
  const meta = TRIGGER_KINDS.find((k) => k.id === kind);

  const add = () => {
    if (!check.ok) { setProblem(check.reasons.join(" ")); return; }
    setProblem(null);
    t.save(newTrigger({ ...draft, id: `trg_${Date.now().toString(36)}`, createdAt: Date.now(), enabled: false }));
    setMatch(""); setObjective("");
  };

  return (
    <div className="max-w-3xl">
      <div className="os-card mb-3 !p-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => t.setArmed(!t.armed)}
            className={cn("os-btn", t.armed && "!border-[var(--accent)] !bg-[var(--accent)]/16")}
          >
            <Icon name={t.armed ? "play" : "pause"} size={13} /> {t.armed ? "Armed" : "Disarmed"}
          </button>
          <p className="flex-1 text-[11px] leading-snug text-[var(--muted)]">
            Disarmed, triggers are evaluated and their decisions recorded, but no run starts and nothing is spent.
            A page that begins paying for model calls because it was left open in a background tab is not a page
            you can leave open in a background tab.
          </p>
        </div>
      </div>

      <div className="os-card mb-3 !p-2.5">
        <div className="os-label mb-1.5">New trigger</div>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {TRIGGER_KINDS.map((k) => (
            <button
              key={k.id}
              onClick={() => { setKind(k.id); setMatch(""); }}
              className={cn("os-btn !py-1 text-[11px]", kind === k.id && "!border-[var(--accent)] !bg-[var(--accent)]/16")}
            >
              {k.label}
            </button>
          ))}
        </div>
        <input
          className="os-input mb-1.5 w-full text-[12px]"
          placeholder={meta?.placeholder}
          value={match}
          onChange={(e) => setMatch(e.target.value)}
        />
        <p className="mb-2 text-[10.5px] text-[var(--muted)]">{meta?.hint}</p>
        <textarea
          className="os-input mb-1.5 w-full resize-none text-[12px]"
          rows={2}
          placeholder={kind === "schedule" ? "Summarise what changed since {{now}}" : "Read {{payload.path}} and list what it commits us to"}
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
        />
        <p className="mb-2 text-[10.5px] text-[var(--muted)]">
          {"{{payload}}, {{payload.field}}, {{now}} and {{trigger}} are substituted. An unresolved placeholder is left "}
          standing rather than blanked, so a mistyped field is visible instead of producing an objective with a hole in it.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <select className="os-input !py-1 text-[11px]" value={dodId} onChange={(e) => setDodId(e.target.value)}>
            {dods.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
          <button className="os-btn" onClick={add} disabled={!check.ok}>
            <Icon name="plus" size={13} /> Add, disabled
          </button>
          {!check.ok && <span className="text-[11px] text-[var(--muted)]">{check.reasons[0]}</span>}
        </div>
        {problem && <p className="mt-1.5 text-[11px] text-[var(--danger)]">{problem}</p>}
      </div>

      {t.triggers.length === 0 ? (
        <Empty icon="trigger" title="No triggers." body="Layer 1 is what lets a run start without someone watching it start." />
      ) : (
        <div className="mb-3 space-y-1.5">
          {t.triggers.map((spec) => (
            <div key={spec.id} className="os-card !p-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="os-chip !px-1.5 !py-0 !text-[9px]">{spec.kind}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{spec.match || "(any)"}</span>
                <span
                  className="os-chip !px-1.5 !py-0 !text-[9px]"
                  title="A trigger that has never fired is a bug you cannot otherwise see."
                >
                  fired {spec.firedCount}x
                </span>
                <button className="os-btn !px-1.5 !py-0 !text-[10px]" onClick={() => t.setEnabled(spec.id, !spec.enabled)}>
                  {spec.enabled ? "On" : "Off"}
                </button>
                <button className="os-btn !px-1.5 !py-0 !text-[10px]" onClick={() => void fireNow(spec.id, { path: spec.match })}>
                  Test
                </button>
                <button className="os-btn !px-1.5 !py-0 !text-[10px]" onClick={() => t.remove(spec.id)}>
                  <Icon name="trash" size={11} />
                </button>
              </div>
              <div className="mt-0.5 truncate text-[10.5px] text-[var(--muted)]">{spec.objectiveTemplate}</div>
            </div>
          ))}
        </div>
      )}

      <div className="os-label mb-1 flex items-center gap-2">
        Decision ledger
        {t.attempts.length > 0 && (
          <button className="os-btn !px-1.5 !py-0 !text-[10px]" onClick={() => t.clearAttempts()}>Clear</button>
        )}
      </div>
      {t.attempts.length === 0 ? (
        <p className="text-[11px] text-[var(--muted)]">
          Nothing evaluated yet. Every decision lands here, including the refusals — that is how you tell a
          trigger that never matched from one that matched and was correctly suppressed.
        </p>
      ) : (
        <div className="space-y-0.5">
          {t.attempts.slice(0, 60).map((a) => (
            <div key={a.id} className="flex items-start gap-1.5 text-[10.5px]">
              <Icon
                name={a.fired ? "check" : "ban"}
                size={11}
                className="mt-0.5 shrink-0"
                style={{ color: a.fired ? "var(--ok)" : "var(--muted)" }}
              />
              <span className="shrink-0 text-[var(--muted)]">{relTime(a.at)}</span>
              <span className="shrink-0 font-medium">{a.reason}</span>
              <span className="min-w-0 flex-1 truncate text-[var(--muted)]">{a.detail}</span>
            </div>
          ))}
        </div>
      )}
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

/* What keeps going wrong, as opposed to what went wrong once.
 *
 * A trace answers "what happened in run 41"; it cannot answer "what should I
 * fix". Only recurrent patterns appear here, and each one carries the run ids
 * it was derived from so the claim can be checked rather than believed. */
function PatternsPanel({ runs }: { runs: RunSummary[] }) {
  const patterns = useMemo(() => minePatterns(runs), [runs]);

  if (!runs.length) {
    return <Empty icon="signals" title="No runs yet" body="Patterns appear once there are enough runs for a trend to mean anything." />;
  }
  if (!patterns.length) {
    return (
      <Empty
        icon="doubleCheck"
        title="Nothing recurring"
        body={`Across ${runs.length} run${runs.length === 1 ? "" : "s"}, no problem has happened more than once. A single bad run is an anecdote, so nothing is reported.`}
      />
    );
  }

  return (
    <div className="max-w-3xl">
      <p className="mb-3 text-[12px] leading-relaxed text-[var(--muted)]">
        Mined from {runs.length} runs. Only problems that recurred are shown — one bad run is an
        anecdote, and changing the harness for an anecdote is how it fills up with special cases.
      </p>
      {patterns.map((p) => {
        const task = proposeTask(p, runs);
        return (
          <div key={p.id} className="os-card mb-2 !p-2.5">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 text-[12.5px] font-medium">{p.label}</span>
              <span className="os-chip !py-0 !text-[10px]">{p.count} of {runs.length}</span>
            </div>
            <p className="mt-1 text-[11px] leading-snug text-[var(--muted)]">{p.detail}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              <span className="text-[10px] text-[var(--muted)]">from</span>
              {p.runIds.slice(0, 6).map((id) => (
                <span key={id} className="os-chip !px-1.5 !py-0 !text-[9.5px]" title={id}>{id.slice(0, 10)}</span>
              ))}
              {p.runIds.length > 6 && <span className="text-[10px] text-[var(--muted)]">+{p.runIds.length - 6}</span>}
            </div>
            {task && (
              /* The objective, handed over for a person to turn into a task.
                 Deliberately NOT auto-added: an EvalTask requires a definition
                 of done and a mandatory negative control, and a machine-written
                 anti-control that nothing could fail would quietly turn the
                 golden set into "the guard still fires" -- which a guard that
                 fires on everything also satisfies. */
              <div className="mt-2 rounded border border-[var(--border)] p-2">
                <div className="os-label mb-1">Worth a golden-set task</div>
                <p className="mb-1.5 text-[11px]">{task.objective}</p>
                <div className="flex flex-wrap items-center gap-1.5">
                  <CopyButton text={task.objective} label="Copy objective" className="os-btn !py-1 text-[11px]" />
                  <span className="text-[10px] text-[var(--muted)]">
                    Add it under Golden set, with a definition of done and a negative control.
                  </span>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
