"use client";

import { ask, type AskResult } from "./useAI";
import { pickJudgeModel } from "./providers";
import { useSettings } from "@/kernel/settings";
import {
  extractFiles, fallbackReport, isEmptyResult, nextIterationEstimate, pickResult, withinCap,
  combineVotes, gauntletBar, clearsBar, parseDefects, shouldStop, type JudgeVote, type Defect,
} from "./loop-policy";
import { parseAnswers } from "./s1/parse";
import type { Decider, Questions } from "./s1/types";

/* Headless plan / act / verify loop, ported from forge-harness-0.1.0's core.
   The Agent Loop app is a view over this, and the harness router calls it
   directly.

   The load-bearing idea from that package still holds: the loop does not get
   to decide it succeeded. A separate verifier, shown only the objective and the
   result, returns pass/fail, and a failure becomes context for the next try.

   What this version adds is a guarantee at the other end. A run always
   returns a result, and says how much to trust it:
     verified     - an attempt the judge passed
     final-pass   - written by the final pass from everything the loop learned
     best-attempt - the most substantial attempt, not verified
     fallback     - no model produced anything; an honest report instead
   The run that prompted this spent four iterations with a reasoning model
   whose every act step came back empty: its whole token budget went on hidden
   thinking. ask() now retries an empty answer with more room and less
   thinking, and the act step asks for far more room to begin with. */

export interface LoopModel {
  provider?: string;
  model?: string;
}

export interface LoopIteration {
  n: number;
  plan: string;
  action: string;
  verdict: { pass: boolean; reason: string } | null;
  learning: string;
  ms: number;
  costUsd: number;
  /** Who planned and who acted, so a mixed-model run is legible afterwards. */
  planner?: string;
  actor?: string;
  /** The act step came back empty the first time and was retried. */
  rescued?: boolean;
  /** Every judge's vote, so a panel verdict can be read judge by judge. */
  votes?: JudgeVote[];
  /** Gauntlet: what the red team found, and the bar this round was held to. */
  defects?: Defect[];
  bar?: string;
  /** The files in this iteration's result, so each round can be tried on its own. */
  files?: LoopFile[];
}

export interface LoopFile {
  path: string;
  content: string;
}

export type LoopEvent =
  | { type: "phase"; phase: string }
  | { type: "live"; text: string; reasoning?: string }
  | { type: "iteration"; iteration: LoopIteration }
  | { type: "cost"; costUsd: number };

export interface AgentLoopOptions {
  objective: string;
  maxIters: number;
  /** Hard price for the whole run in USD. 0 or undefined means no cap. */
  priceCapUsd?: number;
  /** Separate judge model. It always verifies; it can also plan first and/or do the final pass. */
  judge?: LoopModel & { plansFirst?: boolean; finalPass?: boolean };
  /** What "done" means, given to every judge. Defaults to the objective. */
  definitionOfDone?: string;
  /** Stop as soon as the judges pass a result. Off runs every round, each one
   *  improving on the last passing version. Default true. */
  stopOnPass?: boolean;
  /** Gauntlet: the bar rises every round and a red team attacks each result. */
  gauntlet?: boolean;
  /** A System One judge (Jev, or its emulation) voting beside the LLM judge.
   *  Injected rather than imported: lib/s1-os imports this module. */
  jevJudge?: { decider: Decider; threshold: number };
  /** Turn the LLM judge off and let Jev judge alone. Default true. */
  llmJudge?: boolean;
  signal?: AbortSignal;
  onEvent?: (e: LoopEvent) => void;
}

export interface LoopResult {
  iterations: LoopIteration[];
  /** Never empty. `source` says how honest it is. */
  final: { text: string; files: LoopFile[]; source: "verified" | "final-pass" | "best-attempt" | "fallback"; by?: string };
  costUsd: number;
  stopped: "converged" | "iterations" | "price-cap" | "aborted" | "budget";
}

const ACT_MAX_TOKENS = 16000;

const label = (m: LoopModel) => {
  const ai = useSettings.getState().ai;
  return `${m.provider ?? ai.provider} · ${m.model ?? ai.model}`;
};

const isAbort = (e: unknown) => (e as Error)?.name === "AbortError";
const isBudget = (e: unknown) => /budget of \$/i.test((e as Error)?.message ?? "");

