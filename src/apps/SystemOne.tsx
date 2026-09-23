"use client";

import { useRef, useState } from "react";
import type { AppProps } from "@/kernel/types";
import { useSettings } from "@/kernel/settings";
import { useJobs } from "@/kernel/jobs";
import { bus } from "@/kernel/bus";
import { cn } from "@/lib/cn";
import { Icon } from "@/shell/icons";
import { Tabs, Field, Slider, ErrorNote, Markdown, Spinner, Empty } from "./_ui";
import { runSystemOne } from "@/lib/s1/run";
import { DEFAULT_THRESHOLDS } from "@/lib/s1/parse";
import { createOrderDesk, scriptedOrderDecider, ORDER_DESK_GOAL } from "@/lib/s1/orderdesk";
import { routerQuestions, planRoute, HARNESSES, SHAPES, type HarnessId, type HarnessOutput, type OutputShape, type RoutePlan, type SavePlan } from "@/lib/s1/router";
import type { Answer, Decider, Handoff, Question, Risk, RunReport, TraceStep } from "@/lib/s1/types";
import { jevDecider, emulatedDecider, createOsEnv, runHarnesses, combineAndSave, downloadPlanZip } from "@/lib/s1-os";

/* System One: a harness whose decider answers typed questions with
   probabilities and refuses to act when unsure. Design after HarnessRouter's
   SystemOneHarness (Apache-2.0). Second tab: the Harness Router, which asks
   the same kind of decider which of this OS's harnesses fit a task, runs them,
   and merges their outputs into one product. */

type DeciderKind = "jev" | "emulated" | "scripted";
type EnvId = "orderdesk" | "os";
type Pending = { handoff: Handoff; settle: (v: "approve" | "deny") => void };

const RISKS: Risk[] = ["read", "write", "destructive", "finish"];
const GOALS: Record<EnvId, string> = { orderdesk: ORDER_DESK_GOAL, os: "Open Notes, then switch the OS to a dark theme." };

export default function SystemOne({ win }: AppProps) {
  const [tab, setTab] = useState("harness");
  const [decider, setDecider] = useState<DeciderKind>("emulated");
  const [thresholds, setThresholds] = useState<Record<Risk, number>>({ ...DEFAULT_THRESHOLDS });
  const key = useSettings((s) => s.ai.keys.typesafe ?? "");
  const model = useSettings((s) => s.ai.model);

  const makeDecider = (signal: AbortSignal, allowScripted: boolean): Decider | string => {
    const d = effectiveDecider(decider, allowScripted);
    if (d === "jev") return key.trim() ? jevDecider(key.trim()) : "Add a TypeSafe API key to use Jev, or pick the emulated decider.";
    if (d === "scripted") return allowScripted ? scriptedOrderDecider() : "The scripted decider only knows the order desk. Pick Jev or emulated.";
    return emulatedDecider(signal);
  };

  const shared = { decider, setDecider, thresholds, setThresholds, keyValue: key, model, makeDecider, windowId: win.id };
  return (
    <div className="flex h-full flex-col">
      <Tabs tabs={[{ id: "harness", label: "System One harness", icon: "gate" }, { id: "router", label: "Harness Router", icon: "network" }]} active={tab} onChange={setTab} />
      <div className="min-h-0 flex-1">{tab === "harness" ? <HarnessTab {...shared} /> : <RouterTab {...shared} />}</div>
    </div>
  );
}

interface Shared {
  decider: DeciderKind;
  setDecider: (d: DeciderKind) => void;
  thresholds: Record<Risk, number>;
  setThresholds: (t: Record<Risk, number>) => void;
  keyValue: string;
  model: string;
  makeDecider: (signal: AbortSignal, allowScripted: boolean) => Decider | string;
  windowId: string;
}

/* ── decider settings (shared sidebar) ──────────────────────────────────── */

/** The tabs share one decider choice, but the router cannot use the scripted
 *  one (it only knows the order desk). Without this, choosing Scripted on the
 *  harness tab left the router's select showing "Emulated" (its first option)
 *  while Route refused to run: the control said one thing and did another. */
