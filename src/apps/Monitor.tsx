"use client";

import { useEffect, useState } from "react";
import { useWM } from "@/kernel/wm";
import { useVFS } from "@/kernel/vfs";
import { useSettings } from "@/kernel/settings";
import { APPS, getApp } from "@/kernel/registry";
import { bus } from "@/kernel/bus";
import type { AppProps } from "@/kernel/types";
import { bytes, relTime } from "@/lib/format";
import { Tabs } from "./_ui";
import { Icon } from "@/shell/icons";

/** System Monitor — live processes, storage, an event log and AI spend. */
interface Ev { ts: number; event: string; payload: string }

export default function Monitor({}: AppProps) {
  const wm = useWM();
  const vfs = useVFS();
  const s = useSettings();
  const [tab, setTab] = useState("processes");
  const [events, setEvents] = useState<Ev[]>([]);
  const [mem, setMem] = useState<{ used: number; limit: number } | null>(null);
  const [fps, setFps] = useState(0);

  useEffect(() => {
    // The "*" subscription is the bus's firehose — exactly what a monitor wants.
    const off = bus.on("*", (p) => {
      const { event, payload } = (p ?? {}) as { event?: string; payload?: unknown };
      setEvents((e) => [{ ts: Date.now(), event: event ?? "?", payload: safeJson(payload) }, ...e].slice(0, 200));
    });
    return off;
  }, []);

  useEffect(() => {
    const read = () => {
      const perf = performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } };
      if (perf.memory) setMem({ used: perf.memory.usedJSHeapSize, limit: perf.memory.jsHeapSizeLimit });
    };
    read();
    const t = setInterval(read, 2000);

    // Frame timing, sampled over one second so the number is stable enough to read.
    let frames = 0;
    let last = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      frames++;
      if (now - last >= 1000) { setFps(Math.round((frames * 1000) / (now - last))); frames = 0; last = now; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { clearInterval(t); cancelAnimationFrame(raf); };
  }, []);

  const usage = vfs.usage();

  return (
    <div className="flex h-full flex-col">
      <Tabs
        tabs={[{ id: "processes", label: "Processes", icon: "gate" }, { id: "resources", label: "Resources", icon: "system" }, { id: "events", label: `Events (${events.length})`, icon: "quick" }]}
        active={tab}
        onChange={setTab}
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === "processes" && (
          <>
            <div className="os-label mb-1.5">Open windows ({wm.windows.length})</div>
            {wm.windows.length === 0 && <div className="text-[12px] text-[var(--muted)]">No windows open.</div>}
            <div className="space-y-1">
              {[...wm.windows].sort((a, b) => b.z - a.z).map((w) => {
                const app = getApp(w.appId);
                return (
                  <div key={w.id} className="flex items-center gap-2 rounded-[calc(var(--radius)*0.5)] border border-[var(--border)] px-2 py-1.5 text-[11.5px]">
                    <span>{w.icon}</span>
                    <span className="w-40 shrink-0 truncate">{w.title}</span>
                    <span className="os-chip !px-1.5 !py-0 !text-[9.5px]">{w.state}</span>
                    <span className="text-[var(--muted)]">ws{w.workspace}</span>
                    <span className="text-[var(--muted)]">z{w.z}</span>
                    <span className="hidden text-[var(--muted)] sm:inline">{Math.round(w.w)}×{Math.round(w.h)}</span>
                    <span className="hidden text-[var(--muted)] md:inline">{relTime(w.createdAt)}</span>
                    <div className="flex-1" />
                    <span className="flex flex-wrap gap-0.5">
                      {app?.permissions?.map((p) => <span key={p} className="os-chip !px-1 !py-0 !text-[9px]">{p}</span>)}
                    </span>
                    <button className="os-btn !px-2 !py-0 text-[10px]" onClick={() => wm.focus(w.id)}>Focus</button>
                    <button className="os-btn !px-2 !py-0 text-[10px]" onClick={() => wm.close(w.id)}>End</button>
                  </div>
                );
              })}
            </div>
            <div className="os-label mb-1.5 mt-4">Registered apps ({APPS.length})</div>
            <div className="grid gap-1" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))" }}>
              {APPS.map((a) => (
                <div key={a.id} className="flex items-center gap-1.5 text-[11px]">
                  <Icon name={a.icon} size={12} style={{ color: a.accent ?? "var(--accent)" }} />
                  <span className="min-w-0 flex-1 truncate">{a.name}</span>
                  <span className="text-[9.5px] text-[var(--muted)]">{wm.windows.filter((w) => w.appId === a.id).length || ""}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {tab === "resources" && (
          <div className="grid max-w-3xl gap-3 sm:grid-cols-2">
            <Stat label="Frame rate" value={`${fps} fps`} bar={Math.min(100, (fps / 60) * 100)} good={fps >= 50} />
            <Stat
              label="JS heap"
              value={mem ? `${bytes(mem.used)} / ${bytes(mem.limit)}` : "not exposed by this browser"}
              bar={mem ? (mem.used / mem.limit) * 100 : 0}
              good={!mem || mem.used / mem.limit < 0.8}
            />
            <Stat label="Filesystem" value={`${usage.count} files · ${bytes(usage.bytes)}`} bar={(usage.bytes / (5 * 1024 * 1024)) * 100} good={usage.bytes < 4e6} />
            <Stat label="AI spend (est.)" value={`$${s.ai.spentUsd.toFixed(4)} / $${s.ai.budgetUsd.toFixed(2)}`} bar={(s.ai.spentUsd / Math.max(0.0001, s.ai.budgetUsd)) * 100} good={s.ai.spentUsd < s.ai.budgetUsd * 0.85} />
            <div className="os-card sm:col-span-2">
              <div className="os-label mb-1.5">Environment</div>
              <div className="space-y-0.5 text-[11.5px]">
                {typeof window !== "undefined" && ([
                  ["Viewport", `${window.innerWidth} × ${window.innerHeight}`],
                  ["Device pixel ratio", String(window.devicePixelRatio)],
                  ["Cores", String(navigator.hardwareConcurrency ?? "?")],
                  ["Online", String(navigator.onLine)],
                  ["Language", navigator.language],
                  ["Display mode", window.matchMedia("(display-mode: standalone)").matches ? "standalone (PWA)" : "browser"],
                  ["Reduced motion", String(window.matchMedia("(prefers-reduced-motion: reduce)").matches)],
                  ["Service worker", "serviceWorker" in navigator ? "supported" : "unavailable"],
                ] as [string, string][]).map(([k, v]) => (
                  <div key={k} className="flex justify-between"><span className="text-[var(--muted)]">{k}</span><span>{v}</span></div>
                ))}
              </div>
            </div>
          </div>
        )}

        {tab === "events" && (
          <>
            <button className="os-btn mb-2 !py-1 text-[11px]" onClick={() => setEvents([])}>Clear log</button>
            {events.length === 0 && <div className="text-[12px] text-[var(--muted)]">Nothing logged yet. Events appear here as apps talk to each other.</div>}
            <div className="space-y-0.5 font-[family-name:var(--font-mono)] text-[11px]">
              {events.map((e, i) => (
                <div key={i} className="flex gap-2">
                  <span className="shrink-0 text-[var(--muted)]">{new Date(e.ts).toLocaleTimeString()}</span>
                  <span className="w-28 shrink-0 truncate text-[var(--accent)]">{e.event}</span>
                  <span className="min-w-0 flex-1 truncate text-[var(--muted)]">{e.payload}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, bar, good }: { label: string; value: string; bar: number; good: boolean }) {
  return (
    <div className="os-card">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="os-label">{label}</span>
        <span className="tabular-nums text-[12px]">{value}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(100, Math.max(0, bar))}%`, background: good ? "var(--ok)" : "var(--warn)" }} />
      </div>
    </div>
  );
}

function safeJson(v: unknown): string {
  try { return typeof v === "string" ? v : JSON.stringify(v) ?? "—"; } catch { return "[unserializable]"; }
}
