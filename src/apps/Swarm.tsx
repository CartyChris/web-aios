"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useSettings } from "@/kernel/settings";
import { useVFS } from "@/kernel/vfs";
import { bus } from "@/kernel/bus";
import { ask } from "@/lib/useAI";
import { PROVIDERS, getProvider } from "@/lib/providers";
import type { AppProps } from "@/kernel/types";
import { uid, download } from "@/lib/format";
import { Markdown, CopyButton, ErrorNote, Tabs, Slider, Toggle } from "./_ui";
import { cn } from "@/lib/cn";
import { Icon } from "@/shell/icons";

/* ────────────────────────────────────────────────────────────────────────────
   Agent Swarm — ported from illumine-agent-swarm.

   The idea the original got right: one question, many differently-briefed
   agents, then a reconciliation pass that has to account for disagreement
   rather than average it away. What is added here is a concurrency limiter and
   a hard budget stop, because the failure mode of a swarm is not a bad answer —
   it is forty parallel requests and a surprise invoice.
   ──────────────────────────────────────────────────────────────────────────── */

export interface Agent {
  id: string;
  name: string;
  role: string;
  model?: string;
  provider?: string;
  enabled: boolean;
}

export interface AgentRun {
  agentId: string;
  status: "idle" | "running" | "done" | "error" | "skipped";
  output: string;
  ms?: number;
  costUsd?: number;
  error?: string;
}

interface Formation {
  id: string;
  name: string;
  description: string;
  agents: Omit<Agent, "id" | "enabled">[];
}

export const FORMATIONS: Formation[] = [
  {
    id: "redblue",
    name: "Red / Blue",
    description: "One agent argues for, one against, a third judges the exchange.",
    agents: [
      { name: "Red Team", role: "Argue the strongest case AGAINST the proposition. Give concrete failure modes, not vague doubt. Cite the specific mechanism by which it fails." },
      { name: "Blue Team", role: "Argue the strongest case FOR the proposition. Give concrete mechanisms and evidence, not enthusiasm." },
      { name: "Challenger", role: "Attack the weakest assumption on BOTH sides. Name the assumption explicitly before attacking it." },
    ],
  },
  {
    id: "research",
    name: "Research Desk",
    description: "Digger, corroborator, gap-finder and bias spotter.",
    agents: [
      { name: "Digger", role: "Surface the specific facts, numbers, dates and named entities relevant to the question. Mark anything you are not certain of." },
      { name: "Corroborator", role: "For each claim in the question, say what independent evidence would confirm it and whether you believe such evidence exists." },
      { name: "Gap Finder", role: "List what is NOT known, what data is missing, and what question should have been asked instead." },
      { name: "Bias Spotter", role: "Identify framing effects, loaded terms and motivated reasoning in the question itself." },
    ],
  },
  {
    id: "engineering",
    name: "Engineering Review",
    description: "Architect, implementer, security and performance reviewers.",
    agents: [
      { name: "Architect", role: "Propose the structure. Name the boundaries, the data flow and the one decision that is hardest to reverse later." },
      { name: "Implementer", role: "Write the actual code or the precise steps. Working detail, not description of detail." },
      { name: "Security", role: "Find the trust boundaries and what crosses them. Name concrete attacks, not categories of attack." },
      { name: "Performance", role: "Identify the hot path and what dominates it. Give an order-of-magnitude estimate, and say what you assumed." },
      { name: "Critic", role: "Argue this whole approach is wrong and something simpler would do. Make the strongest version of that case." },
    ],
  },
  {
    id: "explainers",
    name: "Explainer Panel",
    description: "Four explanations of the same thing at different altitudes.",
    agents: [
      { name: "One Sentence", role: "Explain in exactly one sentence. No hedging, no clauses stacked to avoid committing." },
      { name: "Intuition", role: "Build the reader's intuition with one concrete analogy and one worked example. No formalism." },
      { name: "Mechanism", role: "Explain precisely how it works, step by step, at the level a practitioner needs." },
      { name: "Edge Cases", role: "Explain when the usual explanation breaks down and what the exceptions are." },
    ],
  },
  {
    id: "consensus",
    name: "Consensus Clones",
    description: "Same brief, run N times, to see where the model is actually stable.",
    agents: [
      { name: "Clone A", role: "Answer the question directly and completely." },
      { name: "Clone B", role: "Answer the question directly and completely." },
      { name: "Clone C", role: "Answer the question directly and completely." },
    ],
  },
];

const SYNTH_PROMPT = `You are reconciling several independent agent responses to one question.

Your job is NOT to average them. Do this instead:
1. State the answer the evidence best supports.
2. Name every point where the agents genuinely disagreed, and say which side is better supported and why.
3. List what remains unresolved — questions none of the agents could settle.

Be specific about which agent said what. If the agents mostly agree, say so plainly and briefly rather than manufacturing tension.`;