function effectiveDecider(d: DeciderKind, allowScripted: boolean): DeciderKind {
  return d === "scripted" && !allowScripted ? "emulated" : d;
}

function DeciderSettings({ decider: chosen, setDecider, thresholds, setThresholds, keyValue, model, allowScripted }: Shared & { allowScripted: boolean }) {
  const decider = effectiveDecider(chosen, allowScripted);
  const setKey = (v: string) => {
    const s = useSettings.getState();
    s.setAI("keys", { ...s.ai.keys, typesafe: v });
  };
  return (
    <div className="space-y-3">
      <Field label="Decider" hint={decider === "emulated" ? `The chat model in the top bar (${model || "none"}) answers the typed questions. Its probabilities are self-reported, not calibrated: labelled emulated everywhere.` : decider === "jev" ? "Jev over TypeSafe's API, relayed through this app's server." : "Fixed policy numbers, no model. Offline demo of the order desk only."}>
        <select className="os-input w-full" value={decider} onChange={(e) => setDecider(e.target.value as DeciderKind)} aria-label="Decider">
          <option value="emulated">Emulated (chat model)</option>
          <option value="jev">Jev direct (TypeSafe)</option>
          {allowScripted && <option value="scripted">Scripted (offline demo)</option>}
        </select>
      </Field>
      {decider === "jev" && (
        <Field label="TypeSafe API key" hint="Saved in this browser with your other provider keys.">
          <input className="os-input w-full" type="password" autoComplete="off" placeholder="sk-..." value={keyValue} onChange={(e) => setKey(e.target.value)} aria-label="TypeSafe API key" />
        </Field>
      )}
      <div>
        <div className="os-label mb-1">Gate thresholds by risk</div>
        {RISKS.map((r) => (
          <Slider key={r} label={r} value={thresholds[r]} min={0} max={1} step={0.05} format={(v) => v.toFixed(2)} onChange={(v) => setThresholds({ ...thresholds, [r]: v })} />
        ))}
        <div className="text-[11px] text-[var(--muted)]">Defaults are the SystemOneHarness README values. Its blog quotes write 0.70 and destructive 0.90.</div>
      </div>
    </div>
  );
}

/* ── probability bars ───────────────────────────────────────────────────── */

function Bar({ label, p, strong, title }: { label: string; p: number; strong?: boolean; title?: string }) {
  return (
    <div className="flex items-center gap-2 text-[11px]" title={title}>
      <span className={cn("w-32 shrink-0 truncate", strong ? "font-semibold text-[var(--text)]" : "text-[var(--muted)]")}>{label}</span>
      <span className="relative h-2 flex-1 overflow-hidden rounded bg-[var(--border)]">
        <span className="absolute inset-y-0 left-0 rounded bg-[var(--accent)]" style={{ width: `${Math.round(p * 100)}%`, opacity: strong ? 1 : 0.55 }} />
      </span>
      <span className="w-10 shrink-0 text-right tabular-nums">{p.toFixed(2)}</span>
    </div>
  );
}

function QuestionView({ name, q, a, discarded }: { name: string; q: Question; a: Answer | undefined; discarded?: string[] }) {
  let rows: Array<{ label: string; p: number; strong: boolean; title?: string }> = [];
  if (q.type === "noul") rows = [{ label: "yes", p: a?.type === "noul" ? a.p : 0, strong: true }];
  else if (q.type === "choice") {
    const probs = a?.type === "choice" ? a.probabilities : {};
    rows = Object.keys(q.criteria)
      .map((k) => ({ label: k, p: probs[k] ?? 0, strong: a?.type === "choice" && a.choice === k, title: q.criteria[k] }))
      .sort((x, y) => y.p - x.p)
      .slice(0, 6);
  } else {
    const probs = a?.type === "score" ? a.probabilities : [];
    rows = q.criteria.map((c, i) => ({ label: `${i}: ${c}`, p: probs[i] ?? 0, strong: a?.type === "score" && a.level === i }));
  }
  return (
    <div className="rounded border border-[var(--border)] p-1.5">
      <div className="mb-1 flex items-center gap-2 text-[11px]">
        <span className="font-mono">{name}</span>
        <span className="text-[var(--muted)]">{q.type}</span>
        {!a && <span className="text-[var(--danger,#f87171)]">no answer</span>}
      </div>
      <div className="space-y-0.5">{rows.map((r) => <Bar key={r.label} {...r} />)}</div>
      {discarded && discarded.length > 0 && <div className="mt-1 text-[11px] text-[var(--danger,#f87171)]">Discarded (not offered): {discarded.join(", ")}</div>}
    </div>
  );
}

