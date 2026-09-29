"use client";

import { useState, useSyncExternalStore } from "react";
import { viewportReport } from "@/kernel/viewport";
import { bus } from "@/kernel/bus";
import { Icon } from "./icons";

/* Shown once on an iPhone whose installed copy is losing the bottom band to
   the see-through status bar (lib/viewport-fit.ts decides). iOS fixes the
   style when the app is added to the Home Screen, so the only cure is to add
   it again, and nobody would guess that from an empty strip. Dismissing it is
   remembered on this device only. */

const KEY = "webaios.fitnotice.v1";

function subscribe(onChange: () => void) {
  window.addEventListener("resize", onChange);
  window.addEventListener("orientationchange", onChange);
  return () => { window.removeEventListener("resize", onChange); window.removeEventListener("orientationchange", onChange); };
}

export function ScreenFitNotice({ top }: { top: string }) {
  const kind = useSyncExternalStore(subscribe, () => viewportReport().verdict?.kind ?? "", () => "");
  const gap = useSyncExternalStore(subscribe, () => viewportReport().verdict?.gap ?? 0, () => 0);
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
  });
  if (kind !== "ios-top-inset-gap" || dismissed) return null;
  const dismiss = () => {
    setDismissed(true);
    try { localStorage.setItem(KEY, "1"); } catch { /* private mode: it just shows again next time */ }
  };
  return (
    <div className="glass fixed left-2 right-2 z-[9890] mx-auto max-w-md p-3 shadow-2xl sm:left-auto sm:right-3" style={{ top, borderRadius: "var(--radius)" }} role="status" data-screen-fit-notice>
      <div className="mb-1 flex items-center gap-2 text-[13px] font-semibold">
        <Icon name="monitor" size={14} style={{ color: "var(--accent)" }} />
        Empty band at the bottom?
      </div>
      <p className="mb-2 text-[12px] leading-relaxed text-[var(--muted)]">
        iOS is keeping {gap}px at the bottom of the screen that no app can draw in, because this copy was added to the Home
        Screen with the see-through status bar. Adding it again fixes it for good.
      </p>
      <div className="flex justify-end gap-1.5">
        <button className="os-btn !py-1 text-[12px]" onClick={dismiss}>Dismiss</button>
        <button
          className="os-btn !py-1 text-[12px]"
          data-variant="primary"
          onClick={() => { bus.emit("app:open", { appId: "settings", args: { tab: "screen" } }); dismiss(); }}
        >
          Show me how
        </button>
      </div>
    </div>
  );
}
