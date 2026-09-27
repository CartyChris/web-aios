/* ────────────────────────────────────────────────────────────────────────────
   Does the OS fill the screen? A diagnosis from measurements.

   iOS 26 installed web apps (Add to Home Screen) with the "black-translucent"
   status bar and viewport-fit=cover draw from the very top of the screen but
   report a viewport that is short by exactly the top safe-area inset, so a
   band the height of the status bar is left at the BOTTOM. WebKit bug 301108,
   open as of 2026-09. innerHeight, 100vh, 100svh and 100dvh are all short;
   100lvh is reported to be full height.

   This file decides, from numbers the page can read, whether that is what is
   happening, how tall the OS root should be to cover it, and what to tell the
   person. It is the only place those rules live, so they can be tested.

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
export type FitKind = "fits" | "ios-top-inset-gap" | "browser-tab" | "windowed" | "short";

export interface FitVerdict {
  kind: FitKind;
  /** Screen height (for the current orientation) minus the reported viewport height. */
  gap: number;
  /** The height the OS root should use, in px, or null to leave it to CSS. */
  fillHeight: number | null;
  advice: string;
}

export const STATUS_BAR_META: Record<StatusBarPref, string> = {
  translucent: "black-translucent",
  solid: "black",
};

export function isStatusBarPref(v: unknown): v is StatusBarPref {
  return v === "translucent" || v === "solid";
}

/** Screen height for the orientation the page is in: iOS always reports portrait. */
export function orientedScreenHeight(s: Pick<ViewportSample, "screenW" | "screenH" | "innerW" | "innerH">): number {
  const long = Math.max(s.screenW, s.screenH), short = Math.min(s.screenW, s.screenH);
  return s.innerW > s.innerH ? short : long;
}

const TOLERANCE = 2;

export function diagnoseViewport(s: ViewportSample): FitVerdict {
  const screenH = orientedScreenHeight(s);
  const gap = Math.round(screenH - s.innerH);

  if (!s.standalone) {
    return { kind: "browser-tab", gap, fillHeight: null, advice: "In a browser tab the toolbars take their own space; nothing to fix. Add to Home Screen for the full screen." };
  }
  if (gap <= TOLERANCE) {
    return { kind: "fits", gap: Math.max(0, gap), fillHeight: null, advice: "The OS fills the screen." };
  }
  // A window smaller than the screen (iPad Stage Manager, an installed desktop
  // PWA) is not a bug, and stretching to the screen would push the dock off it.
  if (!s.ios || gap > Math.max(120, s.safeTop * 2 + TOLERANCE)) {
    return { kind: "windowed", gap, fillHeight: null, advice: "The app is in a window smaller than the screen; it fills the window." };
  }
  // The iOS 26 signature: short by the top inset, with the translucent bar.
  if (s.statusBar === "translucent" && s.safeTop > 0 && Math.abs(gap - s.safeTop) <= TOLERANCE) {
    return {
      kind: "ios-top-inset-gap",
      gap,
      fillHeight: Math.round(s.innerH + gap),
      advice: `iOS reports the screen ${gap}px short (the status-bar height, a known iOS 26 bug). The OS now stretches to cover it. If a dark band still shows at the bottom, set the status bar to Solid and reopen the app from the Home Screen.`,
    };
  }
  return { kind: "short", gap, fillHeight: null, advice: `The screen reports ${gap}px more than the page gets. Try the Solid status bar and reopen the app from the Home Screen.` };
}