const VERDICT_STYLE: Record<string, string> = { pass: "bg-emerald-500/20 text-emerald-300", approved: "bg-sky-500/20 text-sky-300", refused: "bg-amber-500/20 text-amber-300", denied: "bg-red-500/20 text-red-300" };

function StepView({ s }: { s: TraceStep }) {
  return (
    <div className="rounded-lg border border-[var(--border)] p-2">
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[12px]">
        <span className="font-semibold">Step {s.n}</span>
        <span className="font-mono">{s.decision.action ?? "(no action)"}{Object.keys(s.decision.params).length ? ` ${JSON.stringify(s.decision.params)}` : ""}</span>
        <span className={cn("rounded px-1.5 py-0.5 text-[11px]", VERDICT_STYLE[s.verdict])}>{s.verdict}</span>
        <span className="text-[11px] text-[var(--muted)]">weakest {s.gate.weakest.question} {s.gate.weakest.p.toFixed(2)} vs {s.gate.threshold.toFixed(2)}</span>
        <span className="ml-auto text-[11px] tabular-nums text-[var(--muted)]">{s.decider}{s.decider === "emulated" ? " (not calibrated)" : ""} · {Math.round(s.latencyMs)} ms · ${s.cumulativeCostUsd.toFixed(6)}{s.costEstimated ? " est." : ""}</span>
      </div>
      <div className="grid gap-1.5 md:grid-cols-2">
        {Object.entries(s.questions).map(([name, q]) => <QuestionView key={name} name={name} q={q} a={s.answers[name]} discarded={s.discarded[name]} />)}
      </div>
      {s.problems.length > 0 && <div className="mt-1 text-[11px] text-amber-300">{s.problems.join("; ")}</div>}
      <div className="mt-1 text-[11px] text-[var(--muted)]">Gate: {s.gate.reason}{s.env ? ` · Environment: ${s.env.text}` : ""}</div>
    </div>
  );
}

function EscalationCard({ pending }: { pending: Pending }) {
  const h = pending.handoff;
  return (
    <div className="rounded-lg border border-amber-400/60 bg-amber-400/10 p-2 text-[12px]">
      <div className="mb-1 flex items-center gap-2 font-semibold"><Icon name="warning" size={14} /> {h.refusals} refusals in a row: your decision</div>
      <div className="mb-2">Proposed <span className="font-mono">{h.decision.action} {JSON.stringify(h.decision.params)}</span>. {h.gate.reason}.</div>
      <div className="flex gap-2">
        <button className="os-btn" onClick={() => pending.settle("approve")}>Approve</button>
        <button className="os-btn" onClick={() => pending.settle("deny")}>Deny</button>
      </div>
    </div>
  );
}

/* ── tab 1: the harness ─────────────────────────────────────────────────── */

