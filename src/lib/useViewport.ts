"use client";

import { useSyncExternalStore } from "react";

export interface Viewport {
  w: number;
  h: number;
  /** Floating windows are unusable below this width; the shell switches to a
   *  single-app phone paradigm instead of shrinking a desktop metaphor. */
  isPhone: boolean;
  isTablet: boolean;
  /** Running from the home screen rather than in a browser tab. */
  standalone: boolean;
  landscape: boolean;
  /** Coarse pointer means touch targets need to be finger-sized. */
  touch: boolean;
}

const PHONE_MAX = 768;

const SERVER: Viewport = { w: 1440, h: 900, isPhone: false, isTablet: false, standalone: false, landscape: true, touch: false };

/* One module-level snapshot shared by every subscriber.
 *
 * useSyncExternalStore requires getSnapshot to return a referentially stable
 * value while nothing has changed — returning a fresh object each call makes
 * React loop forever. So the snapshot is cached and only replaced when a field
 * actually differs. That caching is also what makes every component switch in
 * the same commit, rather than each holding its own copy of the truth. */
let snapshot: Viewport = SERVER;
let initialised = false;

function measure(): Viewport {
  // visualViewport tracks the on-screen keyboard on iOS, which innerWidth does
  // not — but it lags during an orientation change, so innerWidth wins when
  // the two disagree about which axis is longer.
  const vv = window.visualViewport;
  const w = Math.round(vv?.width ?? window.innerWidth);
  const h = Math.round(vv?.height ?? window.innerHeight);
  return {
    w,
    h,
    isPhone: w < PHONE_MAX,
    isTablet: w >= PHONE_MAX && w < 1100,
    standalone:
      window.matchMedia("(display-mode: standalone)").matches ||
      ("standalone" in window.navigator && Boolean((window.navigator as Navigator & { standalone?: boolean }).standalone)),
    landscape: w > h,
    touch: window.matchMedia("(pointer: coarse)").matches,
  };
}

function refresh(): boolean {
  const next = measure();
  const prev = snapshot;
  if (
    next.w === prev.w && next.h === prev.h && next.isPhone === prev.isPhone &&
    next.isTablet === prev.isTablet && next.standalone === prev.standalone &&
    next.landscape === prev.landscape && next.touch === prev.touch
  ) {
    return false;
  }
  snapshot = next;
  return true;
}

function subscribe(onChange: () => void): () => void {
  const handler = () => {
    if (refresh()) onChange();
  };
  window.addEventListener("resize", handler);
  window.addEventListener("orientationchange", handler);
  window.visualViewport?.addEventListener("resize", handler);
  window.visualViewport?.addEventListener("scroll", handler);
  const mq = window.matchMedia("(display-mode: standalone)");
  mq.addEventListener?.("change", handler);

  // A ResizeObserver on the document element catches layout changes that never
  // raise a window resize event — notably devtools docking and the programmatic
  // viewport overrides used by device emulation.
  const ro = new ResizeObserver(handler);
  ro.observe(document.documentElement);

  return () => {
    window.removeEventListener("resize", handler);
    window.removeEventListener("orientationchange", handler);
    window.visualViewport?.removeEventListener("resize", handler);
    window.visualViewport?.removeEventListener("scroll", handler);
    mq.removeEventListener?.("change", handler);
    ro.disconnect();
  };
}

function getSnapshot(): Viewport {
  // First real read on the client replaces the server placeholder.
  if (!initialised) {
    initialised = true;
    refresh();
  }
  return snapshot;
}

const getServerSnapshot = (): Viewport => SERVER;

/** Live viewport metrics, shared by every component that asks. */
export function useViewport(): Viewport {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
