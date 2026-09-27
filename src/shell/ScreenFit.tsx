"use client";

import { useState } from "react";
import { useSettings } from "@/kernel/settings";
import { installViewportFit, viewportReport, measureViewport } from "@/kernel/viewport";
import { diagnoseViewport } from "@/lib/viewport-fit";

/* Settings > Phone & Screen: the status-bar choice and what the device is
   actually reporting, so a bottom band on a phone can be diagnosed from the
   phone itself instead of guessed at (lib/viewport-fit.ts). */

export function ScreenFit() {
  const statusBar = useSettings((s) => s.statusBar);
  const set = useSettings((s) => s.set);
  const [tick, setTick] = useState(0);
  installViewportFit();
  void tick;
  const { verdict } = viewportReport();
  const sample = typeof window === "undefined" ? null : measureViewport();
  const live = sample ? diagnoseViewport(sample) : verdict;
  const rows: Array<[string, string]> = sample
    ? [
        ["Running as", sample.standalone ? "installed app" : "browser tab"],
        ["Screen (for this orientation)", `${sample.innerW > sample.innerH ? Math.min(sample.screenW, sample.screenH) : Math.max(sample.screenW, sample.screenH)} px tall`],
        ["The page is told", `${sample.innerH} px`],
        ["Status-bar inset", `${Math.round(sample.safeTop)} px top, ${Math.round(sample.safeBottom)} px bottom`],
        ["Gap", `${live?.gap ?? 0} px`],
        ["Covering it with", live?.fillHeight ? `${live.fillHeight} px` : "nothing needed"],
      ]
    : [];
  return (
    <div className="os-card mb-3" data-screen-fit={live?.kind ?? "unknown"}>
      <div className="mb-1.5 text-[13px] font-medium">Status bar and screen fit (installed app)</div>
      <p className="mb-2 text-[12px] text-[var(--muted)]">
        Full-bleed runs the wallpaper under the Dynamic Island. On iOS 26 some iPhones then leave a band at the bottom of the
        screen; the OS stretches to cover it, and if the band is still there, Solid avoids the bug. Changes apply after you
        close the app and open it again from the Home Screen.
      </p>
      <div className="mb-2 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Status bar style">
        {([["translucent", "Full-bleed"], ["solid", "Solid"]] as const).map(([id, label]) => (
          <button key={id} role="radio" aria-checked={statusBar === id} className="os-btn !py-1 text-[11px]" data-variant={statusBar === id ? "primary" : undefined} onClick={() => set("statusBar", id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11.5px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents"><span className="text-[var(--muted)]">{k}</span><span>{v}</span></div>
        ))}
      </div>
      {live && <p className="mt-2 text-[11.5px]">{live.advice}</p>}
      <button className="os-btn mt-2 !py-1 text-[11px]" onClick={() => setTick((t) => t + 1)}>Measure again</button>
    </div>
  );
}