function HarnessTab(props: Shared) {
  const [envId, setEnvId] = useState<EnvId>("orderdesk");
  const [goal, setGoal] = useState(GOALS.orderdesk);
  const [steps, setSteps] = useState<TraceStep[]>([]);
  const [report, setReport] = useState<RunReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  const pickEnv = (id: EnvId) => {
    setEnvId(id);
    setGoal(GOALS[id]);
    if (id === "os" && props.decider === "scripted") props.setDecider("emulated");
  };

  const run = async () => {
    const c = new AbortController();
    ctrl.current = c;
    const d = props.makeDecider(c.signal, envId === "orderdesk");
    if (typeof d === "string") { setError(d); return; }
    setError(null); setSteps([]); setReport(null); setRunning(true);
    const jobs = useJobs.getState();
    const jobId = jobs.start({ title: `System One: ${goal.slice(0, 48)}`, kind: "agent", detail: d.label, target: { appId: "systemone", windowId: props.windowId } });
    const escalate = (h: Handoff) => new Promise<"approve" | "deny">((resolve) => {
      let settled = false;
      const settle = (v: "approve" | "deny") => {
        if (settled) return;
        settled = true;
        setPending(null);
        useJobs.getState().update(jobId, { status: "running", actions: undefined, detail: v === "approve" ? "Approved by you" : "Denied by you" });
        resolve(v);
      };
      setPending({ handoff: h, settle });
      useJobs.getState().update(jobId, {
        status: "blocked",
        detail: `Needs you: ${h.decision.action} (${h.gate.reason})`,
        actions: [{ id: "approve", label: "Approve", run: () => settle("approve") }, { id: "deny", label: "Deny", run: () => settle("deny") }],
      });
      bus.emit("notify", { title: "System One needs your decision", body: `${h.refusals} refusals in a row. Proposed ${h.decision.action}: ${h.gate.reason}.`, kind: "warn", jobId });
    });
    try {
      const r = await runSystemOne({
        goal, env: envId === "os" ? createOsEnv() : createOrderDesk(), decider: d, thresholds: props.thresholds,
        now: () => performance.now(), signal: c.signal, escalate,
        onStep: (s) => { setSteps((prev) => [...prev, s]); useJobs.getState().update(jobId, { detail: `Step ${s.n}: ${s.decision.action ?? "none"} (${s.verdict})` }); },
      });
      setReport(r);
      useJobs.getState().finish(jobId, r.status === "completed" ? "done" : "error", `${r.status}: ${r.reason}`);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setError(m);
      useJobs.getState().finish(jobId, "error", m);
    } finally {
      setRunning(false);
      setPending(null);
    }
  };

  const sidebar = (
    <div className="space-y-3">
      <Field label="Environment">
        <select className="os-input w-full" value={envId} onChange={(e) => pickEnv(e.target.value as EnvId)} aria-label="Environment">
          <option value="orderdesk">Order desk (benchmark)</option>
          <option value="os">This OS (windows, apps, theme)</option>
        </select>
      </Field>
      <DeciderSettings {...props} allowScripted={envId === "orderdesk"} />
    </div>
  );

  return (
    <div className="app-split flex h-full min-h-0">
      <div className="app-sidebar w-60 shrink-0 overflow-y-auto border-r border-[var(--border)] p-2">{sidebar}</div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 gap-2 border-b border-[var(--border)] p-2">
          <textarea className="os-input min-h-[52px] flex-1 text-[12px]" value={goal} onChange={(e) => setGoal(e.target.value)} aria-label="Goal" />
          {running
            ? <button className="os-btn" onClick={() => ctrl.current?.abort()}><Icon name="stop" size={12} className="mr-1 inline-block" />Stop</button>
            : <button className="os-btn os-btn-primary" onClick={() => void run()} disabled={!goal.trim()}><Icon name="play" size={12} className="mr-1 inline-block" />Run</button>}
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
          <ErrorNote error={error} onDismiss={() => setError(null)} />
          {pending && <EscalationCard pending={pending} />}
          {report && (
            <div className={cn("rounded-lg border p-2 text-[12px]", report.status === "completed" ? "border-emerald-400/50" : "border-amber-400/50")}>
              <span className="font-semibold">{report.status}</span> · {report.reason} · {report.steps.length} step(s) · ${report.costUsd.toFixed(6)}{report.steps.some((s) => s.costEstimated) ? " est." : ""}
              {report.handoff && <div className="mt-1 text-[11px] text-[var(--muted)]">Handed off with the full state, {Object.keys(report.handoff.questions).length} questions and their probabilities (see the last step).</div>}
            </div>
          )}
          {steps.length === 0 && !running && !report && <Empty icon="gate" title="No run yet" body="Each step compiles the available actions into typed questions, asks the decider once, and only acts when the weakest required probability clears the action's risk threshold." />}
          {running && steps.length === 0 && <Spinner label="Asking the decider" />}
          {[...steps].reverse().map((s) => <StepView key={s.n} s={s} />)}
        </div>
      </div>
    </div>
  );
}

