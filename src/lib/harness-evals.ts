"use client";

import { useSettings } from "@/kernel/settings";
import { useVFS } from "@/kernel/vfs";
import { useHarness } from "@/kernel/harness";
import { registerAiosModule } from "./aios-api";
import { startRun } from "./harness-runtime";
import { runSuite, suiteToMarkdown, diffAgainstBaseline, fingerprint, validateTask } from "./harness/evals";
import { SEED_TASKS } from "./harness/tasks";
import { DEFAULT_LOOP_CONFIG } from "./harness/config";
import { createRegistry, builtinTools, toolCatalogueText } from "./harness/tools";
import { FIXTURES } from "./harness/fixtures";
import type {
  EvalBaseline, EvalDelta, EvalSuiteResult, EvalTask, RunResult,
} from "./harness/types";

/* ────────────────────────────────────────────────────────────────────────────
   The golden set, finally with a caller.

   `evals.ts` and `tasks.ts` have been complete and tested for sessions —
   `runSuite`, `diffAgainstBaseline`, `suiteToMarkdown`, a seed set with a
   mandatory anti-case on every task — and nothing in the app called any of it.
   A suite runner nobody runs is the same as no suite runner, except it looks
   like coverage.

   Two things this binding is careful about, both of which come from `ask()`
   rather than from the evals module:

   - Spend. `ask()` commits cost globally and its own budget stop THROWS, so a
     suite that checked the budget once before starting would discover the
     ceiling by having a run die mid-flight and lose its trace. `budgetStopped`
     is checked before every dispatch instead.
   - Concurrency. The default is ONE. A golden set is N tasks times (1 main +
     1 anti + repeats) model calls; fanning that out is how a verification run
     becomes the most expensive thing the OS has ever done.
   ──────────────────────────────────────────────────────────────────────────── */

/** Conservative by default. Raising it multiplies spend, not just speed. */
export const DEFAULT_EVAL_CONCURRENCY = 1;

export interface RunSuiteOptions {
  tasks?: EvalTask[];
  concurrency?: number;
  baseline?: EvalBaseline | null;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, taskId: string) => void;
}

/** The surface fingerprint: prompt shape plus tool catalogue plus fixtures.
 *  A baseline taken against a different surface is not comparable, and
 *  `runSuite` marks the result `surfaceChanged` when it differs. */
export function currentFingerprint(): string {
  const registry = createRegistry();
  for (const t of builtinTools({ fixtures: FIXTURES })) registry.register(t);
  const cfg = DEFAULT_LOOP_CONFIG;
  return fingerprint({
    toolSignature: registry.signature(),
    promptFingerprint: String(toolCatalogueText(registry.list()).length),
    fixtureVersion: FIXTURES.version,
    // The model belongs in the digest: the same tasks against a different
    // model are a different measurement, and a baseline that ignored it would
    // report a model swap as "unchanged".
    configDigest: `${cfg.id}:${cfg.maxSteps}:${cfg.thoughtDensity}:${useSettings.getState().ai.model}`,
  });
}

/** Everything shipped, plus anything a correction added. Corrections land in
 *  the store and never leave — a golden set that forgets a past failure will
 *  let it back in. */
export function allTasks(): EvalTask[] {
  const saved = useHarness.getState().tasks;
  const seen = new Set(saved.map((t) => t.id));
  return [...saved, ...SEED_TASKS.filter((t) => !seen.has(t.id))];
}

export async function runGoldenSet(opts: RunSuiteOptions = {}): Promise<EvalSuiteResult> {
  const tasks = opts.tasks ?? allTasks();
  let done = 0;

  const result = await runSuite(
    tasks,
    {
      runOne: async (objective, task): Promise<RunResult> => {
        const run = await startRun({
          objective,
          dod: task.dod,
          config: task.configPatch,
          signal: opts.signal,
          // An eval task must reach the same tools every time or its result is
          // not comparable across runs. The live services are deliberately
          // excluded: a task whose answer depends on today's exchange rate
          // cannot be a regression test.
          webServices: [],
        });
        done += 1;
        opts.onProgress?.(done, tasks.length * 2, task.id);
        return run;
      },
      // No judge. The only model configured is the one under test, and a
      // verifier running the producer's own weights agrees with it — which
      // looks exactly like success. Fixed criteria only, and the report says so.
      judge: null,
      now: () => Date.now(),
      budgetStopped: () => {
        if (opts.signal?.aborted) return "the run was aborted";
        const s = useSettings.getState().ai;
        if (s.budgetUsd > 0 && s.spentUsd >= s.budgetUsd) {
          return `the $${s.budgetUsd.toFixed(2)} budget is already spent ($${s.spentUsd.toFixed(4)})`;
        }
        return null;
      },
    },
    {
      concurrency: opts.concurrency ?? DEFAULT_EVAL_CONCURRENCY,
      baseline: opts.baseline ?? null,
      fingerprint: currentFingerprint(),
    },
  );

  // The report goes to the VFS, where it outlives the window — same reasoning
  // as a run receipt. Keys are already absent from a suite report, which
  // carries verdicts and totals rather than prompts.
  try {
    useVFS.getState().write(
      `/harness/evals/${new Date(result.startedAt).toISOString().slice(0, 19).replace(/[:T]/g, "")}.md`,
      suiteToMarkdown(result),
      { appId: "harness" },
    );
  } catch {
    // A report we could not store does not invalidate the suite that produced it.
  }

  return result;
}

/** A baseline is a snapshot of what "unchanged" means. Taking one from a red
 *  suite would pin the failures as expected, so this refuses. */
export function baselineFrom(result: EvalSuiteResult): { ok: true; baseline: EvalBaseline } | { ok: false; reason: string } {
  if (!result.green) {
    return {
      ok: false,
      reason: "This suite is not green. A baseline taken from a failing run makes those failures the expected state, and the next comparison will call them unchanged.",
    };
  }
  const perTask: EvalBaseline["perTask"] = {};
  for (const r of result.results) {
    perTask[r.taskId] = { pass: r.pass, costUsd: r.totals.costUsd, steps: r.totals.steps, ms: r.ms };
  }
  return { ok: true, baseline: { fingerprint: result.fingerprint, at: result.startedAt, perTask } };
}

export function compare(result: EvalSuiteResult, baseline: EvalBaseline | null): EvalDelta[] {
  return baseline ? diffAgainstBaseline(result, baseline) : [];
}

/** Which of the tasks on file would be refused before running. Shown up front,
 *  because a task rejected at registration is a task silently not covering
 *  anything. */
export function invalidTasks(): Array<{ id: string; title: string; reasons: string[] }> {
  const out: Array<{ id: string; title: string; reasons: string[] }> = [];
  for (const t of allTasks()) {
    const gate = validateTask(t);
    if (!gate.ok) out.push({ id: t.id, title: t.title, reasons: gate.reasons });
  }
  return out;
}

export function installEvals() {
  registerAiosModule("evals", {
    run: runGoldenSet,
    tasks: allTasks,
    invalid: invalidTasks,
    fingerprint: currentFingerprint,
    baselineFrom,
    compare,
  });
}
