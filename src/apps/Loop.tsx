"use client";

import { useCallback, useRef, useState } from "react";
import { useVFS } from "@/kernel/vfs";
import { bus } from "@/kernel/bus";
import { ask } from "@/lib/useAI";
import { pickJudgeModel } from "@/lib/providers";
import { useSettings } from "@/kernel/settings";
import type { AppProps } from "@/kernel/types";
import { uid, download } from "@/lib/format";
import { Markdown, CopyButton, ErrorNote, Empty, Spinner, Slider } from "./_ui";
import { cn } from "@/lib/cn";

/* ────────────────────────────────────────────────────────────────────────────
   Agent Loop — ported from forge-harness-0.1.0's core (plan / act / verify /
   learn, with a session log).

   The load-bearing idea from that package: the loop does not get to decide it
   succeeded. A separate verify step, given only the objective and the result,
   returns a pass/fail and a reason — and a failed verification feeds back in as
   context for the next iteration rather than being discarded. Without that, a
   "self-improving" loop is just a model agreeing with itself N times.
   ──────────────────────────────────────────────────────────────────────────── */

interface Iteration {
  n: number;
  plan: string;
  action: string;
  verdict: { pass: boolean; reason: string } | null;
  learning: string;
  ms: number;
  costUsd: number;
}

