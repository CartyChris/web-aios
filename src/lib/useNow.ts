"use client";

import { useEffect, useState } from "react";

/** A clock you may read during render.
 *
 *  Calling Date.now() inside a component body makes render impure: the same
 *  props can produce two different trees, which breaks React's ability to
 *  re-run a render safely. This hook moves the clock into state, updated from a
 *  timer — the one place a setState belongs in an effect, because it is
 *  subscribing to an external system rather than syncing derived state.
 *
 *  Pick the coarsest interval the UI can live with: a "3 days ago" label does
 *  not need a 1 Hz tick. */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    // Recover immediately when a laptop wakes or a tab is re-foregrounded,
    // rather than showing a stale clock until the next tick.
    const onVisible = () => {
      if (document.visibilityState === "visible") setNow(Date.now());
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs]);

  return now;
}