/* ── tab 2: the router ──────────────────────────────────────────────────── */

type Phase = "idle" | "routing" | "routed" | "running" | "combining" | "done";

function RouterTab(props: Shared) {
  const [task, setTask] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [plan, setPlan] = useState<RoutePlan | null>(null);
  const [chosen, setChosen] = useState<HarnessId[]>([]);
  const [shape, setShape] = useState<OutputShape>("answer");
  const [outputs, setOutputs] = useState<HarnessOutput[]>([]);
  const [combined, setCombined] = useState<{ text: string; plan: SavePlan } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [s1Steps, setS1Steps] = useState<TraceStep[]>([]);
  const ctrl = useRef<AbortController | null>(null);

  const route = async () => {
    const c = new AbortController();
    ctrl.current = c;
    const d = props.makeDecider(c.signal, false);
    if (typeof d === "string") { setError(d); return; }
    setError(null); setPlan(null); setOutputs([]); setCombined(null); setS1Steps([]); setPhase("routing");
    try {
      const questions = routerQuestions();
      const res = await d.decide({ state: `TASK: ${task}`, questions });
      const p = planRoute(res.raw, questions);
      setPlan(p);
      setChosen(p.selected.map((s) => s.id));
      setShape(p.shape.shape);
      setPhase("routed");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("idle");
    }
  };

  const execute = async () => {
    const c = new AbortController();
    ctrl.current = c;
    const d = props.makeDecider(c.signal, false);
    if (typeof d === "string") { setError(d); return; }
    setError(null); setOutputs([]); setCombined(null); setS1Steps([]); setPhase("running");
    const escalate = (h: Handoff) => new Promise<"approve" | "deny">((resolve) => {
      let settled = false;
      const settle = (v: "approve" | "deny") => { if (settled) return; settled = true; setPending(null); resolve(v); };
      setPending({ handoff: h, settle });
      bus.emit("notify", { title: "Harness Router: System One needs your decision", body: h.gate.reason, kind: "warn", target: { appId: "systemone", windowId: props.windowId } });
    });
    try {
      const outs = await runHarnesses(chosen, task, { signal: c.signal, decider: d, thresholds: props.thresholds, escalate, onStep: (s) => setS1Steps((p) => [...p, s]) }, (o) => setOutputs((p) => [...p.filter((x) => x.id !== o.id), o]));
      if (c.signal.aborted) { setPhase("routed"); return; }
      setPhase("combining");
      const r = await combineAndSave(task, shape, outs, c.signal);
      setCombined({ text: r.text, plan: r.plan });
      setPhase("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("routed");
    } finally {
      setPending(null);
    }
  };

  const toggle = (id: HarnessId) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  const busy = phase === "routing" || phase === "running" || phase === "combining";

  return (
    <div className="app-split flex h-full min-h-0">
      <div className="app-sidebar w-60 shrink-0 overflow-y-auto border-r border-[var(--border)] p-2">
        <DeciderSettings {...props} allowScripted={false} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 gap-2 border-b border-[var(--border)] p-2">
          <textarea className="os-input min-h-[52px] flex-1 text-[12px]" placeholder="Describe a task. The decider picks which harnesses fit, they run, and a combiner merges their work." value={task} onChange={(e) => setTask(e.target.value)} aria-label="Task" />
          <div className="flex flex-col gap-1">
            {busy
              ? <button className="os-btn" onClick={() => ctrl.current?.abort()}><Icon name="stop" size={12} className="mr-1 inline-block" />Stop</button>
              : <button className="os-btn os-btn-primary" onClick={() => void route()} disabled={!task.trim()}><Icon name="network" size={12} className="mr-1 inline-block" />Route</button>}
            {plan && !busy && <button className="os-btn" onClick={() => void execute()} disabled={chosen.length === 0}><Icon name="play" size={12} className="mr-1 inline-block" />Run {chosen.length}</button>}
          </div>
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2 text-[12px]">
          <ErrorNote error={error} onDismiss={() => setError(null)} />
          {pending && <EscalationCard pending={pending} />}
          {phase === "idle" && !plan && <Empty icon="network" title="Route a task" body="Five harnesses are available: Agent Loop, the ReAct harness, the AIOS Chat agent, the System One harness and a direct answer." />}
          {phase === "routing" && <Spinner label="Asking the decider which harnesses fit" />}
          {plan && (
            <div className="rounded-lg border border-[var(--border)] p-2">
              <div className="mb-1 font-semibold">Route {props.decider === "emulated" && <span className="font-normal text-[var(--muted)]">(emulated decider, probabilities not calibrated)</span>}</div>
              <div className="mb-2 space-y-1">
                {(Object.keys(HARNESSES) as HarnessId[]).map((id) => (
                  <label key={id} className="flex items-center gap-2">
                    <input type="checkbox" checked={chosen.includes(id)} onChange={() => toggle(id)} disabled={busy} aria-label={`Run ${HARNESSES[id].name}`} />
                    <div className="flex-1"><Bar label={`${HARNESSES[id].name}${plan.primary.id === id ? " (primary)" : ""}`} p={plan.fits[id] ?? 0} strong={chosen.includes(id)} title={HARNESSES[id].description} /></div>
                  </label>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-3 text-[11px] text-[var(--muted)]">
                <span>Primary {plan.primary.id} at {plan.primary.p.toFixed(2)}</span>
                {plan.difficulty && <span>Difficulty {plan.difficulty.label} ({plan.difficulty.p.toFixed(2)})</span>}
                <label className="flex items-center gap-1">Shape
                  <select className="os-input !py-0.5 text-[11px]" value={shape} onChange={(e) => setShape(e.target.value as OutputShape)} disabled={busy} aria-label="Output shape">
                    {(Object.keys(SHAPES) as OutputShape[]).map((s) => <option key={s} value={s}>{s}{s === plan.shape.shape ? ` (${plan.shape.p.toFixed(2)})` : ""}</option>)}
                  </select>
                </label>
              </div>
              {plan.fallback && <div className="mt-1 text-[11px] text-amber-300">{plan.fallback}</div>}
              {Object.keys(plan.discarded).length > 0 && <div className="mt-1 text-[11px] text-[var(--danger,#f87171)]">Discarded (not offered): {Object.entries(plan.discarded).map(([q, v]) => `${q}: ${v.join(", ")}`).join("; ")}</div>}
              {plan.problems.length > 0 && <div className="mt-1 text-[11px] text-amber-300">{plan.problems.join("; ")}</div>}
            </div>
          )}
          {(phase === "running" || phase === "combining") && <Spinner label={phase === "running" ? `Running ${chosen.length} harness(es), each a live job` : "Combining into one product"} />}
          {outputs.map((o) => (
            <details key={o.id} className="rounded-lg border border-[var(--border)] p-2" open={!o.ok}>
              <summary className="cursor-pointer"><span className="font-semibold">{HARNESSES[o.id].name}</span> <span className={o.ok ? "text-emerald-300" : "text-amber-300"}>{o.ok ? "ok" : "not ok"}</span>{o.files?.length ? ` · ${o.files.length} file(s)` : ""}</summary>
              <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap text-[11px]">{o.text}</pre>
            </details>
          ))}
          {s1Steps.length > 0 && <div className="space-y-1">{[...s1Steps].reverse().map((s) => <StepView key={s.n} s={s} />)}</div>}
          {combined && (
            <div className="rounded-lg border border-emerald-400/50 p-2">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className="font-semibold">Combined ({shape})</span>
                <span className="text-[11px] text-[var(--muted)]">Saved {combined.plan.writes.length} file(s) · {combined.plan.primaryPath}</span>
                <button className="os-btn !py-0.5 text-[11px]" onClick={() => bus.emit("app:open", { appId: "files" })}><Icon name="folder" size={11} className="mr-1 inline-block" />Open Files</button>
                {combined.plan.zip && <button className="os-btn !py-0.5 text-[11px]" onClick={() => downloadPlanZip(combined.plan.zip!)}><Icon name="download" size={11} className="mr-1 inline-block" />Download {combined.plan.zip.name}</button>}
              </div>
              <Markdown text={combined.text} className="text-[12px]" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