export default function Swarm({}: AppProps) {
  const settings = useSettings();
  const vfs = useVFS();
  const [tab, setTab] = useState("run");
  const [question, setQuestion] = useState("");
  const [formationId, setFormationId] = useState("redblue");
  const [agents, setAgents] = useState<Agent[]>(() =>
    FORMATIONS[0].agents.map((a) => ({ ...a, id: uid("ag"), enabled: true })),
  );
  const [runs, setRuns] = useState<Record<string, AgentRun>>({});
  const [synthesis, setSynthesis] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [concurrency, setConcurrency] = useState(3);
  const [doSynthesis, setDoSynthesis] = useState(true);
  const [maxTokensPerAgent, setMaxTokensPerAgent] = useState(1200);
  const abortRef = useRef<AbortController | null>(null);

  const loadFormation = useCallback((id: string) => {
    const f = FORMATIONS.find((x) => x.id === id);
    if (!f) return;
    setFormationId(id);
    setAgents(f.agents.map((a) => ({ ...a, id: uid("ag"), enabled: true })));
    setRuns({});
    setSynthesis("");
  }, []);

  const totalCost = useMemo(() => Object.values(runs).reduce((a, r) => a + (r.costUsd ?? 0), 0), [runs]);
  const active = agents.filter((a) => a.enabled);

  const launch = useCallback(async () => {
    if (!question.trim() || busy) return;
    if (!active.length) { setError("Enable at least one agent."); return; }

    setError(null);
    setBusy(true);
    setSynthesis("");
    setRuns(Object.fromEntries(active.map((a) => [a.id, { agentId: a.id, status: "idle" as const, output: "" }])));

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const results: Array<{ agent: Agent; text: string }> = [];
    let stoppedForBudget = false;

    // A bounded worker pool. Unbounded Promise.all over a formation is how a
    // swarm turns into a rate-limit wall and a bill nobody approved.
    const queue = [...active];
    const worker = async () => {
      while (queue.length) {
        if (ctrl.signal.aborted) return;
        const agent = queue.shift();
        if (!agent) return;

        const s = useSettings.getState();
        if (s.ai.budgetUsd > 0 && s.ai.spentUsd >= s.ai.budgetUsd) {
          stoppedForBudget = true;
          setRuns((r) => ({ ...r, [agent.id]: { agentId: agent.id, status: "skipped", output: "", error: "Budget reached" } }));
          continue;
        }

        setRuns((r) => ({ ...r, [agent.id]: { agentId: agent.id, status: "running", output: "" } }));
        try {
          const res = await ask({
            messages: [{ role: "user", content: question }],
            system: `You are "${agent.name}", one agent in a panel answering the same question.\n\nYour brief: ${agent.role}\n\nStay in your lane — another agent covers the other angles. Be substantive and concise; you have a limited budget.`,
            provider: agent.provider,
            model: agent.model,
            maxTokens: maxTokensPerAgent,
            signal: ctrl.signal,
            onDelta: (_d, full) =>
              setRuns((r) => ({ ...r, [agent.id]: { ...r[agent.id], agentId: agent.id, status: "running", output: full } })),
          });
          results.push({ agent, text: res.text });
          setRuns((r) => ({ ...r, [agent.id]: { agentId: agent.id, status: "done", output: res.text, ms: res.ms, costUsd: res.costUsd } }));
        } catch (e) {
          if ((e as Error).name === "AbortError") return;
          const msg = e instanceof Error ? e.message : "Agent failed.";
          setRuns((r) => ({ ...r, [agent.id]: { agentId: agent.id, status: "error", output: "", error: msg } }));
        }
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, active.length) }, worker));

      if (stoppedForBudget) setError(`Budget of $${useSettings.getState().ai.budgetUsd.toFixed(2)} reached — some agents were skipped.`);

      if (doSynthesis && results.length > 1 && !ctrl.signal.aborted) {
        const transcript = results.map((r) => `### ${r.agent.name}\n_Brief: ${r.agent.role}_\n\n${r.text}`).join("\n\n---\n\n");
        const res = await ask({
          messages: [{ role: "user", content: `Question:\n${question}\n\n---\n\nAgent responses:\n\n${transcript}` }],
          system: SYNTH_PROMPT,
          maxTokens: 2000,
          signal: ctrl.signal,
          onDelta: (_d, full) => setSynthesis(full),
        });
        setSynthesis(res.text);
      }
      bus.emit("notify", { title: "Swarm finished", body: `${results.length} of ${active.length} agents completed.`, kind: "success" });
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError(e instanceof Error ? e.message : "Swarm failed.");
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [question, busy, active, concurrency, doSynthesis, maxTokensPerAgent]);

  const report = useCallback(() => {
    const lines = [
      `# Swarm: ${question.slice(0, 80)}`,
      "",
      `> Formation: ${FORMATIONS.find((f) => f.id === formationId)?.name ?? "custom"}`,
      `> Run: ${new Date().toISOString()}`,
      `> Estimated cost: $${totalCost.toFixed(4)}`,
      "",
      "## Question",
      "",
      question,
      "",
    ];
    if (synthesis) lines.push("## Synthesis", "", synthesis, "");
    lines.push("## Agent responses", "");
    for (const a of active) {
      const r = runs[a.id];
      lines.push(`### ${a.name}`, "", `_${a.role}_`, "", r?.output || `_(${r?.status ?? "not run"}${r?.error ? `: ${r.error}` : ""})_`, "");
    }
    return lines.join("\n");
  }, [question, formationId, totalCost, synthesis, active, runs]);

  return (
    <div className="flex h-full flex-col">
      <Tabs
        tabs={[{ id: "run", label: "Run", icon: "play" }, { id: "agents", label: `Agents (${active.length})`, icon: "swarm" }, { id: "settings", label: "Tuning", icon: "tune" }]}
        active={tab}
        onChange={setTab}
      />

      {tab === "run" && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 border-b border-[var(--border)] p-2.5">
            <ErrorNote error={error} onDismiss={() => setError(null)} />
            <div className="mb-2 flex flex-wrap gap-1.5">
              {FORMATIONS.map((f) => (
                <button
                  key={f.id}
                  onClick={() => loadFormation(f.id)}
                  title={f.description}
                  className={cn("os-btn !py-1 text-[11px]", formationId === f.id && "!border-[var(--accent)] !bg-[var(--accent)]/16")}
                >
                  {f.name}
                </button>
              ))}
            </div>
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="The question every agent will answer…"
              rows={3}
              className="os-input mb-2 resize-none"
            />
            <div className="flex flex-wrap items-center gap-1.5">
              {busy ? (
                <button className="os-btn" onClick={() => abortRef.current?.abort()}>◼ Stop swarm</button>
              ) : (
                <button className="os-btn" data-variant="primary" onClick={launch} disabled={!question.trim()}>
                  Launch {active.length} agents
                </button>
              )}
              <span className="text-[11px] text-[var(--muted)]">
                {FORMATIONS.find((f) => f.id === formationId)?.description}
              </span>
              <div className="flex-1" />
              {totalCost > 0 && <span className="os-chip">~${totalCost.toFixed(4)}</span>}
              {(synthesis || Object.keys(runs).length > 0) && (
                <>
                  <button className="os-btn !py-1 text-[11px]" onClick={() => { vfs.write(`/swarm/${Date.now()}.md`, report(), { appId: "swarm" }); bus.emit("notify", { title: "Report saved to Files", kind: "success" }); }}>
                    Save
                  </button>
                  <button className="os-btn !py-1 text-[11px]" onClick={() => download(`swarm-${Date.now()}.md`, report(), "text/markdown")}>Export</button>
                </>
              )}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
            {synthesis && (
              <div className="os-card mb-3" style={{ borderColor: "var(--accent)" }}>
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="os-chip">Synthesis</span>
                  <div className="flex-1" />
                  <CopyButton text={synthesis} />
                </div>
                <Markdown text={synthesis} />
              </div>
            )}

            <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" }}>
              {active.map((agent) => {
                const r = runs[agent.id];
                return (
                  <div key={agent.id} className="os-card flex flex-col">
                    <div className="mb-1.5 flex items-center gap-2">
                      <span className="font-medium text-[13px]">{agent.name}</span>
                      <StatusDot status={r?.status ?? "idle"} />
                      <div className="flex-1" />
                      {r?.ms !== undefined && <span className="text-[10px] text-[var(--muted)]">{(r.ms / 1000).toFixed(1)}s</span>}
                      {r?.output && <CopyButton text={r.output} label="Copy" className="!px-1.5 !py-0 !text-[10px]" />}
                    </div>
                    <div className="mb-2 text-[10.5px] leading-snug text-[var(--muted)]">{agent.role}</div>
                    {r?.error && <div className="text-[11px] text-[var(--danger)]">{r.error}</div>}
                    {r?.output ? (
                      <div className="max-h-80 overflow-y-auto"><Markdown text={r.output} /></div>
                    ) : (
                      !r?.error && <div className="py-4 text-center text-[11px] text-[var(--muted)]">{r?.status === "running" ? "Working…" : "Waiting"}</div>
                    )}
                  </div>
                );
              })}
            </div>

            {!Object.keys(runs).length && (
              <div className="py-10 text-center text-[var(--muted)]">
                Pick a formation, ask a question, launch. Each agent answers independently; the synthesis pass reconciles them.
              </div>
            )}
          </div>
        </div>
      )}

      {tab === "agents" && (
        <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
          <div className="mb-2 flex gap-1.5">
            <button
              className="os-btn !py-1 text-[11px]"
              onClick={() => setAgents((a) => [...a, { id: uid("ag"), name: `Agent ${a.length + 1}`, role: "Answer the question.", enabled: true }])}
            >
              + Add agent
            </button>
            <button className="os-btn !py-1 text-[11px]" onClick={() => setAgents((a) => a.map((x) => ({ ...x, enabled: true })))}>Enable all</button>
            <button className="os-btn !py-1 text-[11px]" onClick={() => setAgents((a) => a.map((x) => ({ ...x, enabled: false })))}>Disable all</button>
          </div>
          {agents.map((agent) => (
            <div key={agent.id} className="os-card mb-2">
              <div className="mb-1.5 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={agent.enabled}
                  onChange={(e) => setAgents((a) => a.map((x) => (x.id === agent.id ? { ...x, enabled: e.target.checked } : x)))}
                  className="accent-[var(--accent)]"
                />
                <input
                  value={agent.name}
                  onChange={(e) => setAgents((a) => a.map((x) => (x.id === agent.id ? { ...x, name: e.target.value } : x)))}
                  className="os-input !w-44 !py-1 text-[12px] font-medium"
                />
                <select
                  className="os-input !w-auto !py-1 text-[11px]"
                  value={agent.provider ?? ""}
                  onChange={(e) => setAgents((a) => a.map((x) => (x.id === agent.id ? { ...x, provider: e.target.value || undefined } : x)))}
                  title="Override provider for this agent"
                >
                  <option value="">default provider</option>
                  {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <input
                  className="os-input !w-40 !py-1 text-[11px]"
                  placeholder="model override"
                  value={agent.model ?? ""}
                  onChange={(e) => setAgents((a) => a.map((x) => (x.id === agent.id ? { ...x, model: e.target.value || undefined } : x)))}
                  list={`models-${agent.id}`}
                />
                <datalist id={`models-${agent.id}`}>
                  {(getProvider(agent.provider ?? settings.ai.provider)?.models ?? []).map((m) => <option key={m} value={m} />)}
                </datalist>
                <div className="flex-1" />
                <button className="os-btn !px-2 !py-0.5 text-[11px]" onClick={() => setAgents((a) => a.filter((x) => x.id !== agent.id))}><Icon name="close" size={11} /></button>
              </div>
              <textarea
                value={agent.role}
                onChange={(e) => setAgents((a) => a.map((x) => (x.id === agent.id ? { ...x, role: e.target.value } : x)))}
                rows={2}
                className="os-input resize-none text-[12px]"
                placeholder="What this agent is briefed to do…"
              />
            </div>
          ))}
        </div>
      )}

      {tab === "settings" && (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="max-w-md">
            <Slider label="Concurrent agents" value={concurrency} min={1} max={8} onChange={setConcurrency} />
            <div className="mb-4 text-[11px] text-[var(--muted)]">
              Higher is faster but more likely to hit provider rate limits. Three is a safe default for most keys.
            </div>
            <Slider label="Max tokens per agent" value={maxTokensPerAgent} min={300} max={4000} step={100} onChange={setMaxTokensPerAgent} />
            <Toggle
              label="Run synthesis pass"
              checked={doSynthesis}
              onChange={setDoSynthesis}
              hint="One extra call that reconciles the agents instead of leaving you to read N answers."
            />
            <div className="os-card mt-4">
              <div className="os-label mb-1.5">Budget</div>
              <div className="mb-2 text-[12px]">
                Spent ${settings.ai.spentUsd.toFixed(4)} of ${settings.ai.budgetUsd.toFixed(2)}
              </div>
              <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.min(100, (settings.ai.spentUsd / Math.max(0.0001, settings.ai.budgetUsd)) * 100)}%`,
                    background: settings.ai.spentUsd / Math.max(0.0001, settings.ai.budgetUsd) > 0.85 ? "var(--danger)" : "var(--accent)",
                  }}
                />
              </div>
              <div className="text-[11px] text-[var(--muted)]">
                The swarm stops launching new agents when this is reached. Adjust it in Settings → AI.
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: AgentRun["status"] }) {
  const map: Record<AgentRun["status"], { color: string; label: string }> = {
    idle: { color: "var(--muted)", label: "waiting" },
    running: { color: "var(--accent)", label: "running" },
    done: { color: "var(--ok)", label: "done" },
    error: { color: "var(--danger)", label: "error" },
    skipped: { color: "var(--warn)", label: "skipped" },
  };
  const s = map[status];
  return (
    <span className="inline-flex items-center gap-1 text-[10px]" style={{ color: s.color }} title={s.label}>
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ background: s.color, animation: status === "running" ? "os-pulse 1.1s ease-in-out infinite" : undefined }}
      />
      {s.label}
    </span>
  );
}
