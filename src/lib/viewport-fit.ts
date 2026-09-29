/* ────────────────────────────────────────────────────────────────────────────
   Does the OS fill the screen? A diagnosis from measurements.

   Measured on the iOS 27 simulator (iPhone Air, 420 x 912, added to the Home
   Screen) with a probe page, 2026-09-28:

   - "black-translucent" status bar: the page is laid out 844 px tall from the
     very top of the screen. The bottom 68 px (the top inset) get only the
     page's background colour: no element, fixed or not, and not 100lvh, is
     drawn there. The top 68 px sit under a blurred status bar that swallows
     taps (taps at y=30 and y=55 never reached the page; y=100 did). WebKit
     bug 301108.
   - "default" (opaque) status bar: the page starts BELOW the status bar and
     runs to the bottom edge: 844 px, no gap, safe-area-inset-top 0, and the
     status-bar strip takes the page's background colour.
   - iOS freezes the style when the app is added to the Home Screen: serving a
     different meta to an installed app changes nothing. It has to be removed
     and added again.

   So nothing can stretch over the band (an earlier version of this file tried,
   which would only have pushed the dock off the screen). The fix is the
   opaque bar; this file recognises which situation a device is in and says
   what to do about it. It is the only place those rules live.

   PURE. No DOM.
   ──────────────────────────────────────────────────────────────────────────── */

export interface ViewportSample {
  /** screen.width / screen.height in CSS px (iOS reports the portrait pair). */
  screenW: number;
  screenH: number;
  innerW: number;
  innerH: number;
  /** env(safe-area-inset-top / bottom), in px. */
  safeTop: number;
  safeBottom: number;
  /** Installed web app (display-mode standalone/fullscreen, or navigator.standalone). */
  standalone: boolean;
  /** An iPhone/iPad WebKit. */
  ios: boolean;
  statusBar: StatusBarPref;
}

export type StatusBarPref = "translucent" | "solid";
export type FitKind = "fits" | "status-bar" | "ios-top-inset-gap" | "browser-tab" | "windowed" | "short";

export interface FitVerdict {
  kind: FitKind;
  /** Screen height (for the current orientation) minus the reported viewport height. */
  gap: number;
  /** Always null: the band is outside what a page can draw (see above). Kept
   *  so older callers keep compiling; nothing may stretch the OS root. */
  fillHeight: null;
  /** The installed app has to be removed and added to the Home Screen again. */
  reinstall: boolean;
  advice: string;
}

/** "solid" is Apple's "default": the opaque bar that was measured to leave no
 *  gap. ("black" was never measured, and is documented as black symbols on a
 *  black bar, which would hide the clock.) */
export const STATUS_BAR_META: Record<StatusBarPref, string> = {
  translucent: "black-translucent",
  solid: "default",
};

/** New installs get the bar that fills the screen. */
export const DEFAULT_STATUS_BAR: StatusBarPref = "solid";

export function isStatusBarPref(v: unknown): v is StatusBarPref {
  return v === "translucent" || v === "solid";
}

/** Screen height for the orientation the page is in: iOS always reports portrait. */
export function orientedScreenHeight(s: Pick<ViewportSample, "screenW" | "screenH" | "innerW" | "innerH">): number {
  const long = Math.max(s.screenW, s.screenH), short = Math.min(s.screenW, s.screenH);
  return s.innerW > s.innerH ? short : long;
}

const TOLERANCE = 2;
/** The tallest a status bar gets (Dynamic Island portrait is 59-68 px). */
const MAX_STATUS_BAR = 80;

export function diagnoseViewport(s: ViewportSample): FitVerdict {
  const screenH = orientedScreenHeight(s);
  const gap = Math.round(screenH - s.innerH);
  const out = (kind: FitKind, advice: string, reinstall = false): FitVerdict => ({ kind, gap: Math.max(0, gap), fillHeight: null, reinstall, advice });

  if (!s.standalone) {
    return out("browser-tab", "In a browser tab the toolbars take their own space; nothing to fix. Add to Home Screen for the full screen.");
  }
  if (gap <= TOLERANCE) return out("fits", "The OS fills the screen.");
  // A window smaller than the screen (iPad Stage Manager, an installed desktop
  // PWA) is not a bug.
  if (!s.ios || gap > Math.max(120, s.safeTop * 2 + TOLERANCE)) {
    return out("windowed", "The app is in a window smaller than the screen; it fills the window.");
  }
  // The iOS 26+ signature: short by exactly the top inset. It depends on how
  // the app was INSTALLED, not on today's setting, so it is read from the
  // numbers alone.
  if (s.safeTop > 0 && Math.abs(gap - s.safeTop) <= TOLERANCE) {
    return out(
      "ios-top-inset-gap",
      s.statusBar === "solid"
        ? `iOS leaves a ${gap}px band at the bottom because this copy was added to the Home Screen with the see-through status bar, and iOS keeps that choice. Remove Web-AIOS from the Home Screen, then add it again from Safari: it will fill the screen.`
        : `The see-through status bar makes iOS leave a ${gap}px band at the bottom (an iOS bug). Choose Standard below, then remove Web-AIOS from the Home Screen and add it again from Safari.`,
      true,
    );
  }
  // The opaque bar: the page starts below it, so the page is the screen minus
  // the bar and there is no inset. That is the app filling the screen.
  if (s.safeTop <= TOLERANCE && gap <= MAX_STATUS_BAR) {
    return out("status-bar", `The status bar sits above the app (${gap}px) and the app fills the rest of the screen.`);
  }
  return out("short", `The screen reports ${gap}px more than the page gets. Remove Web-AIOS from the Home Screen and add it again from Safari.`, true);
}
