/* ────────────────────────────────────────────────────────────────────────────
   A timed trial of a system update: "Keep changes? Reverting in 15s".

   PURE. The same contract a display-resolution change has: the update is
   applied for real, and unless the user says Keep before the timer runs out,
   it is reverted. Silence means revert, because the case this protects
   against is the one where the user cannot read or reach the Keep button.
   ──────────────────────────────────────────────────────────────────────────── */

export const TRIAL_MS = 15_000;

export interface Trial {
  versionId: string;
  title: string;
  startedAt: number;
  endsAt: number;
}

export function startTrial(versionId: string, title: string, now: number, ms = TRIAL_MS): Trial {
  const span = Math.max(1000, Math.min(120_000, Math.round(ms)));
  return { versionId, title, startedAt: now, endsAt: now + span };
}

/** Whole seconds left, rounded UP so the bar never shows 0 while it still
 *  has time — "0s" and then another second of waiting reads as a bug. */
export function secondsLeft(t: Trial, now: number): number {
  return Math.max(0, Math.ceil((t.endsAt - now) / 1000));
}

/** 1 at the start, 0 when it expires. */
export function fractionLeft(t: Trial, now: number): number {
  const span = t.endsAt - t.startedAt;
  if (span <= 0) return 0;
  return Math.max(0, Math.min(1, (t.endsAt - now) / span));
}

export const isExpired = (t: Trial, now: number) => now >= t.endsAt;

export type TrialDecision = "keep" | "revert" | "expired";

/** What happens to the version at the end. Only an explicit keep keeps it. */
export function outcome(decision: TrialDecision): "kept" | "reverted" {
  return decision === "keep" ? "kept" : "reverted";
}
