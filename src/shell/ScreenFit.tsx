"use client";

import { useState } from "react";
import { useSettings } from "@/kernel/settings";
import { installViewportFit, viewportReport, measureViewport } from "@/kernel/viewport";
import { diagnoseViewport } from "@/lib/viewport-fit";

/* Settings > Phone & Screen: the status-bar choice and what the device is
   actually reporting, so a bottom band on a phone can be diagnosed from the
   phone itself instead of guessed at (lib/viewport-fit.ts). iOS reads the
   choice once, when the app is added to the Home Screen, so the readout says
   which bar this copy was really installed with. */

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
        ["Installed with", !sample.standalone ? "not installed" : sample.innerW > sample.innerH ? "turn the phone upright to tell" : sample.safeTop > 0 ? "see-through status bar" : "standard status bar"],
        ["Gap", `${live?.gap ?? 0} px`],
      ]
    : [];
  return (
    <div className="os-card mb-3" data-screen-fit={live?.kind ?? "unknown"}>
      <div className="mb-1.5 text-[13px] font-medium">Status bar and screen fit (installed app)</div>
      <p className="mb-2 text-[12px] text-[var(--muted)]">
        Standard puts the app below the iPhone status bar and fills the screen to the bottom edge. Edge to edge runs the
        wallpaper under the Dynamic Island, but iOS 26 and later then leave an empty band at the bottom that no app can
        draw in. iOS reads this choice only when the app is added to the Home Screen: to change it, choose here, then remove
        Web-AIOS from the Home Screen and add it again from Safari.
      </p>
      <div className="mb-2 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Status bar style">
        {([["solid", "Standard (recommended)"], ["translucent", "Edge to edge"]] as const).map(([id, label]) => (
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
      {live && <p className="mt-2 text-[11.5px]" data-screen-fit-advice>{live.advice}</p>}
      {live?.reinstall && (
        <ol className="mt-1.5 list-decimal space-y-0.5 pl-5 text-[11.5px] text-[var(--muted)]" data-screen-fit-steps>
          <li>Settings, Storage, Download full backup. An installed app keeps its own storage, and removing it can erase that.</li>
          <li>Touch and hold the Web-AIOS icon on the Home Screen, then Remove App.</li>
          <li>Open web-aios.vercel.app in Safari, tap Share, then Add to Home Screen, and open the new icon.</li>
          <li>If your files are missing: Settings, Storage, Restore from backup. API keys are never in a backup; add them again.</li>
        </ol>
      )}
      <button className="os-btn mt-2 !py-1 text-[11px]" onClick={() => setTick((t) => t + 1)}>Measure again</button>
    </div>
  );
}
