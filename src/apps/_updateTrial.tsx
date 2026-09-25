"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { useUpdates } from "@/kernel/updates";
import { bus } from "@/kernel/bus";
import { startTrial, secondsLeft, fractionLeft, outcome, TRIAL_MS, type Trial, type TrialDecision } from "@/lib/trial";
import { Icon } from "@/shell/icons";

/* "Keep these changes?" for a system update, the way a display-resolution
 * change asks: the update is applied for real, a bar counts down over the
 * whole OS, and unless Keep is pressed the update is reverted when it hits
 * zero. The timer lives at module scope, not in a component, so closing the
 * Updates window mid-trial still reverts on time rather than stranding the
 * change half-decided. */

interface TrialState {
  trial: Trial | null;
  last: { title: string; result: "kept" | "reverted"; skipped: number } | null;
  start: (versionId: string, title: string) => void;
  decide: (d: TrialDecision) => void;
}

let timer: ReturnType<typeof setTimeout> | null = null;

export const useUpdateTrial = create<TrialState>()((set, get) => ({
  trial: null,
  last: null,
  start: (versionId, title) => {
    const prev = get().trial;
    if (prev) get().decide("revert");
    const t = startTrial(versionId, title, Date.now(), TRIAL_MS);
    set({ trial: t, last: null });
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => get().decide("expired"), t.endsAt - Date.now());
  },
  decide: (d) => {
    const t = get().trial;
    if (!t) return;
    if (timer) { clearTimeout(timer); timer = null; }
    const result = outcome(d);
    let skipped = 0;
    if (result === "reverted") skipped = useUpdates.getState().revert(t.versionId).skipped.length;
    set({ trial: null, last: { title: t.title, result, skipped } });
    bus.emit("notify", {
      title: result === "kept" ? `Kept "${t.title}"` : `Reverted "${t.title}"`,
      body: d === "expired" ? "No answer before the timer ran out, so it was put back." : undefined,
      kind: result === "kept" ? "success" : "info",
    });
  },
}));

/** The countdown bar. Portalled to <body> so it sits over every window. */
export function TrialBar() {
  const trial = useUpdateTrial((s) => s.trial);
  const decide = useUpdateTrial((s) => s.decide);
  const [tick, setNow] = useState(0);

  useEffect(() => {
    if (!trial) return;
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, [trial]);

  if (!trial || typeof document === "undefined") return null;
  // Before the first tick, the trial has only just started.
  const now = Math.max(tick, trial.startedAt);
  const secs = secondsLeft(trial, now);
  const frac = fractionLeft(trial, now);

  return createPortal(
    <div
      role="alertdialog"
      aria-live="assertive"
      aria-label={`Keep the update ${trial.title}? Reverting in ${secs} seconds`}
      className="glass fixed left-1/2 top-3 z-[9900] w-[min(30rem,calc(100vw-1rem))] -translate-x-1/2 overflow-hidden shadow-2xl"
      style={{ borderRadius: "var(--radius)" }}
    >
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <Icon name="sparkles" size={14} style={{ color: "var(--accent)" }} />
        <div className="min-w-0 flex-1 text-[12px]">
          <div className="truncate font-medium">Trying &ldquo;{trial.title}&rdquo;</div>
          <div className="text-[10.5px] text-[var(--muted)] tabular-nums">Keep these changes? Reverting in {secs}s</div>
        </div>
        <button className="os-btn !py-1 text-[11px]" onClick={() => decide("revert")}>
          <Icon name="refresh" size={11} className="mr-1" />Revert now
        </button>
        <button className="os-btn !py-1 text-[11px]" data-variant="primary" onClick={() => decide("keep")}>
          <Icon name="check" size={11} className="mr-1" />Keep
        </button>
      </div>
      <div className="h-1 w-full bg-[var(--border)]">
        <div className="h-full bg-[var(--accent)]" style={{ width: `${Math.round(frac * 1000) / 10}%`, transition: "width 200ms linear" }} />
      </div>
    </div>,
    document.body,
  );
}
