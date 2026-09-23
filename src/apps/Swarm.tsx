"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useSettings } from "@/kernel/settings";
import { useVFS } from "@/kernel/vfs";
import { bus } from "@/kernel/bus";
import { ask } from "@/lib/useAI";
import { PROVIDERS } from "@/lib/providers";
import { useModelCatalog, modelsFor } from "@/kernel/modelcatalog";
import type { AppProps } from "@/kernel/types";
import { uid, download } from "@/lib/format";
import { Markdown, CopyButton, ErrorNote, Tabs, Slider, Toggle } from "./_ui";
import {
  swarmDod, judgeSwarm, validateSwarmDod, profilesForFormation, bidRequestFor, rankAgents,
  type SwarmSnapshot,
} from "@/lib/harness/swarm";
import {
  planWaves, resolveModel, modelSpread, upstreamBlock, routerPrompt, parseRouterPlan,
  applyRouterPlan, clampTokens, MAX_TOKENS_CEILING, MIN_TOKENS, DEFAULT_MAX_TOKENS,
  type AgentSpec, type UpstreamOutput,
} from "@/lib/swarm-plan";
import { useHarness } from "@/kernel/harness";
import type { Award, DodVerdict } from "@/lib/harness/types";
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
  /** Per-agent output ceiling. Undefined inherits the swarm's. */
  maxTokens?: number;
  /** Agent ids whose output this one needs first. Empty means it starts in
   *  the first wave, which is the old flat-swarm behaviour. */
  dependsOn: string[];
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
  /** Dependencies are declared by NAME here and resolved to ids when the
   *  formation loads, because ids are minted per load and a literal id in a
   *  constant would dangle the moment you switched formations. */
  agents: Array<Omit<Agent, "id" | "enabled" | "dependsOn"> & { after?: string[] }>;
}

