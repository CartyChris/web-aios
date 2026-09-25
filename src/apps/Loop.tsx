"use client";

import { useCallback, useRef, useState } from "react";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { useVFS, aiMark } from "@/kernel/vfs";
import { bus } from "@/kernel/bus";
import { useSettings } from "@/kernel/settings";
import { useJobs } from "@/kernel/jobs";
import { useUserApps } from "@/kernel/userapps";
import { PROVIDERS } from "@/lib/providers";
import { runAgentLoop, type LoopIteration, type LoopResult, type LoopFile } from "@/lib/agent-loop";
import { ask } from "@/lib/useAI";
import { useModelCatalog, modelsFor } from "@/kernel/modelcatalog";
import { ModelRefreshButton } from "@/shell/ModelRefresh";
import { jevDecider } from "@/lib/s1-os";
import { EMULATED_SYSTEM, buildEmulatedPrompt, parseEmulatedReply } from "@/lib/s1/emulated";
import type { Decider } from "@/lib/s1/types";
import type { AppProps } from "@/kernel/types";
import { uid, download } from "@/lib/format";
import { Markdown, CopyButton, ErrorNote, Empty, Spinner, Slider } from "./_ui";
import { cn } from "@/lib/cn";

/* ────────────────────────────────────────────────────────────────────────────
   Agent Loop: plan / act / verify / learn, ported from forge-harness-0.1.0.

   The loop itself lives in lib/agent-loop.ts so the harness router can run it
   without this window. This file is the view: the objective, the price the
   user is willing to pay, an optional separate judge model, the live stream
   (including a reasoning model's thinking, which used to be invisible and made
   the panel look blank), every iteration, and the final result, which a run
   now always has.
   ──────────────────────────────────────────────────────────────────────────── */

type Iteration = LoopIteration;

interface LoopPrefs {
  priceCapUsd: number;
  judgeProvider: string;
  judgeModel: string;
  plansFirst: boolean;
  finalPass: boolean;
  /** Stop as soon as the judges pass a result; off runs every round. */
  stopOnPass: boolean;
  gauntlet: boolean;
  llmJudge: boolean;
  jevJudge: boolean;
  jevThreshold: number;
  set: (patch: Partial<Omit<LoopPrefs, "set">>) => void;
}

const useLoopPrefs = create<LoopPrefs>()(
  persist(
    (set) => ({ priceCapUsd: 0, judgeProvider: "", judgeModel: "", plansFirst: false, finalPass: true, stopOnPass: true, gauntlet: false, llmJudge: true, jevJudge: false, jevThreshold: 0.7, set: (patch) => set(patch) }),
    { name: "webaios.loop.v1", storage: createJSONStorage(() => localStorage), partialize: (s) => ({ priceCapUsd: s.priceCapUsd, judgeProvider: s.judgeProvider, judgeModel: s.judgeModel, plansFirst: s.plansFirst, finalPass: s.finalPass, stopOnPass: s.stopOnPass, gauntlet: s.gauntlet, llmJudge: s.llmJudge, jevJudge: s.jevJudge, jevThreshold: s.jevThreshold }) },
  ),
);

const SOURCE_TEXT: Record<LoopResult["final"]["source"], { label: string; color: string; note: string }> = {
  verified: { label: "verified", color: "var(--ok)", note: "An attempt the judge passed." },
  "final-pass": { label: "final pass", color: "var(--accent)", note: "Written by the final pass from everything the loop learned. Not separately verified." },
  "best-attempt": { label: "best attempt", color: "var(--warn)", note: "No attempt passed verification; this is the most substantial one." },
  fallback: { label: "fallback report", color: "var(--danger)", note: "No model produced an artifact. This report says what happened and how to get one." },
};

/** The Jev judge: the real System One model when a TypeSafe key is saved,
 *  otherwise the judge model answering the same typed questions, labelled as
 *  an emulation so nobody mistakes self-reported probabilities for Jev's. */
