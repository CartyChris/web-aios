/** What the screen gives the OS, measured.
 *
 *  lib/viewport-fit.ts decides (pure, tested) whether an installed iPhone app
 *  is losing a band to the iOS 26+ status-bar bug; this reads the numbers and
 *  keeps the verdict current across rotation and resize. It also publishes the
 *  safe-area insets in px (safeArea()), for the code that lays windows out in
 *  pixels (wm.workArea): the CSS reads the same insets through --sa-*.
 *
 *  Nothing here stretches the OS any more: the band is outside the page.
 */
import { diagnoseViewport, isStatusBarPref, type FitVerdict, type ViewportSample } from "@/lib/viewport-fit";

let verdict: FitVerdict | null = null;
let sample: ViewportSample | null = null;

export interface Insets { top: number; right: number; bottom: number; left: number }
const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
let insets: Insets = NO_INSETS;

function safeInsets(): Insets {
  // env() is only readable through a styled element.
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)";
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const px = (v: string) => Math.max(0, Math.round(parseFloat(v) || 0));
  const out = { top: px(cs.paddingTop), right: px(cs.paddingRight), bottom: px(cs.paddingBottom), left: px(cs.paddingLeft) };
  probe.remove();
  return out;
}

/** The safe-area insets in px, as last measured (zeros before the first). */
export const safeArea = (): Insets => insets;

/** Measure the insets now (rotation changes them) and remember them. */
export function readSafeArea(): Insets {
  if (typeof document === "undefined" || !document.body) return insets;
  insets = safeInsets();
  return insets;
}

export function readStatusBarPref(): "translucent" | "solid" {
  try {
    const v = (JSON.parse(localStorage.getItem("webaios.settings.v1") || "{}") as { state?: { statusBar?: unknown } }).state?.statusBar;
    return isStatusBarPref(v) ? v : "translucent";
  } catch {
    return "translucent";
  }
}

export function measureViewport(): ViewportSample {
  const nav = navigator as Navigator & { standalone?: boolean };
  const ins = safeInsets();
  insets = ins;
  return {
    screenW: screen.width,
    screenH: screen.height,
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    safeTop: ins.top,
    safeBottom: ins.bottom,
    standalone: nav.standalone === true || matchMedia("(display-mode: standalone)").matches || matchMedia("(display-mode: fullscreen)").matches,
    ios: /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1),
    statusBar: readStatusBarPref(),
  };
}

function apply() {
  sample = measureViewport();
  verdict = diagnoseViewport(sample);
  const root = document.documentElement;
  root.dataset.displayMode = sample.standalone ? "standalone" : "browser";
  root.dataset.screenFit = verdict.kind;
}

let installed = false;
export function installViewportFit() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  apply();
  const again = () => apply();
  window.addEventListener("resize", again);
  window.addEventListener("orientationchange", () => setTimeout(again, 250));
}

/** The OS's usable height in px: what the browser says (the visual viewport,
 *  so an on-screen keyboard shrinks it). */
export function appHeight(): number {
  if (typeof window === "undefined") return 900;
  return Math.round(window.visualViewport?.height ?? window.innerHeight);
}

export const viewportReport = (): { sample: ViewportSample | null; verdict: FitVerdict | null } => ({ sample, verdict });
