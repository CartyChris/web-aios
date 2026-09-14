"use client";

import { useCallback, useMemo, useState } from "react";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { useVFS } from "@/kernel/vfs";
import { bus } from "@/kernel/bus";
import { ask } from "@/lib/useAI";
import type { AppProps } from "@/kernel/types";
import { uid, download } from "@/lib/format";
import { Markdown, CopyButton, ErrorNote, Tabs, Empty, Spinner } from "./_ui";
import { cn } from "@/lib/cn";
import { Icon } from "@/shell/icons";

/* ────────────────────────────────────────────────────────────────────────────
   Deep Work — ported from DeepseekHarnessMobile and the Arcwright gate model.

   The premise both originals share: a plan is worthless unless each stage has a
   check that can fail. So a stage here cannot be marked verified by assertion —
   it carries gates, and a gate holds an expectation that either matched or did
   not. Editing a stage invalidates everything downstream, because a fix at
   stage 2 makes stage 7's "verified" a lie.
   ──────────────────────────────────────────────────────────────────────────── */

export type StageStatus = "pending" | "active" | "ready" | "verified" | "blocked" | "invalidated";

export interface Gate {
  id: string;
  label: string;
  /** What the user expects to observe. A gate with no expectation is a wish. */
  expectation: string;
  observed: string;
  met: boolean | null;
}

export interface Stage {
  id: string;
  title: string;
  intent: string;
  output: string;
  gates: Gate[];
  status: StageStatus;
  updatedAt: number;
}

export interface Plan {
  id: string;
  goal: string;
  stages: Stage[];
  createdAt: number;
  updatedAt: number;
}

interface DeepWorkState {
  plans: Plan[];
  activeId: string | null;
  newPlan: (goal: string) => string;
  removePlan: (id: string) => void;
  setActive: (id: string) => void;
  setStages: (planId: string, stages: Stage[]) => void;
  patchStage: (planId: string, stageId: string, patch: Partial<Stage>) => void;
  addStage: (planId: string) => void;
  removeStage: (planId: string, stageId: string) => void;
  addGate: (planId: string, stageId: string) => void;
  patchGate: (planId: string, stageId: string, gateId: string, patch: Partial<Gate>) => void;
  removeGate: (planId: string, stageId: string, gateId: string) => void;
  invalidateFrom: (planId: string, stageId: string) => void;
}

export const useDeepWork = create<DeepWorkState>()(
  persist(
    (set) => ({
      plans: [],
      activeId: null,

      newPlan: (goal) => {
        const id = uid("plan");
        set((s) => ({
          plans: [{ id, goal, stages: [], createdAt: Date.now(), updatedAt: Date.now() }, ...s.plans],
          activeId: id,
        }));
        return id;
      },

      removePlan: (id) =>
        set((s) => {
          const plans = s.plans.filter((p) => p.id !== id);
          return { plans, activeId: s.activeId === id ? plans[0]?.id ?? null : s.activeId };
        }),

      setActive: (id) => set({ activeId: id }),

      setStages: (planId, stages) =>
        set((s) => ({ plans: s.plans.map((p) => (p.id === planId ? { ...p, stages, updatedAt: Date.now() } : p)) })),

      patchStage: (planId, stageId, patch) =>
        set((s) => ({
          plans: s.plans.map((p) =>
            p.id !== planId ? p : { ...p, updatedAt: Date.now(), stages: p.stages.map((st) => (st.id === stageId ? { ...st, ...patch, updatedAt: Date.now() } : st)) },
          ),
        })),

      addStage: (planId) =>
        set((s) => ({
          plans: s.plans.map((p) =>
            p.id !== planId ? p : {
              ...p, updatedAt: Date.now(),
              stages: [...p.stages, { id: uid("st"), title: `Stage ${p.stages.length + 1}`, intent: "", output: "", gates: [], status: "pending" as StageStatus, updatedAt: Date.now() }],
            },
          ),
        })),

      removeStage: (planId, stageId) =>
        set((s) => ({ plans: s.plans.map((p) => (p.id !== planId ? p : { ...p, stages: p.stages.filter((st) => st.id !== stageId) })) })),

      addGate: (planId, stageId) =>
        set((s) => ({
          plans: s.plans.map((p) =>
            p.id !== planId ? p : {
              ...p,
              stages: p.stages.map((st) =>
                st.id !== stageId ? st : { ...st, gates: [...st.gates, { id: uid("g"), label: "New gate", expectation: "", observed: "", met: null }] },
              ),
            },
          ),
        })),

      patchGate: (planId, stageId, gateId, patch) =>
        set((s) => ({
          plans: s.plans.map((p) =>
            p.id !== planId ? p : {
              ...p,
              stages: p.stages.map((st) =>
                st.id !== stageId ? st : { ...st, gates: st.gates.map((g) => (g.id === gateId ? { ...g, ...patch } : g)) },
              ),
            },
          ),
        })),

      removeGate: (planId, stageId, gateId) =>
        set((s) => ({
          plans: s.plans.map((p) =>
            p.id !== planId ? p : { ...p, stages: p.stages.map((st) => (st.id !== stageId ? st : { ...st, gates: st.gates.filter((g) => g.id !== gateId) })) },
          ),
        })),

      // Editing an early stage cannot leave later "verified" badges standing.
      invalidateFrom: (planId, stageId) =>
        set((s) => ({
          plans: s.plans.map((p) => {
            if (p.id !== planId) return p;
            const idx = p.stages.findIndex((st) => st.id === stageId);
            if (idx === -1) return p;
            return {
              ...p,
              stages: p.stages.map((st, i) =>
                i > idx && (st.status === "verified" || st.status === "ready") ? { ...st, status: "invalidated" as StageStatus } : st,
              ),
            };
          }),
        })),
    }),
    { name: "webaios.deepwork.v1", storage: createJSONStorage(() => localStorage) },
  ),
);

