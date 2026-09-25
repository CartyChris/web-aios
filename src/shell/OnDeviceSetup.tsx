"use client";

import { useEffect, useState } from "react";
import { onDeviceStatus, downloadOnDeviceModel } from "@/lib/ondevice";

/** Status and download for the on-device model. The download must start from
 *  this button's click: Chrome refuses it otherwise. */
export function OnDeviceSetup() {
  const [status, setStatus] = useState<string>("checking");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { let live = true; void onDeviceStatus().then((s) => { if (live) setStatus(s); }); return () => { live = false; }; }, []);
  const label: Record<string, string> = {
    checking: "Checking...", unsupported: "Not available in this browser (Chrome's built-in AI is needed).", unavailable: "Chrome says it cannot run on this device.",
    downloadable: "Available, not downloaded yet.", downloading: "Downloading...", available: "Ready. Runs on this device, offline, at no cost.",
  };
  return (
    <div className="mt-2 rounded-[calc(var(--radius)*0.5)] border border-[var(--border)] p-2 text-[11px]" data-ondevice={status}>
      <div className="font-medium">On-device model (provider: On-device)</div>
      <div className="text-[var(--muted)]">{label[status] ?? status}{progress !== null && progress < 1 ? ` ${Math.round(progress * 100)}%` : ""}</div>
      {(status === "downloadable" || status === "downloading") && (
        <button className="os-btn mt-1 !py-0.5 text-[11px]" onClick={() => {
          setError(null); setStatus("downloading");
          downloadOnDeviceModel(setProgress).then(() => setStatus("available")).catch((e) => { setError(e instanceof Error ? e.message : String(e)); void onDeviceStatus().then(setStatus); });
        }}>Download on-device model</button>
      )}
      {error && <div className="mt-1 text-[var(--danger)]">{error}</div>}
    </div>
  );
}