export const FORMATIONS: Formation[] = [
  {
    id: "redblue",
    name: "Red / Blue",
    description: "One agent argues for, one against, a third judges the exchange.",
    agents: [
      { name: "Red Team", role: "Argue the strongest case AGAINST the proposition. Give concrete failure modes, not vague doubt. Cite the specific mechanism by which it fails." },
      { name: "Blue Team", role: "Argue the strongest case FOR the proposition. Give concrete mechanisms and evidence, not enthusiasm." },
      { name: "Challenger", role: "Attack the weakest assumption on BOTH sides. Name the assumption explicitly before attacking it.", after: ["Red Team", "Blue Team"] },
    ],
  },
  {
    id: "pipeline",
    name: "Pipeline",
    description: "Each stage waits for the one before it. Research, then design, then build, then review.",
    agents: [
      { name: "Researcher", role: "Gather the facts, constraints and prior art that bear on this. Mark anything you are unsure of." },
      { name: "Designer", role: "Propose the design. Name the boundaries and the one decision that is hardest to reverse later.", after: ["Researcher"] },
      { name: "Builder", role: "Write the actual implementation or the precise steps. Working detail, not a description of detail.", after: ["Designer"] },
      { name: "Reviewer", role: "Review what was built against what was designed. Name every place they diverge.", after: ["Builder"] },
    ],
  },
  {
    id: "tournament",
    name: "Tournament",
    description: "Three independent attempts, then a judge that never saw them being made.",
    agents: [
      { name: "Attempt A", role: "Answer the question completely, in your own way. Do not hedge." },
      { name: "Attempt B", role: "Answer the question completely, taking a deliberately different approach from the obvious one." },
      { name: "Attempt C", role: "Answer the question completely, optimising for being correct rather than for being interesting." },
      { name: "Judge", role: "Pick the best of the three attempts and say precisely why the others lose. Do not blend them.", after: ["Attempt A", "Attempt B", "Attempt C"] },
    ],
  },
  {
    id: "devils",
    name: "Steelman / Teardown",
    description: "Build the strongest case, then have someone try to destroy it.",
    agents: [
      { name: "Steelman", role: "Build the strongest possible version of the proposal, including the arguments its own supporters usually miss." },
      { name: "Teardown", role: "Destroy the steelman above. Find the load-bearing assumption and remove it.", after: ["Steelman"] },
      { name: "Adjudicator", role: "Say what survived the teardown and what did not. Be specific about which claims are still standing.", after: ["Teardown"] },
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

/**
 * The shape of the run, before it runs.
 *
 * Shown always, not only on failure. The two things worth seeing up front are
 * how many round trips deep the plan is — a four-wave swarm is four sequential
 * model calls however much concurrency you give it — and how many distinct
 * models are in play, so "they are all on the same one" is a fact you can read
 * rather than an assumption.
 */
function PlanBar({
  agents, defaults, waves, activeWave,
}: {
  agents: Agent[];
  defaults: { provider: string; model: string; maxTokens: number; temperature: number };
  waves: string[][];
  activeWave: number;
}) {
  const planned = planWaves(agents as unknown as AgentSpec[]);
  const spread = modelSpread(agents as unknown as AgentSpec[], defaults);
  const shown = waves.length > 0 ? waves : planned.ok ? planned.waves : [];

  return (
    <div className="mb-2.5 flex flex-wrap items-center gap-1.5 text-[10.5px]">
      {!planned.ok ? (
        <span className="os-chip !px-1.5 !py-0 !text-[10px]" style={{ color: "var(--danger)" }}>
          <Icon name="warning" size={10} className="mr-1" />{planned.reason}
        </span>
      ) : (
        <>
          <span className="os-chip !px-1.5 !py-0 !text-[10px]" title="Agents in a later wave wait for the one before them.">
            {shown.length} wave{shown.length === 1 ? "" : "s"}
          </span>
          {shown.map((w, i) => (
            <span
              key={i}
              className="os-chip !px-1.5 !py-0 !text-[10px]"
              style={i < activeWave ? { color: "var(--ok)" } : undefined}
            >
              {i + 1}: {w.length} parallel
            </span>
          ))}
          <span
            className="os-chip !px-1.5 !py-0 !text-[10px]"
            title={spread.join(", ")}
          >
            {spread.length === 1 ? `one model: ${spread[0]}` : `${spread.length} models`}
          </span>
        </>
      )}
    </div>
  );
}

/** Turn a formation into a live roster, resolving `after` names into the ids
 *  minted for this load. A name that matches nothing is dropped rather than
 *  carried through as a dangling dependency — `planWaves` would refuse the
 *  whole roster for it, which is a lot of collateral for a typo in a constant. */
function materialise(f: Formation): Agent[] {
  const withIds = f.agents.map((a) => ({ ...a, id: uid("ag"), enabled: true }));
  const idByName = new Map(withIds.map((a) => [a.name, a.id]));
  return withIds.map(({ after, ...rest }) => ({
    ...rest,
    dependsOn: (after ?? []).map((n) => idByName.get(n)).filter((x): x is string => Boolean(x)),
  }));
}

export default function Swarm({}: AppProps) {
  const settings = useSettings();
  // Refreshed model lists (Settings / the picker), else the built-in catalogue.
  const modelLists = useModelCatalog((s) => s.lists);
  const vfs = useVFS();
  const [tab, setTab] = useState("run");
  const [question, setQuestion] = useState("");
  const [formationId, setFormationId] = useState("redblue");
  const [agents, setAgents] = useState<Agent[]>(() => materialise(FORMATIONS[0]));
  const [runs, setRuns] = useState<Record<string, AgentRun>>({});
  const [synthesis, setSynthesis] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [concurrency, setConcurrency] = useState(3);
  const [doSynthesis, setDoSynthesis] = useState(true);
  const [maxTokensPerAgent, setMaxTokensPerAgent] = useState(DEFAULT_MAX_TOKENS);
  const [routing, setRouting] = useState(false);
  const [routeNote, setRouteNote] = useState<string | null>(null);
  const [waves, setWaves] = useState<string[][]>([]);
  const [activeWave, setActiveWave] = useState(0);
  // A swarm must ALWAYS have a definition of done. `verdict` is what makes a
  // run able to fail; before this, every swarm "succeeded" because nothing was
  // ever asked to fail.
  const [verdict, setVerdict] = useState<DodVerdict | null>(null);
  const [award, setAward] = useState<Award | null>(null);
  const [useBidding, setUseBidding] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const loadFormation = useCallback((id: string) => {
    const f = FORMATIONS.find((x) => x.id === id);
    if (!f) return;
    setFormationId(id);
    setAgents(materialise(f));
    setRuns({});
    setSynthesis("");
    setVerdict(null);
    setAward(null);
  }, []);

  const totalCost = useMemo(() => Object.values(runs).reduce((a, r) => a + (r.costUsd ?? 0), 0), [runs]);
  const active = agents.filter((a) => a.enabled);

  const launch = useCallback(async () => {
    if (!question.trim() || busy) return;
    if (!active.length) { setError("Enable at least one agent."); return; }

    // The floor every swarm is held to. Built before anything runs, and
    // refused if it could not fail — a definition of done that passes
    // everything is worse than none, because it manufactures confidence.
    const dod = swarmDod({ owner: "the operator", minAgents: Math.min(2, active.length) });
    const dodCheck = validateSwarmDod(dod);
    if (!dodCheck.ok) {
      setError(`This swarm has no usable definition of done: ${dodCheck.reasons.join(" ")}`);
      return;
    }

    setError(null);
    setBusy(true);
    setSynthesis("");
    setVerdict(null);
    setAward(null);
    setRuns(Object.fromEntries(active.map((a) => [a.id, { agentId: a.id, status: "idle" as const, output: "" }])));
    setWaves([]);
    setActiveWave(0);

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const startedAt = Date.now();
    let finalSynthesis = "";
    // A plain local map rather than a ref: `runs` state is async and the
    // snapshot below must see what actually happened, not what React has
    // committed by then.
    const ledger = new Map<string, { status: AgentRun["status"]; output: string; costUsd: number; ms: number }>();
    for (const a of active) ledger.set(a.id, { status: "idle", output: "", costUsd: 0, ms: 0 });

    // Who runs, decided from measured history rather than from whoever happens
    // to be on the list. Off by default: with no run history the ranking is
    // priors only, and a ranking with no evidence behind it should not quietly
    // start excluding agents the user enabled.
    const budgetLeft = settings.ai.budgetUsd > 0 ? Math.max(0, settings.ai.budgetUsd - settings.ai.spentUsd) : 0;
    let roster = active;
    if (useBidding) {
      const profiles = profilesForFormation(formationId, active);
      const req = bidRequestFor({
        question, formationId, dodId: dod.id,
        maxCostUsd: budgetLeft,
        deadlineMs: 120_000,
      });
      const ranked = rankAgents(profiles, req);
      setAward(ranked.award);
      const allowed = new Set(ranked.withinBudget);
      roster = active.filter((a) => allowed.has(a.id));
      for (const a of active) {
        if (!allowed.has(a.id)) {
          setRuns((r) => ({ ...r, [a.id]: { agentId: a.id, status: "skipped", output: "", error: "Not awarded by the bidding pass" } }));
          ledger.set(a.id, { status: "skipped", output: "", costUsd: 0, ms: 0 });
        }
      }
    }

    const results: Array<{ agent: Agent; text: string }> = [];
    let stoppedForBudget = false;

    // Waves, not one flat pool. Everything inside a wave runs concurrently;
    // the next wave starts when the one before it finishes, which is what
    // lets an agent read another agent's work. A roster where nothing depends
    // on anything produces exactly one wave — the old behaviour, unchanged.
    const planned = planWaves(roster as unknown as AgentSpec[]);
    if (!planned.ok) {
      setError(planned.reason);
      setBusy(false);
      abortRef.current = null;
      return;
    }
    setWaves(planned.waves);

    const defaults = {
      provider: settings.ai.provider,
      model: settings.ai.model,
      maxTokens: maxTokensPerAgent,
      temperature: 0.7,
    };
    const byId = new Map(roster.map((a) => [a.id, a]));
    const upstream: UpstreamOutput[] = [];

    const runOne = async (agent: Agent) => {
      if (ctrl.signal.aborted) return;
      const s = useSettings.getState();
      if (s.ai.budgetUsd > 0 && s.ai.spentUsd >= s.ai.budgetUsd) {
        stoppedForBudget = true;
        setRuns((r) => ({ ...r, [agent.id]: { agentId: agent.id, status: "skipped", output: "", error: "Budget reached" } }));
        ledger.set(agent.id, { status: "skipped", output: "", costUsd: 0, ms: 0 });
        return;
      }

      const resolved = resolveModel(agent as unknown as AgentSpec, defaults);
      setRuns((r) => ({ ...r, [agent.id]: { agentId: agent.id, status: "running", output: "" } }));

      // Only what this agent declared it needs. Handing every downstream agent
      // every upstream output is expensive and converges the panel on one
      // voice, which is the thing a panel exists to avoid.
      const inherited = upstreamBlock(agent as unknown as AgentSpec, upstream);

      try {
        const res = await ask({
          messages: [{ role: "user", content: inherited ? `${question}\n\n${inherited}` : question }],
          system:
            `You are "${agent.name}", one agent in a panel answering the same question.\n\n` +
            `Your brief: ${agent.role}\n\n` +
            (inherited
              ? "Agents before you have already worked on this and their output is in the message. Advance it."
              : "Stay in your lane — another agent covers the other angles.") +
            " Be substantive; you have a real token budget, so use it if the question deserves it.",
          provider: resolved.provider,
          model: resolved.model,
          maxTokens: resolved.maxTokens,
          temperature: resolved.temperature,
          signal: ctrl.signal,
          onDelta: (_d, full) =>
            setRuns((r) => ({ ...r, [agent.id]: { ...r[agent.id], agentId: agent.id, status: "running", output: full } })),
        });
        results.push({ agent, text: res.text });
        upstream.push({ agentId: agent.id, agentName: agent.name, role: agent.role, text: res.text });
        setRuns((r) => ({ ...r, [agent.id]: { agentId: agent.id, status: "done", output: res.text, ms: res.ms, costUsd: res.costUsd } }));
        ledger.set(agent.id, { status: "done", output: res.text, costUsd: res.costUsd, ms: res.ms });
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        const msg = e instanceof Error ? e.message : "Agent failed.";
        setRuns((r) => ({ ...r, [agent.id]: { agentId: agent.id, status: "error", output: "", error: msg } }));
        // The message is carried as output so the DoD can tell a failure that
        // explained itself from one that left a hole in the record.
        ledger.set(agent.id, { status: "error", output: msg, costUsd: 0, ms: 0 });
      }
    };

    /** One wave, with the concurrency limit still applied inside it. An
     *  unbounded Promise.all over a wide wave is how a swarm turns into a
     *  rate-limit wall and a bill nobody approved. */
    const runWave = async (ids: string[]) => {
      const queue = ids.map((id) => byId.get(id)).filter((a): a is Agent => Boolean(a));
      const workers = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, async () => {
        for (;;) {
          const agent = queue.shift();
          if (!agent || ctrl.signal.aborted) return;
          await runOne(agent);
        }
      });
      await Promise.all(workers);
    };

    try {
      for (const wave of planned.waves) {
        if (ctrl.signal.aborted) break;
        setActiveWave((w) => w + 1);
        await runWave(wave);
      }

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
        finalSynthesis = res.text;
      }

      // Judged by code, from the outcomes. The synthesis pass and the judge
      // would otherwise be the same model grading its own work, which is the
      // verifier problem in its purest form.
      const snapshot: SwarmSnapshot = {
        question,
        formationId,
        outcomes: active.map((a) => {
          const r = ledger.get(a.id);
          return {
            agentId: a.id,
            agentName: a.name,
            status: r?.status ?? "idle",
            output: r?.output ?? "",
            costUsd: r?.costUsd ?? 0,
            ms: r?.ms ?? 0,
          };
        }),
        synthesis: finalSynthesis,
        startedAt,
        endedAt: Date.now(),
      };
      const judged = judgeSwarm(snapshot, dod, uid("swarm"));
      setVerdict(judged.verdict);
      // The run joins the same ledger a harness run does, so a swarm that
      // failed its floor is visible next to every other run rather than only
      // in this window until it closes.
      useHarness.getState().record(judged.run, "");

      bus.emit("notify", {
        title: judged.verdict.pass ? "Swarm met its definition of done" : "Swarm did NOT meet its definition of done",
        body: judged.verdict.reason.slice(0, 160),
        kind: judged.verdict.pass ? "success" : "warning",
      });
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError(e instanceof Error ? e.message : "Swarm failed.");
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [question, busy, active, concurrency, doSynthesis, maxTokensPerAgent, formationId, useBidding, settings.ai.provider, settings.ai.model, settings.ai.budgetUsd, settings.ai.spentUsd]);

  /**
   * Ask a small model to assign the roster: which model each agent runs on,
   * and which agents must wait for which others.
   *
   * It proposes; it does not decide. `parseRouterPlan` validates every field
   * against what actually exists and `applyRouterPlan` refuses the whole plan
   * if it would not run — so a bad suggestion costs a call and nothing else,
   * and the roster you had is still there.
   */
  const route = useCallback(async () => {
    if (!question.trim() || routing) return;
    setRouting(true);
    setRouteNote(null);
    try {
      const catalogue = PROVIDERS.flatMap((p) =>
        (p.models ?? []).map((m) => ({ provider: p.id, model: m, note: p.name })),
      );
      const res = await ask({
        messages: [{ role: "user", content: routerPrompt(question, agents as unknown as AgentSpec[], catalogue) }],
        system: "You return JSON and nothing else.",
        maxTokens: 2000,
        temperature: 0,
        persona: false,
      });
      const plan = parseRouterPlan(res.text, agents as unknown as AgentSpec[], catalogue);
      const applied = applyRouterPlan(agents as unknown as AgentSpec[], plan);
      if (!applied.ok) {
        setRouteNote(applied.reason);
        return;
      }
      setAgents(applied.agents as unknown as Agent[]);
      const dropped = plan.rejected.length > 0 ? ` ${plan.rejected.length} suggestion(s) were rejected: ${plan.rejected.map((r) => `${r.value} (${r.reason})`).join("; ")}.` : "";
      setRouteNote(`Router assigned ${applied.changed} of ${agents.length} agents.${dropped}`);
    } catch (e) {
      setRouteNote(e instanceof Error ? e.message : "The router call failed.");
    } finally {
      setRouting(false);
    }
  }, [question, routing, agents]);

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
              <button
                className="os-btn !py-1 text-[11px]"
                onClick={() => void route()}
                disabled={routing || !question.trim() || busy}
                title="Ask a model to assign each agent a model and work out which must wait for which."
              >
                <Icon name="network" size={11} className="mr-1" />{routing ? "Routing…" : "Auto-route"}
              </button>
              <button
                onClick={() => setUseBidding((v) => !v)}
                title="Rank agents by measured pass rate and mean cost before running, and drop the ones the budget cannot cover."
                className={cn("os-btn !py-1 text-[11px]", useBidding && "!border-[var(--accent)] !bg-[var(--accent)]/16")}
              >
                Bidding {useBidding ? "on" : "off"}
              </button>
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
            {routeNote && (
              <p className="mb-2 text-[11px] leading-snug text-[var(--muted)]">{routeNote}</p>
            )}
            <PlanBar agents={agents} defaults={{ provider: settings.ai.provider, model: settings.ai.model, maxTokens: maxTokensPerAgent, temperature: 0.7 }} activeWave={activeWave} waves={waves} />
            {verdict && (
              <div
                className="os-card mb-3"
                style={{ borderColor: verdict.pass ? "var(--accent)" : "var(--danger)" }}
              >
                <div className="mb-1.5 flex flex-wrap items-center gap-2">
                  <span className="os-chip" style={{ color: verdict.pass ? "var(--accent)" : "var(--danger)" }}>
                    <Icon name={verdict.pass ? "check" : "warning"} className="h-3.5 w-3.5" />
                    {verdict.pass ? "Met its definition of done" : "Did NOT meet its definition of done"}
                  </span>
                  <span className="os-chip">score {(verdict.score * 100).toFixed(0)}%</span>
                  <div className="flex-1" />
                  <CopyButton text={verdict.reason} label="Copy verdict" className="!px-1.5 !py-0 !text-[10px]" />
                </div>
                <p className="mb-2 text-[11px] leading-relaxed text-[var(--muted)]">{verdict.reason}</p>
                <ul className="space-y-1">
                  {verdict.outcomes.map((o) => (
                    <li key={o.criterionId} className="flex items-start gap-2 text-[11px]">
                      <Icon
                        name={o.met === true ? "check" : o.met === false ? "close" : "half"}
                        className="mt-0.5 h-3.5 w-3.5 shrink-0"
                        style={{ color: o.met === true ? "var(--accent)" : o.met === false ? "var(--danger)" : "var(--muted)" }}
                      />
                      <span className="min-w-0">
                        <span className="font-medium">{o.criterionId}</span>
                        <span className="ml-1.5 text-[var(--muted)]">{o.observed}</span>
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[10px] leading-snug text-[var(--muted)]">
                  Judged by code against fixed criteria, never by a model. A synthesis pass grading its own
                  synthesis agrees with itself, and that looks exactly like success.
                </p>
              </div>
            )}

            {award && (
              <details className="os-card mb-3">
                <summary className="cursor-pointer text-[12px] font-medium">
                  Bidding pass — {award.winner ? `${award.winner.agentId} led` : "no winner"}, {award.abstained.length} abstained
                </summary>
                <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--muted)]">{award.reason}</p>
                <ul className="mt-1.5 space-y-0.5">
                  {[...(award.winner ? [award.winner] : []), ...award.runnersUp, ...award.abstained].map((b) => (
                    <li key={b.agentId} className="text-[10.5px] text-[var(--muted)]">
                      <span className="font-medium text-[var(--fg)]">{b.agentId}</span>
                      {" — "}
                      {b.abstainReason ? `abstained: ${b.abstainReason}` : b.rationale}
                    </li>
                  ))}
                </ul>
              </details>
            )}

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
              onClick={() => setAgents((a) => [...a, { id: uid("ag"), name: `Agent ${a.length + 1}`, role: "Answer the question.", dependsOn: [], enabled: true }])}
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
                  {modelsFor(agent.provider ?? settings.ai.provider, modelLists).map((m) => <option key={m.id} value={m.id} />)}
                </datalist>
                <input
                  className="os-input !w-24 !py-1 text-[11px]"
                  type="number"
                  min={MIN_TOKENS}
                  max={MAX_TOKENS_CEILING}
                  step={256}
                  placeholder="tokens"
                  title="Output ceiling for this agent. Blank inherits the swarm default."
                  value={agent.maxTokens ?? ""}
                  onChange={(e) => setAgents((a) => a.map((x) => (x.id === agent.id
                    ? { ...x, maxTokens: e.target.value ? clampTokens(Number(e.target.value)) : undefined }
                    : x)))}
                />
                <div className="flex-1" />
                <button className="os-btn !px-2 !py-0.5 text-[11px]" onClick={() => setAgents((a) => a.filter((x) => x.id !== agent.id))}><Icon name="close" size={11} /></button>
              </div>
              <div className="mb-1.5 flex flex-wrap items-center gap-1">
                <span className="os-label !mb-0 mr-1">Waits for</span>
                {agents.filter((x) => x.id !== agent.id).length === 0 && (
                  <span className="text-[10.5px] text-[var(--muted)]">nothing else to wait for</span>
                )}
                {agents.filter((x) => x.id !== agent.id).map((other) => {
                  const on = agent.dependsOn.includes(other.id);
                  return (
                    <button
                      key={other.id}
                      className={cn("os-chip !px-1.5 !py-0 !text-[10px]", on && "!border-[var(--accent)] !text-[var(--accent)]")}
                      title={on ? `Runs after ${other.name}, and is shown its output` : `Click to run after ${other.name}`}
                      onClick={() => setAgents((a) => a.map((x) => (x.id === agent.id
                        ? { ...x, dependsOn: on ? x.dependsOn.filter((d) => d !== other.id) : [...x.dependsOn, other.id] }
                        : x)))}
                    >
                      {other.name}
                    </button>
                  );
                })}
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
            {/* The value AND the ceiling. Showing the value alone is why the
                old 4,000 bound was indistinguishable from the new 64,000 one:
                the number beside the label never was the maximum. */}
            <Slider
              label="Max tokens per agent"
              value={maxTokensPerAgent}
              min={MIN_TOKENS}
              max={MAX_TOKENS_CEILING}
              step={256}
              onChange={setMaxTokensPerAgent}
              format={(v) => `${v.toLocaleString("en-US")} of ${MAX_TOKENS_CEILING.toLocaleString("en-US")} max`}
            />
            <div className="mb-2 flex flex-wrap gap-1">
              {/* Explicit labels, not arithmetic. Dividing by 1024 against a
                  decimal ceiling rendered the top chip as "63k". */}
              {([[1024, "1k"], [4096, "4k"], [16384, "16k"], [32768, "32k"], [MAX_TOKENS_CEILING, "64k"]] as const).map(([n, label]) => (
                <button
                  key={n}
                  onClick={() => setMaxTokensPerAgent(n)}
                  className={cn("os-chip !px-1.5 !py-0 !text-[10px]", maxTokensPerAgent === n && "!border-[var(--accent)] !text-[var(--accent)]")}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="mb-3 text-[11px] leading-snug text-[var(--muted)]">
              The swarm-wide default. An agent that names its own ceiling overrides it. Providers clamp their own
              limits below this, so asking for more than a model supports costs nothing extra — but a long answer
              does, on every agent at once.
            </p>
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
