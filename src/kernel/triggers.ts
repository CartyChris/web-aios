"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { TriggerSpec } from "@/lib/harness/types";
import type { FireDecision } from "@/lib/harness/triggers";

/* ────────────────────────────────────────────────────────────────────────────
   What the OS remembers about triggers.

   The `attempts` ledger is the point of this store, more than the specs are. A
   trigger layer's characteristic failure is silence, and the only way to tell
   a trigger that has never matched from one that matched and was suppressed is
   to write down every decision — including the declines, with their reason.
   Without that, debugging a trigger is guessing.
   ──────────────────────────────────────────────────────────────────────────── */

export interface TriggerAttempt {
  id: string;
  triggerId: string;
  at: number;
  fired: boolean;
  /** The refusal reason, or "fired". */
  reason: string;
  detail: string;
  /** The rendered objective, when it fired. */
  objective?: string;
  runId?: string;
}

interface TriggerState {
  triggers: TriggerSpec[];
  attempts: TriggerAttempt[];
  /** Master switch. Off by default: an OS that starts spending on model calls
   *  the moment it boots is not one you can leave open in a tab. */
  armed: boolean;
  save: (t: TriggerSpec) => void;
  remove: (id: string) => void;
  setEnabled: (id: string, enabled: boolean) => void;
  setArmed: (armed: boolean) => void;
  recordAttempt: (a: TriggerAttempt) => void;
  /** Bump the counters after a decision. Pure computation first, commit after:
   *  a state updater must never call another setState. */
  markFired: (id: string, at: number) => void;
  clearAttempts: () => void;
}

export const useTriggers = create<TriggerState>()(
  persist(
    (set) => ({
      triggers: [],
      attempts: [],
      armed: false,
      save: (t) => set((s) => ({ triggers: [t, ...s.triggers.filter((x) => x.id !== t.id)].slice(0, 100) })),
      remove: (id) => set((s) => ({ triggers: s.triggers.filter((x) => x.id !== id) })),
      setEnabled: (id, enabled) =>
        set((s) => ({ triggers: s.triggers.map((x) => (x.id === id ? { ...x, enabled } : x)) })),
      setArmed: (armed) => set({ armed }),
      // Capped at write time, like every growing array in this codebase.
      recordAttempt: (a) => set((s) => ({ attempts: [a, ...s.attempts].slice(0, 300) })),
      markFired: (id, at) =>
        set((s) => ({
          triggers: s.triggers.map((x) => (x.id === id ? { ...x, firedCount: x.firedCount + 1, lastFiredAt: at } : x)),
        })),
      clearAttempts: () => set({ attempts: [] }),
    }),
    { name: "webaios.triggers.v1", storage: createJSONStorage(() => localStorage) },
  ),
);

/** Turn a decision into the attempt record the UI reads. */
export function attemptFrom(id: string, triggerId: string, at: number, d: FireDecision): TriggerAttempt {
  return d.fire
    ? { id, triggerId, at, fired: true, reason: "fired", detail: "Matched and admitted.", objective: d.objective }
    : { id, triggerId, at, fired: false, reason: d.reason, detail: d.detail };
}