const PLAN_PROMPT = `You produce stage plans for complex work.

Return ONLY a JSON array. Each element:
{"title": "<short stage name>", "intent": "<what this stage produces>", "gates": [{"label": "<gate name>", "expectation": "<the observable result that proves this stage is done>"}]}

Rules:
- Between 3 and 8 stages. Each stage must produce ONE verifiable artifact.
- If a stage produces nothing checkable, merge it into the next one.
- Every gate expectation must be something a person could observe and could fail. "Reviewed and looks right" is not a gate. "tests pass with exit code 0" is.
- Order stages so an error at stage 2 is caught before stage 5 depends on it.
- Output nothing but the JSON array.`;

export default function DeepWork({}: AppProps) {
  const dw = useDeepWork();
  const vfs = useVFS();
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState("plan");

  const plan = dw.plans.find((p) => p.id === dw.activeId) ?? null;

  const generate = useCallback(async () => {
    const g = goal.trim();
    if (!g) return;
    setBusy("Planning…");
    setError(null);
    try {
      const res = await ask({ messages: [{ role: "user", content: g }], system: PLAN_PROMPT, maxTokens: 2200 });
      const parsed = extractArray(res.text);
      if (!parsed) throw new Error("The model did not return parseable JSON. Try again, or write the stages by hand.");
      const planId = dw.newPlan(g);
      dw.setStages(
        planId,
        parsed.map((raw, i) => ({
          id: uid("st"),
          title: String(raw.title ?? `Stage ${i + 1}`),
          intent: String(raw.intent ?? ""),
          output: "",
          status: (i === 0 ? "active" : "pending") as StageStatus,
          updatedAt: Date.now(),
          gates: (Array.isArray(raw.gates) ? raw.gates : []).map((gt) => ({
            id: uid("g"),
            label: String((gt as { label?: unknown }).label ?? "Gate"),
            expectation: String((gt as { expectation?: unknown }).expectation ?? ""),
            observed: "",
            met: null,
          })),
        })),
      );
      setGoal("");
      setTab("plan");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Planning failed.");
    } finally {
      setBusy(null);
    }
  }, [goal, dw]);

  const runStage = useCallback(
    async (stage: Stage) => {
      if (!plan) return;
      setBusy(`Working ${stage.title}…`);
      setError(null);
      dw.patchStage(plan.id, stage.id, { status: "active" });
      try {
        const prior = plan.stages
          .slice(0, plan.stages.findIndex((s) => s.id === stage.id))
          .filter((s) => s.output)
          .map((s) => `### ${s.title}\n${s.output}`)
          .join("\n\n");
        const gateText = stage.gates.map((g) => `- ${g.label}: ${g.expectation}`).join("\n");
        const res = await ask({
          messages: [{
            role: "user",
            content: `Overall goal: ${plan.goal}\n\n${prior ? `Completed stages:\n${prior}\n\n` : ""}Current stage: ${stage.title}\nIntent: ${stage.intent}\n\nThis stage must satisfy:\n${gateText || "(no gates defined)"}\n\nProduce the stage's output.`,
          }],
          system: "You execute one stage of a plan. Produce the actual artifact this stage calls for — not a description of it. At the end, state plainly for each gate whether the work satisfies it and what the observable evidence is. If a gate cannot be satisfied, say so rather than claiming success.",
          maxTokens: 2500,
          onDelta: (_d, full) => dw.patchStage(plan.id, stage.id, { output: full }),
        });
        dw.patchStage(plan.id, stage.id, { output: res.text, status: "ready" });
        dw.invalidateFrom(plan.id, stage.id);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Stage failed.");
        dw.patchStage(plan.id, stage.id, { status: "blocked" });
      } finally {
        setBusy(null);
      }
    },
    [plan, dw],
  );

  const exportMd = useCallback(() => {
    if (!plan) return "";
    const lines = [`# ${plan.goal}`, "", `> Deep Work plan · ${new Date().toISOString()}`, ""];
    for (const [i, st] of plan.stages.entries()) {
      lines.push(`## ${i + 1}. ${st.title}  \`${st.status}\``, "", st.intent ? `_${st.intent}_` : "", "");
      if (st.gates.length) {
        lines.push("| Gate | Expectation | Observed | Met |", "| --- | --- | --- | --- |");
        for (const g of st.gates) {
          lines.push(`| ${g.label} | ${g.expectation || "—"} | ${g.observed || "—"} | ${g.met === null ? "not checked" : g.met ? "yes" : "NO"} |`);
        }
        lines.push("");
      }
      if (st.output) lines.push(st.output, "");
    }
    const unverified = plan.stages.filter((s) => s.status !== "verified");
    if (unverified.length) {
      lines.push("## Not verified", "", ...unverified.map((s) => `- ${s.title} (${s.status})`), "");
    }
    return lines.join("\n");
  }, [plan]);

  const progress = useMemo(() => {
    if (!plan?.stages.length) return { verified: 0, total: 0, pct: 0 };
    const verified = plan.stages.filter((s) => s.status === "verified").length;
    return { verified, total: plan.stages.length, pct: Math.round((verified / plan.stages.length) * 100) };
  }, [plan]);

  return (
    <div className="app-split flex h-full">
      <div className="app-sidebar flex w-52 shrink-0 flex-col overflow-y-auto border-r border-[var(--border)]">
        <div className="p-2">
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="What are you trying to accomplish?"
            rows={3}
            className="os-input mb-1.5 resize-none text-[12px]"
          />
          <button className="os-btn w-full !py-1 text-[11px]" data-variant="primary" onClick={generate} disabled={!goal.trim() || !!busy}>
            {busy === "Planning…" ? "Planning…" : "Generate plan"}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
          {dw.plans.map((p) => (
            <div
              key={p.id}
              onClick={() => dw.setActive(p.id)}
              className={cn(
                "group mb-1 cursor-pointer rounded-[calc(var(--radius)*0.6)] px-2 py-1.5",
                p.id === dw.activeId ? "bg-[var(--accent)]/16 ring-1 ring-[var(--accent)]/40" : "hover:bg-white/6",
              )}
            >
              <div className="flex items-center gap-1">
                <span className="min-w-0 flex-1 truncate text-[12px]">{p.goal}</span>
                <button className="text-[10px] opacity-0 group-hover:opacity-60 hover:!opacity-100" onClick={(e) => { e.stopPropagation(); dw.removePlan(p.id); }}><Icon name="close" size={11} /></button>
              </div>
              <div className="text-[10px] text-[var(--muted)]">
                {p.stages.filter((s) => s.status === "verified").length}/{p.stages.length} verified
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {!plan ? (
          <Empty
            icon="deepwork"
            title="No plan open"
            body="Describe a goal on the left and generate a stage plan. Each stage carries gates that hold an expectation — a stage cannot be marked verified without one being checked."
          />
        ) : (
          <>
            <Tabs tabs={[{ id: "plan", label: "Stages", icon: "gate" }, { id: "report", label: "Report", icon: "report" }]} active={tab} onChange={setTab} />

            <div className="shrink-0 border-b border-[var(--border)] px-2.5 py-1.5">
              <ErrorNote error={error} onDismiss={() => setError(null)} />
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{plan.goal}</span>
                {busy && <Spinner label={busy} />}
                <span className="os-chip">{progress.verified}/{progress.total} verified</span>
                <button className="os-btn !py-1 text-[11px]" onClick={() => dw.addStage(plan.id)}>+ Stage</button>
                <button className="os-btn !py-1 text-[11px]" onClick={() => { vfs.write(`/deepwork/${plan.id}.md`, exportMd(), { appId: "deepwork" }); bus.emit("notify", { title: "Plan saved to Files", kind: "success" }); }}>Save</button>
                <button className="os-btn !py-1 text-[11px]" onClick={() => download(`plan-${plan.id}.md`, exportMd(), "text/markdown")}>Export</button>
              </div>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full transition-all" style={{ width: `${progress.pct}%`, background: "var(--ok)" }} />
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {tab === "plan" && (
                plan.stages.length === 0 ? (
                  <Empty icon="gate" title="No stages" body="Add one by hand, or delete this plan and generate a new one." />
                ) : (
                  plan.stages.map((stage, i) => (
                    <StageCard
                      key={stage.id}
                      index={i}
                      stage={stage}
                      planId={plan.id}
                      busy={!!busy}
                      onRun={() => runStage(stage)}
                    />
                  ))
                )
              )}
              {tab === "report" && (
                <div className="mx-auto max-w-3xl">
                  <div className="mb-2 flex justify-end"><CopyButton text={exportMd()} /></div>
                  <Markdown text={exportMd()} />
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function StageCard({ index, stage, planId, busy, onRun }: { index: number; stage: Stage; planId: string; busy: boolean; onRun: () => void }) {
  const dw = useDeepWork();
  const [open, setOpen] = useState(index === 0);
  const gatesChecked = stage.gates.filter((g) => g.met !== null).length;
  const gatesMet = stage.gates.filter((g) => g.met === true).length;
  const canVerify = stage.gates.length > 0 && gatesChecked === stage.gates.length && gatesMet === stage.gates.length;

  return (
    <div className={cn("os-card mb-2.5", stage.status === "invalidated" && "!border-[var(--warn)]", stage.status === "blocked" && "!border-[var(--danger)]")}>
      <div className="flex items-center gap-2">
        <button onClick={() => setOpen((v) => !v)} className="text-[11px] text-[var(--muted)]">{open ? "▾" : "▸"}</button>
        <span className="os-chip !text-[10px]">{index + 1}</span>
        <input
          value={stage.title}
          onChange={(e) => dw.patchStage(planId, stage.id, { title: e.target.value })}
          className="min-w-0 flex-1 bg-transparent text-[13px] font-medium outline-none"
        />
        <StatusBadge status={stage.status} />
        <button className="os-btn !px-2 !py-0.5 text-[11px]" onClick={onRun} disabled={busy} title="Have the model produce this stage's output">Run</button>
        <button className="os-btn !px-2 !py-0.5 text-[11px]" onClick={() => dw.removeStage(planId, stage.id)}><Icon name="close" size={11} /></button>
      </div>

      {open && (
        <div className="mt-2 space-y-2.5 pl-6">
          <textarea
            value={stage.intent}
            onChange={(e) => dw.patchStage(planId, stage.id, { intent: e.target.value })}
            placeholder="What this stage produces…"
            rows={2}
            className="os-input resize-none text-[12px]"
          />

          <div>
            <div className="mb-1 flex items-center gap-2">
              <span className="os-label">Gates ({gatesMet}/{stage.gates.length} met)</span>
              <button className="os-btn !px-2 !py-0 text-[10px]" onClick={() => dw.addGate(planId, stage.id)}>+ Gate</button>
            </div>
            {stage.gates.length === 0 && (
              <div className="text-[11px] text-[var(--warn)]">
                No gates. This stage cannot be verified — add a check that could fail, or say plainly that its output is unverified.
              </div>
            )}
            {stage.gates.map((g) => (
              <div key={g.id} className="mb-1.5 rounded-[calc(var(--radius)*0.5)] border border-[var(--border)] p-2">
                <div className="mb-1 flex items-center gap-1.5">
                  <input
                    value={g.label}
                    onChange={(e) => dw.patchGate(planId, stage.id, g.id, { label: e.target.value })}
                    className="min-w-0 flex-1 bg-transparent text-[12px] font-medium outline-none"
                  />
                  <button
                    className={cn("os-btn !px-2 !py-0 text-[10px]", g.met === true && "!border-[var(--ok)] !bg-[var(--ok)]/18")}
                    onClick={() => dw.patchGate(planId, stage.id, g.id, { met: g.met === true ? null : true })}
                    title="Mark this gate met"
                  >
                    met
                  </button>
                  <button
                    className={cn("os-btn !px-2 !py-0 text-[10px]", g.met === false && "!border-[var(--danger)] !bg-[var(--danger)]/18")}
                    onClick={() => dw.patchGate(planId, stage.id, g.id, { met: g.met === false ? null : false })}
                    title="Mark this gate failed"
                  >
                    failed
                  </button>
                  <button className="text-[10px] opacity-60 hover:opacity-100" onClick={() => dw.removeGate(planId, stage.id, g.id)}><Icon name="close" size={11} /></button>
                </div>
                <input
                  value={g.expectation}
                  onChange={(e) => dw.patchGate(planId, stage.id, g.id, { expectation: e.target.value })}
                  placeholder="Expected observable result…"
                  className="os-input mb-1 !py-1 text-[11px]"
                />
                <input
                  value={g.observed}
                  onChange={(e) => dw.patchGate(planId, stage.id, g.id, { observed: e.target.value })}
                  placeholder="What was actually observed…"
                  className="os-input !py-1 text-[11px]"
                />
              </div>
            ))}
          </div>

          {stage.output && (
            <div>
              <div className="mb-1 flex items-center gap-2">
                <span className="os-label">Output</span>
                <div className="flex-1" />
                <CopyButton text={stage.output} className="!px-1.5 !py-0 !text-[10px]" />
              </div>
              <div className="max-h-96 overflow-y-auto rounded-[calc(var(--radius)*0.5)] border border-[var(--border)] p-2">
                <Markdown text={stage.output} />
              </div>
            </div>
          )}

          <div className="flex items-center gap-1.5">
            <button
              className="os-btn !py-1 text-[11px]"
              data-variant={canVerify ? "primary" : undefined}
              disabled={!canVerify}
              onClick={() => dw.patchStage(planId, stage.id, { status: "verified" })}
              title={canVerify ? "All gates met" : "Every gate must be checked and met first"}
            >
              Mark verified
            </button>
            {!canVerify && stage.gates.length > 0 && (
              <span className="text-[10.5px] text-[var(--muted)]">
                {stage.gates.length - gatesChecked} gate(s) unchecked{gatesMet < gatesChecked ? `, ${gatesChecked - gatesMet} failed` : ""}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: StageStatus }) {
  const map: Record<StageStatus, string> = {
    pending: "var(--muted)",
    active: "var(--accent)",
    ready: "var(--accent2)",
    verified: "var(--ok)",
    blocked: "var(--danger)",
    invalidated: "var(--warn)",
  };
  return (
    <span
      className="os-chip !text-[10px]"
      style={{ borderColor: map[status], background: `color-mix(in srgb, ${map[status]} 14%, transparent)`, color: map[status] }}
      title={status === "invalidated" ? "An earlier stage changed after this one was verified" : status}
    >
      {status}
    </span>
  );
}

function extractArray(text: string): Array<Record<string, unknown>> | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  const candidates = [text, start !== -1 && end > start ? text.slice(start, end + 1) : ""];
  for (const c of candidates) {
    if (!c) continue;
    try {
      const parsed = JSON.parse(c.trim());
      if (Array.isArray(parsed)) return parsed;
    } catch { /* next */ }
  }
  return null;
}