export async function runAgentLoop(opts: AgentLoopOptions): Promise<LoopResult> {
  const { objective, maxIters, priceCapUsd, signal } = opts;
  const emit = (e: LoopEvent) => opts.onEvent?.(e);
  const ai = useSettings.getState().ai;
  const producer: LoopModel = { provider: ai.provider, model: ai.model };

  // An explicit judge is used as given. Otherwise the verifier is a different
  // model on the producer's provider where one exists: a model grading its own
  // output agrees with itself, and that agreement looks exactly like success.
  const auto = pickJudgeModel(ai.provider, ai.model);
  const judge: LoopModel & { shared: boolean } = opts.judge?.model
    ? { provider: opts.judge.provider ?? ai.provider, model: opts.judge.model, shared: opts.judge.model === ai.model && (opts.judge.provider ?? ai.provider) === ai.provider }
    : { provider: ai.provider, model: auto.model, shared: auto.shared };

  const iterations: LoopIteration[] = [];
  const learnings: string[] = [];
  const stopOnPass = opts.stopOnPass !== false;
  const dod = opts.definitionOfDone?.trim() || objective;
  let pendingVotes: JudgeVote[] | undefined;
  let pendingDefects: Defect[] | undefined;
  let pendingBar: string | undefined;

  async function llmVote(result: string): Promise<JudgeVote> {
    const r = await ask({
      messages: [{ role: "user", content: `Objective:\n${objective}\n\nDefinition of done:\n${dod}\n\nResult produced:\n${result}` }],
      system: `You verify work against a definition of done. You did not produce this and have no stake in it.

Return ONLY JSON: {"pass": true|false, "reason": "<one or two sentences>"}

Pass only if the result actually meets the definition of done. A plausible-sounding description of work is not work. Incomplete, hedged, or placeholder output fails. Say specifically what is missing.`,
      maxTokens: 1200, signal, provider: judge.provider, model: judge.model, persona: false,
    });
    charge(r);
    const name = `LLM judge · ${judge.model ?? ai.model}`;
    try {
      const a = r.text.indexOf("{");
      const b = r.text.lastIndexOf("}");
      const parsed = JSON.parse(a !== -1 && b > a ? r.text.slice(a, b + 1) : r.text);
      return { name, pass: Boolean(parsed.pass), detail: String(parsed.reason ?? "") };
    } catch {
      return { name, pass: false, detail: "Did not return parseable JSON, so this is treated as unverified rather than assumed to pass." };
    }
  }

  /** Jev answers typed questions with probabilities, so its vote is a number
   *  against a threshold rather than a sentence to interpret. */
  async function jevVote(result: string, j: NonNullable<AgentLoopOptions["jevJudge"]>): Promise<JudgeVote> {
    const questions: Questions = {
      meets_definition_of_done: { type: "noul", instructions: "The RESULT fully meets every part of the DEFINITION OF DONE, as working output rather than a description or a placeholder." },
      quality: { type: "score", instructions: "How complete and polished the RESULT is against the OBJECTIVE.", criteria: ["Missing, broken or placeholder", "Partial", "Works with clear gaps", "Complete", "Complete and polished"] },
    };
    const state = `OBJECTIVE:\n${objective}\n\nDEFINITION OF DONE:\n${dod}\n\nRESULT:\n${result.slice(0, 24000)}`;
    const name = `Jev · ${j.decider.label}`;
    try {
      const res = await j.decider.decide({ state, questions });
      spent += res.costUsd ?? 0;
      emit({ type: "cost", costUsd: spent });
      const parsed = parseAnswers(res.raw, questions);
      const a = parsed.answers.meets_definition_of_done;
      const q = parsed.answers.quality;
      if (!a || a.type !== "noul") return { name, pass: false, detail: `No usable answer (${parsed.problems.join("; ") || "empty"}).` };
      const quality = q && q.type === "score" ? ` · quality ${q.score.toFixed(2)} of 4` : "";
      return { name, pass: a.p >= j.threshold, p: a.p, detail: `P(meets definition of done) = ${a.p.toFixed(2)} against ${j.threshold.toFixed(2)}${quality}` };
    } catch (e) {
      if (isAbort(e)) throw e;
      return { name, pass: false, detail: `Jev call failed: ${(e as Error).message}` };
    }
  }

  async function redTeam(result: string): Promise<Defect[] | null> {
    const r = await ask({
      messages: [{ role: "user", content: `Objective:\n${objective}\n\nDefinition of done:\n${dod}\n\nResult to attack:\n${result}` }],
      system: `You are a red team. Your job is to break this result: find real defects (bugs, crashes, missing requirements, broken edge cases, unmet parts of the definition of done). Do not invent problems; each must be concrete and checkable in the result.

Return ONLY JSON: {"defects": [{"severity": "high"|"medium"|"low", "issue": "<one sentence>"}]}
high = the definition of done is not met or it does not work; medium = works but a clear requirement or quality gap; low = polish. An empty list means you found nothing.`,
      maxTokens: 1500, signal, provider: judge.provider, model: judge.model, persona: false,
    });
    charge(r);
    return parseDefects(r.text);
  }
  let spent = 0;
  let stopped: LoopResult["stopped"] = "iterations";
  const charge = (r: AskResult) => { spent += r.costUsd; emit({ type: "cost", costUsd: spent }); };

  try {
    for (let n = 1; n <= maxIters; n++) {
      if (signal?.aborted) { stopped = "aborted"; break; }
      if (!withinCap(spent, priceCapUsd, nextIterationEstimate(iterations.map((i) => i.costUsd)))) { stopped = "price-cap"; break; }

      const t0 = performance.now();
      const before = spent;
      const ctx = learnings.length ? `\n\nWhat previous attempts established:\n${learnings.map((l, i) => `${i + 1}. ${l}`).join("\n")}` : "";

      // PLAN — the judge can take the first plan, so a strong model sets the
      // direction and a cheaper one does the volume.
      const planner = n === 1 && opts.judge?.plansFirst && opts.judge.model ? judge : producer;
      emit({ type: "phase", phase: `Iteration ${n} · planning (${label(planner)})` });
      const plan = await ask({
        messages: [{ role: "user", content: `Objective: ${objective}${ctx}` }],
        system: "You plan ONE concrete next step toward the objective. Not a roadmap: one step, the one that makes the most progress given what is already known. If the objective asks for an artifact (a file, an app, a game), the step should produce that artifact in full, not a skeleton. State it in two or three sentences, and state what observable result would show it worked.",
        maxTokens: 1500, signal, provider: planner.provider, model: planner.model,
        onDelta: (_d, f) => emit({ type: "live", text: f }),
        onReasoning: (_d, f) => emit({ type: "live", text: "", reasoning: f }),
      });
      charge(plan);

      // ACT
      emit({ type: "phase", phase: `Iteration ${n} · acting (${label(producer)})` });
      const action = await ask({
        messages: [{ role: "user", content: `Objective: ${objective}${ctx}\n\nThe step to carry out:\n${plan.text || "(the planner returned nothing; make the most progress you can toward the objective)"}` }],
        system: "Carry out the planned step and produce the actual artifact: the code, the document, the analysis. Not a description of what you would produce. Put every file in its own fenced code block, preceded by its file name on its own line. Keep deliberation short and spend your output on the artifact itself. If the step cannot be completed, say exactly what blocked it.",
        maxTokens: Math.max(ACT_MAX_TOKENS, ai.maxTokens), signal, provider: producer.provider, model: producer.model,
        onDelta: (_d, f) => emit({ type: "live", text: f }),
        onReasoning: (_d, f) => emit({ type: "live", text: "", reasoning: f }),
      });
      charge(action);

      let verdict: LoopIteration["verdict"];
      if (isEmptyResult(action.text)) {
        // Nothing to judge, so no judge call: paying a model to say "this is
        // empty" is how the reported run spent money on four identical verdicts.
        verdict = {
          pass: false,
          reason: `The model returned no result text${action.finish === "length" ? " because it hit the token limit while thinking" : ""}${action.reasoning ? ` (it produced ${action.reasoning.length.toLocaleString()} characters of hidden reasoning)` : ""}, even after a retry with more room.`,
        };
      } else {
        // VERIFY — every judge sees the objective, the definition of done and
        // the result only, never the plan: a judge shown the argument for
        // something tends to agree with it.
        const bar = opts.gauntlet ? gauntletBar(n) : null;
        const votes: JudgeVote[] = [];
        if (opts.llmJudge !== false || !opts.jevJudge) {
          emit({ type: "phase", phase: `Iteration ${n} · verifying (${label(judge)})` });
          votes.push(await llmVote(action.text));
        }
        if (opts.jevJudge) {
          emit({ type: "phase", phase: `Iteration ${n} · Jev judging (${opts.jevJudge.decider.label})` });
          votes.push(await jevVote(action.text, opts.jevJudge));
        }
        let defects: Defect[] | undefined;
        if (bar?.redTeam) {
          emit({ type: "phase", phase: `Iteration ${n} · red team (${label(judge)})` });
          const red = await redTeam(action.text);
          defects = red ?? undefined;
          votes.push(red === null
            ? { name: "Red team", pass: false, detail: "The red team's reply could not be read, so this round is not counted as survived." }
            : { name: "Red team", pass: clearsBar(red, bar.maxSeverity), detail: red.length ? `${red.length} defect(s): ${red.slice(0, 4).map((d) => `[${d.severity}] ${d.issue}`).join("; ")}` : "found no defects" });
        }
        const combined = combineVotes(votes);
        verdict = combined;
        if (judge.shared && verdict.pass && opts.llmJudge !== false && !opts.jevJudge) {
          verdict = { ...verdict, reason: `${verdict.reason} (Verified by the same model that produced it, so this is a weaker check than an independent one.)` };
        }
        pendingVotes = votes;
        pendingDefects = defects;
        pendingBar = bar?.label;
      }

      const learning = verdict.pass
        ? `Iteration ${n} passed${pendingBar ? ` the ${pendingBar} bar` : ""}: ${verdict.reason}${!shouldStop(true, { stopOnPass, gauntlet: !!opts.gauntlet, round: n }) ? " Improve on it next round without breaking what works." : ""}`
        : pendingDefects?.length
          ? `Iteration ${n} failed. Fix these defects first: ${pendingDefects.map((d) => `[${d.severity}] ${d.issue}`).join("; ")}`
        : isEmptyResult(action.text)
          ? `Iteration ${n} produced no output at all. Next time write the artifact directly with minimal deliberation.`
          : `Iteration ${n} failed verification: ${verdict.reason}`;
      learnings.push(learning);

      const iteration: LoopIteration = {
        n, plan: plan.text, action: action.text, verdict, learning,
        ms: Math.round(performance.now() - t0), costUsd: spent - before,
        planner: label(planner), actor: label(producer), rescued: action.rescued,
        votes: pendingVotes, defects: pendingDefects, bar: pendingBar, files: extractFiles(action.text),
      };
      pendingVotes = undefined;
      pendingDefects = undefined;
      pendingBar = undefined;
      iterations.push(iteration);
      emit({ type: "iteration", iteration });

      if (shouldStop(verdict.pass, { stopOnPass, gauntlet: !!opts.gauntlet, round: n })) { stopped = "converged"; break; }
      if (ai.budgetUsd > 0 && useSettings.getState().ai.spentUsd >= ai.budgetUsd) { stopped = "budget"; break; }
    }
  } catch (e) {
    if (isAbort(e)) stopped = "aborted";
    else if (isBudget(e)) stopped = "budget";
    else throw e;
  }

  const final = await finalize();
  return { iterations, final: { ...final, files: filesOf(final.text) }, costUsd: spent, stopped };

  async function finalize(): Promise<{ text: string; source: LoopResult["final"]["source"]; by?: string }> {
    const picked = pickResult(iterations);
    const wantsPass = Boolean(opts.judge?.finalPass && opts.judge.model);
    // The final pass runs when the user asked for it, or when there is nothing
    // to return. The second case ignores the price cap on purpose: one call to
    // turn a paid-for empty run into a result is the whole point of the
    // guarantee. It never runs after an abort or a spent global budget.
    const mustPass = !picked && stopped !== "aborted" && stopped !== "budget";
    const mayPass = wantsPass && stopped !== "aborted" && stopped !== "budget" && withinCap(spent, priceCapUsd, nextIterationEstimate(iterations.map((i) => i.costUsd)));
    if (mustPass || mayPass) {
      const finisher = wantsPass ? judge : producer;
      emit({ type: "phase", phase: `Final pass (${label(finisher)})` });
      try {
        const history = iterations.map((it) => `### Attempt ${it.n}\nPlan: ${it.plan}\nVerifier: ${it.verdict?.reason ?? "-"}${it.action ? `\nResult:\n${it.action.slice(0, 12000)}` : "\nResult: (empty)"}`).join("\n\n");
        const pass = await ask({
          messages: [{ role: "user", content: `Objective:\n${objective}\n\n${picked ? `Best result so far (attempt ${picked.n}, ${picked.source}):\n${picked.text}\n\n` : ""}Everything the loop tried:\n${history || "(nothing yet)"}` }],
          system: "You write the final deliverable for this objective, in full, now. Use what the attempts established and fix what the verifier said was missing. Output the complete artifact itself: every file in its own fenced code block, preceded by its file name on its own line. No plans, no apologies, no placeholders.",
          maxTokens: Math.max(ACT_MAX_TOKENS, ai.maxTokens), signal, provider: finisher.provider, model: finisher.model,
          onDelta: (_d, f) => emit({ type: "live", text: f }),
          onReasoning: (_d, f) => emit({ type: "live", text: "", reasoning: f }),
        });
        charge(pass);
        if (!isEmptyResult(pass.text)) return { text: pass.text, source: "final-pass", by: label(finisher) };
      } catch (e) {
        if (!isAbort(e) && !isBudget(e)) {
          if (picked) return { text: picked.text, source: picked.source };
          return { text: fallbackReport(objective, iterations, `The final pass failed: ${(e as Error).message}`), source: "fallback" };
        }
      }
    }
    if (picked) return { text: picked.text, source: picked.source };
    const why = stopped === "aborted" ? "The run was stopped before any attempt produced output."
      : stopped === "budget" ? "The global AI budget in Settings ran out before any attempt produced output."
      : "Every attempt, and the final pass, came back empty.";
    return { text: fallbackReport(objective, iterations, why), source: "fallback" };
  }
}

function filesOf(text: string): LoopFile[] {
  return extractFiles(text);
}
