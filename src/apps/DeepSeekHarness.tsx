"use client";

import { useEffect, useState } from "react";
import type { AppProps } from "@/kernel/types";
import { useModelCatalog, modelsFor } from "@/kernel/modelcatalog";
import { PROVIDERS } from "@/lib/providers";
import { cn } from "@/lib/cn";
import { Icon } from "@/shell/icons";
import { Tabs, Empty, Spinner } from "./_ui";
import { dsh, useDsh } from "@/lib/dsh/runtime";
import { PERMISSION_PRESETS, type PermissionPreset } from "@/lib/dsh/policy";
import type { DshEvent } from "@/lib/dsh/session";

/* DeepSeek Harness, re-created as dsh-lite: a plugin context with reversible
   effects, an append-only session log the model's history is derived from,
   the turn/step loop with waterfall seams, approvals through live jobs,
   compaction, subagents, goals judged by the harness, Ralph and skills.
   Credit: github.com/deepseek-ai/deepseek-harness (MIT); see the About tab
   and src/vendor/dsh/NOTICE.md for exactly what is vendored. */

const TABS = [
  { id: "chat", label: "Chat", icon: "chat" },
  { id: "log", label: "Session log", icon: "report" },
  { id: "plugins", label: "Plugins", icon: "package" },
  { id: "about", label: "About", icon: "info" },
];

