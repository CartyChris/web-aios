"use client";

import { create } from "zustand";
import type { Span } from "@/lib/harness/types";

/* ────────────────────────────────────────────────────────────────────────────
   The span ring, owned by the OS rather than by one window.

   Observatory kept its spans in component state, so closing the window threw
   away the trace — and the run you most want to look at afterwards is exactly
   the one that went wrong while you were doing something else. Moving the ring
   here makes the record outlive the window that reads it.

   Deliberately NOT persisted. A few hundred spans carry every prompt and every
   observation, and `kernel/harness.ts` already explains what a few dozen of
   those do to a shared localStorage quota. This survives a window close, which
   is the thing that was actually losing data; a trace that must survive a
   reload is written to the VFS at /harness/runs/<id>.md with keys redacted.
   ──────────────────────────────────────────────────────────────────────────── */

/** Bounded because a long session emits one span per model call forever. */
export const SPAN_RING = 600;

interface SpanState {
  spans: Span[];
  /** Upsert by id: `ask()` writes a span open BEFORE the request and closed
   *  after, with the same id, so a call that hangs or throws is still visible.
   *  Appending instead of upserting would double every span in the tree. */
  record: (span: Span) => void;
  clear: () => void;
  /** Spans belonging to one run, oldest first. */
  forRun: (runId: string) => Span[];
}

export const useSpans = create<SpanState>()((set, get) => ({
  spans: [],
  record: (span) =>
    set((s) => {
      const at = s.spans.findIndex((x) => x.id === span.id);
      if (at === -1) return { spans: [...s.spans, span].slice(-SPAN_RING) };
      const next = s.spans.slice();
      // Merge rather than replace: the closing write carries the result, the
      // opening one carries the start time and the parent.
      next[at] = { ...next[at], ...span };
      return { spans: next };
    }),
  clear: () => set({ spans: [] }),
  forRun: (runId) => get().spans.filter((s) => s.runId === runId),
}));

/** Subscribe the ring to the bus. Called once by the shell at boot, so a run
 *  started by a trigger while every window is shut is still recorded.
 *  Idempotent — a StrictMode double-mount must not double-subscribe. */
let subscribed = false;
export function installSpanRecorder(bus: { on: (event: string, fn: (payload: unknown) => void) => () => void }): () => void {
  if (subscribed) return () => {};
  subscribed = true;
  const off = bus.on("span", (p) => {
    const span = p as Span;
    if (span?.id) useSpans.getState().record(span);
  });
  return () => { subscribed = false; off(); };
}