function makeJevJudge(key: string, provider: string | undefined, model: string | undefined, signal?: AbortSignal): Decider {
  if (key) return jevDecider(key);
  return {
    kind: "emulated",
    label: `emulated by ${model || useSettings.getState().ai.model}`,
    decide: async ({ state, questions }) => {
      const r = await ask({ messages: [{ role: "user", content: buildEmulatedPrompt(state, questions) }], system: EMULATED_SYSTEM, persona: false, temperature: 0, web: false, provider, model, signal, trace: { name: "loop-jev-emulated", role: "judge" } });
      return { raw: parseEmulatedReply(r.text) ?? {}, costUsd: r.costUsd };
    },
  };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "loop";

export default function Loop({ win }: AppProps) {
  const vfs = useVFS();
  const settings = useSettings();
  const prefs = useLoopPrefs();
  const [objective, setObjective] = useState("");
  const [dod, setDod] = useState("");
  const [preview, setPreview] = useState<{ key: string; file: LoopFile } | null>(null);
  const lists = useModelCatalog((s) => s.lists);
  const typesafeKey = useSettings((s) => s.ai.keys.typesafe ?? "");
  const [iterations, setIterations] = useState<Iteration[]>([]);
  const [result, setResult] = useState<LoopResult | null>(null);
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [maxIters, setMaxIters] = useState(4);
  const [live, setLive] = useState<{ text: string; reasoning: string }>({ text: "", reasoning: "" });
  const [spent, setSpent] = useState(0);
  const [showJudge, setShowJudge] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const judgeProviderId = prefs.judgeProvider || settings.ai.provider;
  const judgeModels = modelsFor(judgeProviderId, lists).map((m) => m.id);

  const run = useCallback(async () => {
    if (!objective.trim() || running) return;
    setRunning(true);
    setError(null);
    setIterations([]);
    setResult(null);
    setSpent(0);
    setLive({ text: "", reasoning: "" });
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const p = useLoopPrefs.getState();
    const jobs = useJobs.getState();
    const jobId = jobs.start({ kind: "task", title: `Agent Loop: ${objective.slice(0, 60)}`, progress: 0, target: { appId: "loop", windowId: win.id } });

    try {
      const res = await runAgentLoop({
        objective,
        maxIters,
        priceCapUsd: p.priceCapUsd,
        judge: p.judgeModel ? { provider: p.judgeProvider || undefined, model: p.judgeModel, plansFirst: p.plansFirst, finalPass: p.finalPass } : undefined,
        definitionOfDone: dod,
        stopOnPass: p.stopOnPass,
        gauntlet: p.gauntlet,
        llmJudge: p.llmJudge,
        jevJudge: p.jevJudge ? { decider: makeJevJudge(useSettings.getState().ai.keys.typesafe ?? "", p.judgeModel ? (p.judgeProvider || undefined) : undefined, p.judgeModel || undefined, ctrl.signal), threshold: p.jevThreshold } : undefined,
        signal: ctrl.signal,
        onEvent: (e) => {
          if (e.type === "phase") {
            setPhase(e.phase);
            // Keep what was on screen until the next phase actually says
            // something; clearing first is what made the panel look blank.
            setLive((l) => ({ text: l.text, reasoning: "" }));
            useJobs.getState().update(jobId, { detail: e.phase });
          } else if (e.type === "live") {
            setLive((l) => (e.reasoning !== undefined ? { ...l, reasoning: e.reasoning } : { text: e.text, reasoning: l.reasoning }));
          } else if (e.type === "iteration") {
            setIterations((it) => [...it, e.iteration]);
            setLive({ text: "", reasoning: "" });
            useJobs.getState().update(jobId, { progress: Math.min(0.95, e.iteration.n / maxIters) });
          } else if (e.type === "cost") {
            setSpent(e.costUsd);
          }
        },
      });
      setResult(res);
      setIterations(res.iterations);
      const good = res.final.source === "verified" || res.final.source === "final-pass";
      useJobs.getState().finish(jobId, good ? "done" : "error", `${SOURCE_TEXT[res.final.source].label} · ${res.final.files.length} file${res.final.files.length === 1 ? "" : "s"}`);
      bus.emit("notify", {
        title: res.stopped === "converged" ? `Loop converged in ${res.iterations.length} iteration${res.iterations.length === 1 ? "" : "s"}` : `Loop finished: ${SOURCE_TEXT[res.final.source].label}`,
        body: `${res.final.files.length} file${res.final.files.length === 1 ? "" : "s"} · ~$${res.costUsd.toFixed(4)}${res.stopped === "price-cap" ? " · stopped at your price cap" : ""}`,
        kind: good ? "success" : "warn",
        target: { appId: "loop", windowId: win.id },
      });
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError(e instanceof Error ? e.message : "Loop failed.");
      useJobs.getState().finish(jobId, "error", e instanceof Error ? e.message : "Loop failed.");
    } finally {
      setRunning(false);
      setPhase("");
      setLive({ text: "", reasoning: "" });
      abortRef.current = null;
    }
  }, [objective, dod, running, maxIters, win.id]);

  const log = useCallback(() => {
    const lines = [`# Agent loop`, "", `**Objective:** ${objective}`, "", `> ${new Date().toISOString()} · ${iterations.length} iterations · $${(result?.costUsd ?? iterations.reduce((a, i) => a + i.costUsd, 0)).toFixed(4)} estimated`, ""];
    for (const it of iterations) {
      lines.push(`## Iteration ${it.n} — ${it.verdict?.pass ? "PASSED" : "FAILED"}`, "", `**Plan:** ${it.plan}`, "", "**Result:**", "", it.action || "(empty)", "", `**Verdict:** ${it.verdict?.reason ?? "—"}`, "");
    }
    if (result) lines.push(`## Final result (${SOURCE_TEXT[result.final.source].label})`, "", result.final.text, "");
    return lines.join("\n");
  }, [objective, iterations, result]);

  const saveFiles = useCallback(() => {
    if (!result) return;
    const dir = `/loops/${slug(objective)}-${uid("r").slice(-5)}`;
    vfs.write(`${dir}/RESULT.md`, result.final.text, { appId: "loop", ...aiMark("Agent Loop", result.final.by) });
    for (const f of result.final.files) vfs.write(`${dir}/${f.path}`, f.content, { appId: "loop", ...aiMark("Agent Loop", result.final.by) });
    bus.emit("notify", { title: `Saved ${result.final.files.length + 1} file${result.final.files.length ? "s" : ""} to ${dir}`, kind: "success", target: { appId: "files", args: { path: dir } } });
  }, [result, objective, vfs]);

  const runAsApp = useCallback((html: string) => {
    const id = useUserApps.getState().install(objective.slice(0, 40) || "Loop result", html, "app", { prompt: `Agent Loop: ${objective}` });
    bus.emit("app:open", { appId: "studio", args: { runUserApp: id } });
  }, [objective]);

  const converged = iterations.some((i) => i.verdict?.pass);
  const cost = result?.costUsd ?? spent;
  const src = result ? SOURCE_TEXT[result.final.source] : null;

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-[var(--border)] p-2.5">
        <ErrorNote error={error} onDismiss={() => setError(null)} />
        <textarea
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          rows={2}
          placeholder="The objective. Be specific about what 'done' looks like — the verifier is only as good as this line."
          className="os-input mb-2 resize-none text-[12px]"
        />
        <textarea
          value={dod}
          onChange={(e) => setDod(e.target.value)}
          rows={1}
          placeholder="Definition of done (optional). Every judge checks against this; empty means the objective itself."
          className="os-input mb-2 resize-y text-[11.5px]"
          aria-label="Definition of done"
        />
        <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
          <label className="flex items-center gap-1.5" title="If the judges pass a result before the last round, stop there. Off runs every round, each improving on the last passing version.">
            <input type="checkbox" checked={prefs.stopOnPass} onChange={(e) => prefs.set({ stopOnPass: e.target.checked })} /> Stop when the definition of done is met
          </label>
          <span className="flex items-center gap-1" role="group" aria-label="Loop mode">
            <span className="text-[var(--muted)]">Mode</span>
            <button className={cn("os-btn !px-2 !py-0.5 text-[10.5px]", !prefs.gauntlet && "!border-[var(--accent)]")} onClick={() => prefs.set({ gauntlet: false })} aria-pressed={!prefs.gauntlet}>Standard</button>
            <button
              className={cn("os-btn !px-2 !py-0.5 text-[10.5px]", prefs.gauntlet && "!border-[var(--accent)]")} onClick={() => prefs.set({ gauntlet: true })} aria-pressed={prefs.gauntlet}
              title="Gauntlet: the bar rises every round. Round 1 is the definition of done; from round 2 a red team attacks the result and it must survive with no high-severity defect; from round 3 no medium one either. Stop-when-done only stops at the strictest bar."
            >Gauntlet</button>
          </span>
          <span className="text-[var(--muted)]">
            Judges: {[prefs.llmJudge || !prefs.jevJudge ? `LLM (${prefs.judgeModel || "auto"})` : null, prefs.jevJudge ? `Jev${typesafeKey ? "" : " (emulated)"}` : null, prefs.gauntlet ? "red team from round 2" : null].filter(Boolean).join(" + ")}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {running ? (
            <button className="os-btn !py-1 text-[11px]" onClick={() => abortRef.current?.abort()}>◼ Stop</button>
          ) : (
            <button className="os-btn !py-1 text-[11px]" data-variant="primary" onClick={run} disabled={!objective.trim()}>Run loop</button>
          )}
          <div className="w-36"><Slider label="Max iterations" value={maxIters} min={1} max={8} onChange={setMaxIters} /></div>
          <label className="flex items-center gap-1 text-[11px] text-[var(--muted)]" title="The most this run may spend, in US dollars. 0 means no cap. If nothing has been produced when the cap is reached, one final call is still made so the run ends with a result.">
            Price cap $
            <input
              type="number" min={0} step={0.05} inputMode="decimal"
              value={prefs.priceCapUsd || ""}
              placeholder="none"
              onChange={(e) => prefs.set({ priceCapUsd: Math.max(0, Number(e.target.value) || 0) })}
              className="os-input !w-20 !py-0.5 text-[11px]"
              aria-label="Price cap in US dollars"
            />
          </label>
          <button className={cn("os-btn !py-1 text-[11px]", prefs.judgeModel && "!border-[var(--accent)]")} onClick={() => setShowJudge((v) => !v)} aria-expanded={showJudge}>
            Judges{prefs.jevJudge ? " + Jev" : ""}: {prefs.judgeModel ? prefs.judgeModel : "auto"} (set up judges, Jev)
          </button>
          {phase && <Spinner label={phase} />}
          <div className="flex-1" />
          {converged && <span className="os-chip" style={{ borderColor: "var(--ok)", color: "var(--ok)" }}>converged</span>}
          {(iterations.length > 0 || running) && <span className="os-chip">~${cost.toFixed(4)}{prefs.priceCapUsd > 0 ? ` / $${prefs.priceCapUsd.toFixed(2)}` : ""}</span>}
          {iterations.length > 0 && (
            <>
              <CopyButton text={log()} label="Copy log" />
              <button className="os-btn !py-1 text-[11px]" onClick={() => { vfs.write(`/loops/${uid("loop")}.md`, log(), { appId: "loop" }); bus.emit("notify", { title: "Log saved to Files", kind: "success" }); }}>Save</button>
              <button className="os-btn !py-1 text-[11px]" onClick={() => download(`loop-${Date.now()}.md`, log(), "text/markdown")}>Export</button>
            </>
          )}
        </div>

        {showJudge && (
          <div className="mt-2 grid gap-2 rounded-[calc(var(--radius)*0.5)] border border-[var(--border)] p-2 text-[11px] sm:grid-cols-[auto_1fr_1fr]">
            <div className="os-label self-center sm:col-span-3">Judges (separate from the builder model in the top bar: {settings.ai.model})</div>
            <select
              className="os-input !py-1 text-[11px]"
              value={prefs.judgeProvider}
              onChange={(e) => prefs.set({ judgeProvider: e.target.value, judgeModel: "" })}
              aria-label="Judge provider"
            >
              <option value="">Same provider ({settings.ai.provider})</option>
              {PROVIDERS.filter((p) => p.id !== "custom").map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <input
              className="os-input !py-1 text-[11px]"
              list={`loop-judge-models-${win.id}`}
              value={prefs.judgeModel}
              placeholder="auto: a different model on your provider"
              onChange={(e) => prefs.set({ judgeModel: e.target.value.trim() })}
              aria-label="Judge model id"
            />
            <datalist id={`loop-judge-models-${win.id}`}>
              {judgeModels.map((m) => <option key={m} value={m} />)}
            </datalist>
            <div className="flex items-center gap-2 sm:col-span-3">
              <ModelRefreshButton providerId={judgeProviderId} compact />
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={prefs.llmJudge} onChange={(e) => prefs.set({ llmJudge: e.target.checked })} /> LLM judge</label>
              <label className="flex items-center gap-1.5" title="Jev, TypeSafe's System One model, answers 'does this meet the definition of done' as a probability. Uses your TypeSafe key from the System One app; without one, the judge model emulates it and says so.">
                <input type="checkbox" checked={prefs.jevJudge} onChange={(e) => prefs.set({ jevJudge: e.target.checked })} /> Jev judge{typesafeKey ? "" : " (emulated: no TypeSafe key)"}
              </label>
              {prefs.jevJudge && (
                <div className="w-40"><Slider label="Jev pass at P >=" value={prefs.jevThreshold} min={0.5} max={0.95} step={0.05} onChange={(v) => prefs.set({ jevThreshold: v })} format={(v) => v.toFixed(2)} /></div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={prefs.plansFirst} onChange={(e) => prefs.set({ plansFirst: e.target.checked })} /> Plans first</label>
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={prefs.finalPass} onChange={(e) => prefs.set({ finalPass: e.target.checked })} /> Writes the final pass</label>
            </div>
            <p className="text-[10.5px] leading-relaxed text-[var(--muted)] sm:col-span-3">
              The judge always verifies. With a model set, it can also make the first plan (a strong model sets direction, your selected model does the volume) and write the last pass, turning the best attempt and every verifier note into the finished deliverable.
              {!prefs.judgeModel && " With none set, verification uses a different model on your provider where one exists."}
            </p>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {iterations.length === 0 && !running && !result && (
          <Empty
            icon="loop"
            title="No run yet"
            body="Each iteration plans one step, carries it out, then hands the result to a separate verifier that sees only the objective and the output. A failed verification becomes context for the next attempt — the loop cannot mark its own homework. Every run ends with a result, labelled with how far to trust it."
          />
        )}

        {result && src && (
          <div className="os-card mb-3" style={{ borderColor: src.color }} data-loop-final={result.final.source}>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="os-label">Result</span>
              <span className="os-chip" style={{ borderColor: src.color, color: src.color }}>{src.label}</span>
              {result.final.by && <span className="text-[10px] text-[var(--muted)]">by {result.final.by}</span>}
              {result.stopped === "price-cap" && <span className="os-chip" style={{ borderColor: "var(--warn)", color: "var(--warn)" }}>stopped at price cap</span>}
              <div className="flex-1" />
              <CopyButton text={result.final.text} label="Copy" />
              <button className="os-btn !py-1 text-[11px]" onClick={saveFiles}>Save to Files</button>
              <button className="os-btn !py-1 text-[11px]" onClick={() => download(`${slug(objective)}.md`, result.final.text, "text/markdown")}>Download</button>
            </div>
            <p className="mb-2 text-[11px] text-[var(--muted)]">{src.note}</p>
            {result.final.files.length > 0 && (
              <div className="mb-2"><FileChips files={result.final.files} round={0} preview={preview} setPreview={setPreview} onRun={runAsApp} /></div>
            )}
            <div className="max-h-96 overflow-y-auto rounded-[calc(var(--radius)*0.5)] border border-[var(--border)] p-2"><Markdown text={result.final.text} /></div>
          </div>
        )}

        {iterations.map((it) => (
          <div key={it.n} className={cn("os-card mb-2.5", it.verdict?.pass ? "!border-[var(--ok)]" : "!border-[var(--warn)]")}>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="os-chip">Iteration {it.n}</span>
              <span className="os-chip" style={{ borderColor: it.verdict?.pass ? "var(--ok)" : "var(--danger)", color: it.verdict?.pass ? "var(--ok)" : "var(--danger)" }}>
                {it.verdict?.pass ? "verified" : "failed"}
              </span>
              {it.rescued && <span className="os-chip" title="The first reply was empty; it was retried with more room and less thinking.">retried</span>}
              {it.bar && <span className="os-chip" title="The gauntlet bar this round was held to">bar: {it.bar}</span>}
              <div className="flex-1" />
              <span className="text-[10px] text-[var(--muted)]">{(it.ms / 1000).toFixed(1)}s · ~${it.costUsd.toFixed(4)}</span>
            </div>
            <div className="mb-2">
              <div className="os-label mb-0.5">Plan{it.planner ? ` · ${it.planner}` : ""}</div>
              <div className="text-[12px] leading-relaxed">{it.plan}</div>
            </div>
            <div className="mb-2">
              <div className="os-label mb-0.5">Result{it.actor ? ` · ${it.actor}` : ""}</div>
              <div className="max-h-72 overflow-y-auto rounded-[calc(var(--radius)*0.5)] border border-[var(--border)] p-2">
                {it.action ? <Markdown text={it.action} /> : <span className="text-[11px] text-[var(--muted)]">(empty)</span>}
              </div>
            </div>
            {it.files && it.files.length > 0 && (
              <div className="mb-2">
                <div className="os-label mb-0.5">Artifacts from this round</div>
                <FileChips files={it.files} round={it.n} preview={preview} setPreview={setPreview} onRun={runAsApp} />
              </div>
            )}
            <div>
              <div className="os-label mb-0.5">Verifier</div>
              {it.votes && it.votes.length > 0 ? (
                <ul className="space-y-0.5 text-[12px]">
                  {it.votes.map((v) => (
                    <li key={v.name} style={{ color: v.pass ? "var(--ok)" : "var(--warn)" }}>
                      <span className="font-medium">{v.pass ? "Pass" : "Fail"} · {v.name}</span>{typeof v.p === "number" && <span className="ml-1 tabular-nums">({v.p.toFixed(2)})</span>}: {v.detail}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="text-[12px]" style={{ color: it.verdict?.pass ? "var(--ok)" : "var(--warn)" }}>{it.verdict?.reason}</div>
              )}
              {it.defects && it.defects.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-[11px] text-[var(--muted)]">
                  {it.defects.map((d, i) => <li key={i}><span style={{ color: d.severity === "high" ? "var(--danger)" : d.severity === "medium" ? "var(--warn)" : "var(--muted)" }}>[{d.severity}]</span> {d.issue}</li>)}
                </ul>
              )}
            </div>
          </div>
        ))}

        {running && (live.text || live.reasoning) && (
          <div className="os-card" data-loop-live>
            <div className="os-label mb-1">{phase}</div>
            {live.reasoning && !live.text && (
              <div className="mb-1 text-[11px] text-[var(--muted)]">
                <div className="mb-0.5">Thinking · {live.reasoning.length.toLocaleString()} characters so far</div>
                <div className="max-h-32 overflow-hidden whitespace-pre-wrap font-mono text-[10.5px] opacity-80">{live.reasoning.slice(-700)}</div>
              </div>
            )}
            {live.text && <Markdown text={live.text} />}
          </div>
        )}
      </div>
    </div>
  );
}

/** A round's files: download any, run an HTML one as an app, or preview it
 *  right here. The preview is a sandboxed frame with scripts but without
 *  same-origin, so a generated page can run its game loop but cannot read
 *  this OS's storage, where the API keys are. */
function FileChips({ files, round, preview, setPreview, onRun }: {
  files: LoopFile[];
  round: number;
  preview: { key: string; file: LoopFile } | null;
  setPreview: (p: { key: string; file: LoopFile } | null) => void;
  onRun: (html: string) => void;
}) {
  const open = preview && preview.key.startsWith(`${round}:`) ? preview : null;
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {files.map((f) => {
          const key = `${round}:${f.path}`;
          const html = /\.html?$/i.test(f.path);
          return (
            <span key={f.path} className={cn("flex items-center gap-1 rounded-[calc(var(--radius)*0.5)] border px-1.5 py-0.5 text-[11px]", open?.key === key ? "border-[var(--accent)]" : "border-[var(--border)]")}>
              <span className="font-mono">{f.path}</span>
              <span className="text-[var(--muted)]">{(f.content.length / 1024).toFixed(1)} KB</span>
              <button className="os-btn !px-1.5 !py-0 text-[10px]" onClick={() => setPreview(open?.key === key ? null : { key, file: f })} aria-label={`${open?.key === key ? "Hide" : "Preview"} ${f.path}`}>{open?.key === key ? "Hide" : "Preview"}</button>
              {html && <button className="os-btn !px-1.5 !py-0 text-[10px]" data-variant="primary" onClick={() => onRun(f.content)} aria-label={`Run ${f.path} as an app`}>Run</button>}
              <button className="os-btn !px-1.5 !py-0 text-[10px]" onClick={() => download(f.path.split("/").pop() ?? f.path, f.content)} aria-label={`Download ${f.path}`}>Download</button>
            </span>
          );
        })}
      </div>
      {open && (
        /\.html?$/i.test(open.file.path) ? (
          <iframe
            title={`Preview of ${open.file.path}`}
            srcDoc={open.file.content}
            sandbox="allow-scripts allow-pointer-lock allow-forms allow-modals"
            className="mt-2 h-[420px] w-full rounded-[calc(var(--radius)*0.5)] border border-[var(--border)] bg-white"
            data-loop-preview={open.key}
          />
        ) : (
          <pre className="mt-2 max-h-80 overflow-auto rounded-[calc(var(--radius)*0.5)] border border-[var(--border)] p-2 font-mono text-[11px]" data-loop-preview={open.key}>{open.file.content}</pre>
        )
      )}
    </div>
  );
}