export default function Loop({}: AppProps) {
  const vfs = useVFS();
  const settings = useSettings();
  const [objective, setObjective] = useState("");
  const [iterations, setIterations] = useState<Iteration[]>([]);
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [maxIters, setMaxIters] = useState(4);
  const [live, setLive] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(async () => {
    if (!objective.trim() || running) return;
    setRunning(true);
    setError(null);
    setIterations([]);
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const learnings: string[] = [];
    try {
      for (let n = 1; n <= maxIters; n++) {
        if (ctrl.signal.aborted) break;
        const started = performance.now();
        let cost = 0;
        const ctx = learnings.length ? `\n\nWhat previous attempts established:\n${learnings.map((l, i) => `${i + 1}. ${l}`).join("\n")}` : "";

        // ── PLAN ──
        setPhase(`Iteration ${n} · planning`);
        setLive("");
        const plan = await ask({
          messages: [{ role: "user", content: `Objective: ${objective}${ctx}` }],
          system: "You plan ONE concrete next step toward the objective. Not a roadmap — one step, the one that makes the most progress given what is already known. State it in two or three sentences, and state what observable result would show it worked.",
          maxTokens: 500, signal: ctrl.signal,
          onDelta: (_d, f) => setLive(f),
        });
        cost += plan.costUsd;

        // ── ACT ──
        setPhase(`Iteration ${n} · acting`);
        setLive("");
        const action = await ask({
          messages: [{ role: "user", content: `Objective: ${objective}${ctx}\n\nThe step to carry out:\n${plan.text}` }],
          system: "Carry out the planned step and produce the actual artifact — the code, the document, the analysis. Not a description of what you would produce. If the step cannot be completed, say exactly what blocked it.",
          maxTokens: 3000, signal: ctrl.signal,
          onDelta: (_d, f) => setLive(f),
        });
        cost += action.costUsd;

        // ── VERIFY ──
        // Independence here is three separate things, and the loop is only as
        // honest as the weakest of them:
        //   what it sees  — the objective and the result, never the plan or the
        //                   reasoning; a verifier shown the argument for
        //                   something tends to agree with it.
        //   how it speaks — persona: false. The OS voice ("be terse", "be
        //                   deadpan") is a preference for talking to the user,
        //                   and letting it reach a verifier changes a
        //                   correctness judgement for cosmetic reasons.
        //   whose weights — a different model where the provider has one. A
        //                   model grading its own output agrees with itself.
        const ai = useSettings.getState().ai;
        const judge = pickJudgeModel(ai.provider, ai.model);
        setPhase(`Iteration ${n} · verifying`);
        setLive("");
        const verify = await ask({
          messages: [{ role: "user", content: `Objective:\n${objective}\n\nResult produced:\n${action.text}` }],
          system: `You verify work against an objective. You did not produce this and have no stake in it.

Return ONLY JSON: {"pass": true|false, "reason": "<one or two sentences>"}

Pass only if the result actually achieves the objective. A plausible-sounding description of work is not work. Incomplete, hedged, or placeholder output fails. Say specifically what is missing.`,
          maxTokens: 400, signal: ctrl.signal,
          model: judge.model,
          persona: false,
        });
        cost += verify.costUsd;

        let verdict: Iteration["verdict"] = null;
        try {
          const s = verify.text.indexOf("{");
          const e = verify.text.lastIndexOf("}");
          const parsed = JSON.parse(s !== -1 && e > s ? verify.text.slice(s, e + 1) : verify.text);
          verdict = { pass: Boolean(parsed.pass), reason: String(parsed.reason ?? "") };
        } catch {
          verdict = { pass: false, reason: "Verifier did not return parseable JSON — treating as unverified rather than assuming success." };
        }
        // Say so when the check is weaker than it looks, rather than letting a
        // same-model pass read like an independent one.
        if (judge.shared && verdict.pass) {
          verdict = { ...verdict, reason: `${verdict.reason} (Verified by the same model that produced it — ${ai.provider} offers no alternative, so this is a weaker check than an independent one.)` };
        }

        // ── LEARN ──
        const learning = verdict.pass
          ? `Iteration ${n} succeeded: ${verdict.reason}`
          : `Iteration ${n} failed verification: ${verdict.reason}`;
        learnings.push(learning);

        setIterations((it) => [...it, { n, plan: plan.text, action: action.text, verdict, learning, ms: Math.round(performance.now() - started), costUsd: cost }]);

        if (verdict.pass) {
          bus.emit("notify", { title: `Loop converged in ${n} iteration${n === 1 ? "" : "s"}`, kind: "success" });
          break;
        }
        if (n === maxIters) {
          bus.emit("notify", { title: "Loop hit its iteration cap", body: "Objective not verified.", kind: "warn" });
        }
        if (settings.ai.budgetUsd > 0 && useSettings.getState().ai.spentUsd >= settings.ai.budgetUsd) {
          setError("Budget reached — loop stopped.");
          break;
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError(e instanceof Error ? e.message : "Loop failed.");
    } finally {
      setRunning(false);
      setPhase("");
      setLive("");
      abortRef.current = null;
    }
  }, [objective, running, maxIters, settings.ai.budgetUsd]);

  const log = useCallback(() => {
    const lines = [`# Agent loop`, "", `**Objective:** ${objective}`, "", `> ${new Date().toISOString()} · ${iterations.length} iterations · $${iterations.reduce((a, i) => a + i.costUsd, 0).toFixed(4)} estimated`, ""];
    for (const it of iterations) {
      lines.push(`## Iteration ${it.n} — ${it.verdict?.pass ? "PASSED" : "FAILED"}`, "", `**Plan:** ${it.plan}`, "", "**Result:**", "", it.action, "", `**Verdict:** ${it.verdict?.reason ?? "—"}`, "");
    }
    return lines.join("\n");
  }, [objective, iterations]);

  const converged = iterations.some((i) => i.verdict?.pass);

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
        <div className="flex flex-wrap items-center gap-2">
          {running ? (
            <button className="os-btn !py-1 text-[11px]" onClick={() => abortRef.current?.abort()}>◼ Stop</button>
          ) : (
            <button className="os-btn !py-1 text-[11px]" data-variant="primary" onClick={run} disabled={!objective.trim()}>Run loop</button>
          )}
          <div className="w-36"><Slider label="Max iterations" value={maxIters} min={1} max={8} onChange={setMaxIters} /></div>
          {phase && <Spinner label={phase} />}
          <div className="flex-1" />
          {converged && <span className="os-chip" style={{ borderColor: "var(--ok)", color: "var(--ok)" }}>converged</span>}
          {iterations.length > 0 && (
            <>
              <span className="os-chip">~${iterations.reduce((a, i) => a + i.costUsd, 0).toFixed(4)}</span>
              <CopyButton text={log()} label="Copy log" />
              <button className="os-btn !py-1 text-[11px]" onClick={() => { vfs.write(`/loops/${uid("loop")}.md`, log(), { appId: "loop" }); bus.emit("notify", { title: "Log saved to Files", kind: "success" }); }}>Save</button>
              <button className="os-btn !py-1 text-[11px]" onClick={() => download(`loop-${Date.now()}.md`, log(), "text/markdown")}>Export</button>
            </>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {iterations.length === 0 && !running && (
          <Empty
            icon="loop"
            title="No run yet"
            body="Each iteration plans one step, carries it out, then hands the result to a separate verifier that sees only the objective and the output. A failed verification becomes context for the next attempt — the loop cannot mark its own homework."
          />
        )}

        {iterations.map((it) => (
          <div key={it.n} className={cn("os-card mb-2.5", it.verdict?.pass ? "!border-[var(--ok)]" : "!border-[var(--warn)]")}>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="os-chip">Iteration {it.n}</span>
              <span className="os-chip" style={{ borderColor: it.verdict?.pass ? "var(--ok)" : "var(--danger)", color: it.verdict?.pass ? "var(--ok)" : "var(--danger)" }}>
                {it.verdict?.pass ? "verified" : "failed"}
              </span>
              <div className="flex-1" />
              <span className="text-[10px] text-[var(--muted)]">{(it.ms / 1000).toFixed(1)}s · ~${it.costUsd.toFixed(4)}</span>
            </div>
            <div className="mb-2">
              <div className="os-label mb-0.5">Plan</div>
              <div className="text-[12px] leading-relaxed">{it.plan}</div>
            </div>
            <div className="mb-2">
              <div className="os-label mb-0.5">Result</div>
              <div className="max-h-72 overflow-y-auto rounded-[calc(var(--radius)*0.5)] border border-[var(--border)] p-2"><Markdown text={it.action} /></div>
            </div>
            <div>
              <div className="os-label mb-0.5">Verifier</div>
              <div className="text-[12px]" style={{ color: it.verdict?.pass ? "var(--ok)" : "var(--warn)" }}>{it.verdict?.reason}</div>
            </div>
          </div>
        ))}

        {running && live && (
          <div className="os-card">
            <div className="os-label mb-1">{phase}</div>
            <Markdown text={live} />
          </div>
        )}
      </div>
    </div>
  );
}
