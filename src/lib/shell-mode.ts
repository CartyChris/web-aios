/* Which shell a screen gets: the single-app phone view or the full desktop.
 *
 * Width alone is the wrong test. A phone turned on its side is often still
 * under the 768px tablet line, so a width rule keeps it in the phone view
 * forever — exactly when the user has rotated it to get more room. The short
 * side of the screen is what identifies a phone; orientation says what the
 * user wants right now.
 *
 * Pure on purpose: no DOM, no clock, so the rule is pinned by tests. */

export type PhoneMode = "auto" | "desktop" | "phone";
export type ShellKind = "mobile" | "desktop";

export interface ShellInput {
  w: number;
  h: number;
  /** Coarse pointer — a finger rather than a mouse. */
  touch: boolean;
}

/** Below this, floating windows are unusable (matches useViewport's PHONE_MAX). */
export const PHONE_MAX = 768;

export function isPhoneMode(v: unknown): v is PhoneMode {
  return v === "auto" || v === "desktop" || v === "phone";
}

/** The screen's shorter side. Rotation swaps w and h but never changes this. */
export function shortSide(v: ShellInput): number {
  return Math.min(v.w, v.h);
}

/** A handset: touch-driven and small on its short side, whichever way up. */
export function isPhoneHardware(v: ShellInput): boolean {
  return v.touch && shortSide(v) < PHONE_MAX;
}

export function isLandscape(v: ShellInput): boolean {
  return v.w > v.h;
}

/** The decision.
 *
 *  - "phone":   always the phone view.
 *  - "desktop": always the full desktop, even upright.
 *  - "auto":    a phone held upright gets the phone view; the same phone on its
 *               side gets the full desktop. A narrow non-phone window (a
 *               squeezed desktop browser) keeps the old width rule. */
export function chooseShell(mode: PhoneMode | string | undefined, v: ShellInput): ShellKind {
  const m: PhoneMode = isPhoneMode(mode) ? mode : "auto";
  if (m === "phone") return "mobile";
  if (m === "desktop") return "desktop";
  if (isPhoneHardware(v) && isLandscape(v)) return "desktop";
  return v.w < PHONE_MAX ? "mobile" : "desktop";
}

/** Whether to offer a "Phone view" way back from the desktop: only on a real
 *  phone that was forced into the desktop by the setting. */
export function offerPhoneView(mode: PhoneMode | string | undefined, v: ShellInput): boolean {
  return mode === "desktop" && isPhoneHardware(v);
}