export default function DeepSeekHarness(_props: AppProps) {
  void _props;
  const [tab, setTab] = useState("chat");
  const version = useDsh((s) => s.version);
  const sessions = useDsh((s) => s.sessions);
  const activeId = useDsh((s) => s.activeId);
  const running = useDsh((s) => s.running);
  const [booted, setBooted] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    // Booting writes stores (sessions, the default skill), so it happens after
    // the first paint rather than during render.
    // A timeout, not requestAnimationFrame: rAF never fires in a hidden tab,
    // so a harness opened in a background tab sat on its spinner until the
    // tab was shown. Timers still run there (throttled), which is enough.
    const id = setTimeout(() => { dsh(); setBooted(true); }, 0);
    return () => clearTimeout(id);
  }, []);

  if (!booted) return <div className="grid h-full place-items-center"><Spinner label="Loading DeepSeek Harness" /></div>;
  const rt = dsh();
  const turns = activeId ? rt.turns(activeId) : [];
  void version;

  return (
    <div className="app-split flex h-full min-h-0">
      <div className="app-sidebar w-56 shrink-0 overflow-y-auto border-r border-[var(--border)] p-2 text-[12px]">
        <button className="os-btn os-btn-primary mb-2 w-full" onClick={() => rt.newSession()} disabled={running}>
          <Icon name="plus" size={12} className="mr-1 inline-block" />New session
        </button>
        <label className="mb-2 flex items-center gap-1 text-[11px] text-[var(--muted)]">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />Show archived
        </label>
        {sessions.filter((m) => showArchived || !m.archived).map((m) => (
          <div key={m.id} className={cn("group mb-1 flex items-center gap-1 rounded px-1.5 py-1", m.id === activeId ? "bg-[var(--accent)]/15" : "hover:bg-white/5")}>
            <button className="min-w-0 flex-1 truncate text-left" onClick={() => rt.select(m.id)} disabled={running} title={m.title}>
              {m.parent ? <Icon name="link" size={10} className="mr-1 inline-block opacity-60" /> : null}
              {m.archived ? <span className="opacity-50">{m.title}</span> : m.title}
            </button>
            <button className="opacity-60 hover:opacity-100" aria-label={m.archived ? `Unarchive ${m.title}` : `Archive ${m.title}`} title={m.archived ? "Unarchive" : "Archive (never deleted)"} onClick={() => rt.archive(m.id, !m.archived)} disabled={running}>
              <Icon name={m.archived ? "refresh" : "backup"} size={11} />
            </button>
          </div>
        ))}
        {activeId && turns.length > 0 && (
          <div className="mt-3 border-t border-[var(--border)] pt-2">
            <div className="mb-1 text-[11px] font-semibold text-[var(--muted)]">Turns: fork at a boundary</div>
            {turns.map((t) => (
              <div key={t.turn} className="mb-1 flex items-center gap-1">
                <span className="min-w-0 flex-1 truncate" title={t.input}>{t.turn + 1}. {t.input}</span>
                <button className="os-btn px-1.5 py-0.5 text-[10px]" onClick={() => rt.forkAt(activeId, t.turn)} disabled={running} aria-label={`Fork after turn ${t.turn + 1}`}>Fork</button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <Tabs tabs={TABS} active={tab} onChange={setTab} />
        {tab === "chat" && <ChatPane />}
        {tab === "log" && <LogPane />}
        {tab === "plugins" && <PluginsPane />}
        {tab === "about" && <AboutPane />}
      </div>
    </div>
  );
}

function Controls() {
  const ui = useDsh();
  const lists = useModelCatalog((s) => s.lists);
  const models = modelsFor(ui.provider, lists);
  const judgeModels = modelsFor(ui.judgeProvider, lists);
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border)] p-2 text-[11px]">
      <select className="os-input" aria-label="Provider" value={ui.provider} onChange={(e) => ui.set({ provider: e.target.value, model: modelsFor(e.target.value, lists)[0]?.id ?? "" })}>
        {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <input className="os-input w-44" aria-label="Model id" list="dsh-models" value={ui.model} onChange={(e) => ui.set({ model: e.target.value })} />
      <datalist id="dsh-models">{models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</datalist>
      <select className="os-input" aria-label="Permission preset" value={ui.preset} onChange={(e) => ui.set({ preset: e.target.value as PermissionPreset })} title={PERMISSION_PRESETS.find((p) => p.id === ui.preset)?.description}>
        {PERMISSION_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select>
      <select className="os-input" aria-label="Tool calling mode" value={ui.toolMode} onChange={(e) => ui.set({ toolMode: e.target.value as "native" | "json" })}>
        <option value="native">Native tool calls</option>
        <option value="json">JSON tool protocol</option>
      </select>
      <span className="text-[var(--muted)]">Judge</span>
      <select className="os-input" aria-label="Judge provider" value={ui.judgeProvider} onChange={(e) => ui.set({ judgeProvider: e.target.value, judgeModel: modelsFor(e.target.value, lists)[0]?.id ?? "" })}>
        {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <input className="os-input w-36" aria-label="Judge model id" list="dsh-judge-models" value={ui.judgeModel} onChange={(e) => ui.set({ judgeModel: e.target.value })} />
      <datalist id="dsh-judge-models">{judgeModels.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</datalist>
    </div>
  );
}

function Meter({ id }: { id: string }) {
  useDsh((s) => s.version);
  const m = dsh().meter(id);
  return (
    <div className="flex shrink-0 gap-3 border-t border-[var(--border)] px-2 py-1 text-[10px] text-[var(--muted)]" aria-label="Token and cost meter">
      <span title="dsh token-meter heuristic (vendored estimate.ts) over the derived history">context ~{m.contextTokens.toLocaleString()} tok</span>
      <span>{m.requests} request{m.requests === 1 ? "" : "s"}</span>
      <span title="Summed from each assistant/message's cost, as ask() computed it">${m.costUsd.toFixed(6)}</span>
    </div>
  );
}

function ChatPane() {
  const ui = useDsh();
  const [input, setInput] = useState("");
  const [goal, setGoal] = useState("");
  const [rounds, setRounds] = useState(4);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const rt = dsh();
  const log = ui.activeId ? rt.log(ui.activeId) : undefined;
  const events = log?.events ?? [];
  // While a turn runs, Enter keeps the text (it used to be cleared and lost).
  const send = () => { const t = input.trim(); if (!t || ui.running) return; setInput(""); void rt.send(t); };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Controls />
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2 text-[12px]">
        {!events.length && !ui.running && (
          <Empty icon="agents" title="DeepSeek Harness" body="Ask for something that needs tools: read or write files, grep, run JavaScript in a sandbox, fetch a page, open an app. Type /verify to use the bundled skill. Set a goal below and the harness, not the model, decides when it is met." />
        )}
        <Transcript events={events} running={ui.running} onResume={(t) => void rt.send(t)} />
        {ui.approvals.map((a) => (
          <div key={a.callId} className="rounded-lg border border-amber-400/60 p-2" role="alert">
            <div className="mb-1 font-semibold">Approve {a.name}? <span className="text-[var(--muted)]">({a.risk})</span></div>
            <pre className="mb-2 max-h-32 overflow-auto whitespace-pre-wrap text-[11px]">{a.args}</pre>
            <button className="os-btn os-btn-primary mr-2" onClick={() => rt.settle(a.callId, true)}><Icon name="check" size={12} className="mr-1 inline-block" />Approve</button>
            <button className="os-btn" onClick={() => rt.settle(a.callId, false)}><Icon name="ban" size={12} className="mr-1 inline-block" />Deny</button>
          </div>
        ))}
        {ui.questions.map((q) => (
          <div key={q.callId} className="rounded-lg border border-sky-400/60 p-2" role="alert">
            <div className="mb-1 font-semibold">{q.question}</div>
            <div className="flex gap-2">
              <input className="os-input flex-1" aria-label="Your answer" value={answers[q.callId] ?? ""} onChange={(e) => setAnswers({ ...answers, [q.callId]: e.target.value })} />
              <button className="os-btn os-btn-primary" onClick={() => rt.answer(q.callId, answers[q.callId] ?? "")}>Answer</button>
              <button className="os-btn" onClick={() => rt.answer(q.callId, null)}>Skip</button>
            </div>
          </div>
        ))}
        {ui.running && (ui.streamReasoning || ui.streamText) && (
          <div className="rounded-lg border border-[var(--border)] p-2">
            {ui.streamReasoning && <details><summary className="cursor-pointer text-[11px] text-[var(--muted)]">Reasoning (streaming)</summary><pre className="whitespace-pre-wrap text-[11px] text-[var(--muted)]">{ui.streamReasoning}</pre></details>}
            <div className="whitespace-pre-wrap">{ui.streamText}</div>
          </div>
        )}
        {ui.running && <Spinner label="Working" />}
      </div>
      <div className="shrink-0 space-y-2 border-t border-[var(--border)] p-2">
        <div className="flex gap-2">
          <textarea className="os-input min-h-[44px] flex-1 text-[12px]" aria-label="Message" value={input} placeholder="Message, or /skill-name then a task" onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
          {ui.running
            ? <button className="os-btn" onClick={() => rt.cancel()}><Icon name="stop" size={12} className="mr-1 inline-block" />Stop</button>
            : <button className="os-btn os-btn-primary" onClick={send} disabled={!input.trim()}><Icon name="play" size={12} className="mr-1 inline-block" />Send</button>}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <input className="os-input min-w-[200px] flex-1" aria-label="Goal" placeholder="Goal (judged by the harness from tool evidence)" value={goal} onChange={(e) => setGoal(e.target.value)} />
          <label className="flex items-center gap-1">Rounds<input className="os-input w-14" type="number" min={1} max={12} aria-label="Maximum rounds" value={rounds} onChange={(e) => setRounds(Math.max(1, Math.min(12, Number(e.target.value) || 1)))} /></label>
          <button className="os-btn" disabled={ui.running || !goal.trim()} onClick={() => void rt.goal(goal.trim(), rounds)}><Icon name="trophy" size={12} className="mr-1 inline-block" />Run goal</button>
          <button className="os-btn" disabled={ui.running || !goal.trim()} onClick={() => void rt.ralph(goal.trim(), rounds)} title="Fresh agent per round; only a bounded report crosses rounds"><Icon name="loop" size={12} className="mr-1 inline-block" />Ralph loop</button>
          {ui.goalStatus && <span className="text-[var(--muted)]">Goal: {ui.goalStatus}</span>}
        </div>
      </div>
      {ui.activeId && <Meter id={ui.activeId} />}
    </div>
  );
}

function Transcript({ events, running, onResume }: { events: readonly DshEvent[]; running?: boolean; onResume?: (text: string) => void }) {
  const results = new Map<string, Extract<DshEvent, { type: "tool/result" }>>();
  for (const e of events) if (e.type === "tool/result") results.set(e.data.callId, e);
  return (
    <>
      {events.map((e) => {
        switch (e.type) {
          case "user/message":
            return <div key={e.seq} className="ml-8 whitespace-pre-wrap rounded-lg bg-[var(--accent)]/15 p-2">{e.data.text}</div>;
          case "assistant/message":
            return (
              <div key={e.seq} className="mr-8 rounded-lg border border-[var(--border)] p-2">
                {e.data.reasoning && <details><summary className="cursor-pointer text-[11px] text-[var(--muted)]">Reasoning</summary><pre className="whitespace-pre-wrap text-[11px] text-[var(--muted)]">{e.data.reasoning}</pre></details>}
                {e.data.text ? <div className="whitespace-pre-wrap">{e.data.text}</div> : !e.data.toolCalls?.length && <div className="text-[var(--muted)]">(empty reply)</div>}
              </div>
            );
          case "tool/call": {
            const r = results.get(e.data.callId);
            return (
              <details key={e.seq} className={cn("mr-8 rounded-lg border p-2", !r ? "border-[var(--border)]" : r.data.isError ? "border-rose-400/60" : "border-emerald-400/50")}>
                <summary className="cursor-pointer">
                  <Icon name="wand" size={11} className="mr-1 inline-block" />
                  <span className="font-mono">{e.data.name}</span>
                  <span className="ml-2 text-[10px] text-[var(--muted)]">
                    {r ? `${r.data.ms} ms` : "running"}{r?.data.approval ? ` · ${r.data.approval}` : ""}{r?.data.isError ? " · error" : ""}
                  </span>
                </summary>
                <div className="mt-1 text-[10px] font-semibold text-[var(--muted)]">args</div>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-[11px]">{e.data.args}</pre>
                {r && <><div className="mt-1 text-[10px] font-semibold text-[var(--muted)]">result</div><pre className="max-h-60 overflow-auto whitespace-pre-wrap text-[11px]">{r.data.content}</pre></>}
              </details>
            );
          }
          case "assistant/attempt":
            return <div key={e.seq} className="text-[11px] text-amber-300">Attempt {e.data.reason}{e.data.error ? `: ${e.data.error}` : ""} (not in model history)</div>;
          case "turn/end":
            if (e.data.reason === "done") return null;
            {
              // Resumable: the log already holds every finished step and tool
              // result, so continuing from it does not redo work. Only the
              // LAST interrupted turn offers it.
              const isLast = events.filter((x) => x.type === "turn/end").at(-1)?.seq === e.seq;
              const canResume = isLast && !running && !!onResume && (e.data.reason === "cancelled" || e.data.reason === "error");
              return (
                <div key={e.seq} className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--muted)]" data-dsh-turn-end={e.data.reason}>
                  Turn ended: {e.data.reason}{e.data.error ? ` - ${e.data.error}` : ""}
                  {canResume && (
                    <button className="os-btn !px-2 !py-0.5 text-[10.5px]" onClick={() => onResume?.(`Continue the task from where it stopped (it ended: ${e.data.reason}${e.data.error ? `, ${e.data.error}` : ""}). The steps and tool results above already happened: do not redo them.`)}>
                      Resume
                    </button>
                  )}
                </div>
              );
            }
          case "goal/verdict":
            return <div key={e.seq} className={cn("rounded border p-1.5 text-[11px]", e.data.met ? "border-emerald-400/60" : "border-amber-400/60")}>Judge ({e.data.judge}) round {e.data.round + 1}: {e.data.met ? "MET" : "not met"} - {e.data.note}</div>;
          case "compaction/summary":
            return <div key={e.seq} className="text-[11px] text-[var(--muted)]">History compacted (~{e.data.beforeTokens} tokens summarized).</div>;
          case "compaction/prune":
            return <div key={e.seq} className="text-[11px] text-[var(--muted)]">Pruned {e.data.replacements.length} old tool result(s), {e.data.savedChars} chars.</div>;
          case "note":
            return <div key={e.seq} className="text-[11px] text-[var(--muted)]">{e.data.text}</div>;
          default:
            return null;
        }
      })}
    </>
  );
}

function LogPane() {
  const activeId = useDsh((s) => s.activeId);
  useDsh((s) => s.version);
  const log = activeId ? dsh().log(activeId) : undefined;
  if (!log) return <Empty icon="report" title="No session" />;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-2 font-mono text-[11px]">
      <div className="mb-2 text-[var(--muted)]">{log.length} durable events. Stored at /dsh/sessions/{activeId}.jsonl. Model history is derived from exactly these.</div>
      {log.events.map((e) => (
        <details key={e.seq} className="border-b border-[var(--border)] py-0.5">
          <summary className="cursor-pointer"><span className="text-[var(--muted)]">#{e.seq}</span> <span className="font-semibold">{e.type}</span></summary>
          <pre className="whitespace-pre-wrap">{JSON.stringify(e.data, null, 2)}</pre>
        </details>
      ))}
    </div>
  );
}

function PluginsPane() {
  useDsh((s) => s.version);
  const running = useDsh((s) => s.running);
  const rt = dsh();
  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2 text-[12px]">
      <div className="text-[var(--muted)]">Every registration is an effect owned by its plugin. Unloading a plugin disposes all of them; loading it again re-registers them. Live registrations: {rt.ctx.registrationCount()}.</div>
      {rt.allPlugins().map((p) => {
        const on = rt.ctx.isLoaded(p.name);
        const effects = rt.ctx.effectsOf(p.name);
        return (
          <div key={p.name} className="rounded-lg border border-[var(--border)] p-2">
            <label className="flex items-center gap-2 font-semibold">
              <input type="checkbox" checked={on} disabled={p.required || running} onChange={() => rt.togglePlugin(p.name)} aria-label={`${on ? "Unload" : "Load"} ${p.name}`} />
              {p.name}{p.required ? <span className="text-[10px] font-normal text-[var(--muted)]">(core)</span> : null}
            </label>
            <div className="mt-1 text-[11px] text-[var(--muted)]">{p.description}</div>
            <div className="mt-1 text-[10px]">{on ? effects.map((f) => `${f.kind}:${f.label}`).join("  ") || "(no registrations)" : "unloaded - nothing registered"}</div>
          </div>
        );
      })}
    </div>
  );
}

function AboutPane() {
  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3 text-[12px]">
      <div className="text-[14px] font-semibold">DeepSeek Harness, in Web-AIOS</div>
      <p>
        Based on <a className="underline" href="https://github.com/deepseek-ai/deepseek-harness" target="_blank" rel="noreferrer">DeepSeek Harness</a> by DeepSeek, MIT License.
        Framework-free parts of its source are vendored verbatim under <span className="font-mono">src/vendor/dsh/</span> (LICENSE and NOTICE.md list every file and the upstream commit):
        JSON-schema validation of tool arguments, the token-meter estimate, the tool-result pruner budgets, compaction thresholds and the time-context timestamp are that code running here.
      </p>
      <p>
        The orchestration upstream gets from Cordis (plugin context, waterfalls, reversible effects), the agent loop, session persistence, subagents, goals and Ralph
        are a browser re-implementation called dsh-lite, written from upstream&apos;s architecture and subsystem docs. It is not upstream code and it does not run Cordis.
      </p>
      <p className="text-[var(--muted)]">Differences on purpose: goals and Ralph completion are judged by a separate model call from logged tool evidence, never by the agent saying it is done. Sessions are archived, never deleted.</p>
    </div>
  );
}
