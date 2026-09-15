"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { RunResult, RunStatus, DefinitionOfDone, EvalTask } from "@/lib/harness/types";
import { DOD_EXPLORATORY } from "@/lib/harness/config";

/* ────────────────────────────────────────────────────────────────────────────
   What the OS remembers about harness runs.

   Only the head of each run lives here. A trace carries every prompt and every
   observation, and a few dozen of those will exhaust the origin's localStorage
   quota — taking unrelated stores down with it, because the quota is shared.
   Full traces are written to the VFS under /harness/runs/ and this store keeps
   the summary plus the path, which is also what makes a trace survive a tab
   close: a receipt you lose on reload is not a receipt.
   ──────────────────────────────────────────────────────────────────────────── */

export interface RunSummary {
  runId: string;
  objective: string;
  status: RunStatus;
  answer: string;
  pass: boolean | null;
  /** Criterion ids still waiting on a named person. */
  pendingHuman: string[];
  steps: number;
  costUsd: number;
  ms: number;
  flags: string[];
  startedAt: number;
  /** Where the full trace lives in the VFS. */
  tracePath: string;
}

interface HarnessState {
  runs: RunSummary[];
  /** Definitions of done a person wrote, reusable across runs. */
  dods: DefinitionOfDone[];
  /** The golden set. Corrections land here and never leave. */
  tasks: EvalTask[];
  record: (r: RunResult, tracePath: string) => void;
  saveDod: (d: DefinitionOfDone) => void;
  removeDod: (id: string) => void;
  addTask: (t: EvalTask) => void;
  removeTask: (id: string) => void;
  clearRuns: () => void;
}

export const summarise = (r: RunResult, tracePath: string): RunSummary => ({
  runId: r.runId,
  objective: r.objective,
  status: r.status,
  answer: r.answer,
  pass: r.verdict ? r.verdict.pass : null,
  pendingHuman: r.verdict?.pendingHuman ?? [],
  steps: r.totals.steps,
  costUsd: r.totals.costUsd,
  ms: r.totals.ms,
  flags: r.flags.map((f) => f.code),
  startedAt: r.startedAt,
  tracePath,
});

export const useHarness = create<HarnessState>()(
  persist(
    (set) => ({
      runs: [],
      dods: [DOD_EXPLORATORY],
      tasks: [],
      // Capped at write time. An unbounded ledger is the thing that eventually
      // breaks an unrelated feature by filling the quota.
      record: (r, tracePath) => set((s) => ({ runs: [summarise(r, tracePath), ...s.runs].slice(0, 200) })),
      saveDod: (d) => set((s) => ({ dods: [d, ...s.dods.filter((x) => x.id !== d.id)] })),
      removeDod: (id) => set((s) => ({ dods: s.dods.filter((x) => x.id !== id) })),
      addTask: (t) => set((s) => ({ tasks: [t, ...s.tasks.filter((x) => x.id !== t.id)] })),
      removeTask: (id) => set((s) => ({ tasks: s.tasks.filter((x) => x.id !== id) })),
      clearRuns: () => set({ runs: [] }),
    }),
    { name: "webaios.harness.v1", storage: createJSONStorage(() => localStorage) },
  ),
);
