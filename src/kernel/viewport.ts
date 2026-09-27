/** The height the OS actually has, after the iOS 26 installed-app gap.
 *
 *  lib/viewport-fit.ts decides (pure, tested); this reads the numbers, keeps
 *  the verdict current across rotation and resize, and publishes it two ways:
 *  the `--os-fill-h` CSS variable the shell roots use, and appHeight() for the
 *  code that lays windows out in pixels (wm.workArea, useViewport). Both must
 *  agree, or a maximized window would stop short of a root that was stretched.
 */
import { diagnoseViewport, isStatusBarPref, type FitVerdict, type ViewportSample } from "@/lib/viewport-fit";

let verdict: FitVerdict | null = null;
let sample: ViewportSample | null = null;

function safeInsets(): { top: number; bottom: number } {
  // env() is only readable through a styled element.
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)";
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const out = { top: parseFloat(cs.paddingTop) || 0, bottom: parseFloat(cs.paddingBottom) || 0 };
  probe.remove();
  return out;
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
  if (verdict.fillHeight) root.style.setProperty("--os-fill-h", `${verdict.fillHeight}px`);
  else root.style.removeProperty("--os-fill-h");
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

/** The OS's usable height in px: the stretched height when the iOS gap is
 *  being covered AND the keyboard is not up, otherwise what the browser says. */
export function appHeight(): number {
  if (typeof window === "undefined") return 900;
  const vv = window.visualViewport?.height ?? window.innerHeight;
  if (verdict?.fillHeight && vv >= window.innerHeight - 2) return verdict.fillHeight;
  return Math.round(vv);
}

export const viewportReport = (): { sample: ViewportSample | null; verdict: FitVerdict | null } => ({ sample, verdict });
