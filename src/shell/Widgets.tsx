"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSettings, type WidgetInstance } from "@/kernel/settings";
import { useWM } from "@/kernel/wm";
import { useVFS } from "@/kernel/vfs";
import { getApp } from "@/kernel/registry";
import { bytes } from "@/lib/format";
import { Icon } from "./icons";

export const WIDGET_KINDS = [
  { id: "clock", name: "Clock", icon: "clock" },
  { id: "calendar", name: "Calendar", icon: "calendar" },
  { id: "system", name: "System", icon: "system" },
  { id: "quick", name: "Quick Launch", icon: "quick" },
  { id: "notes", name: "Sticky Note", icon: "sticky" },
  { id: "ai", name: "AI Status", icon: "spark" },
  { id: "storage", name: "Storage", icon: "storage" },
] as const;

export function WidgetLayer() {
  const { widgets, showWidgets, moveWidget, removeWidget } = useSettings();
  if (!showWidgets) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-[1]">
      {widgets.map((w) => (
        <WidgetHost key={w.id} widget={w} onMove={moveWidget} onRemove={removeWidget} />
      ))}
    </div>
  );
}

function WidgetHost({ widget, onMove, onRemove }: { widget: WidgetInstance; onMove: (id: string, x: number, y: number) => void; onRemove: (id: string) => void }) {
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const [hover, setHover] = useState(false);

  const onDown = useCallback(
    (e: React.PointerEvent) => {
      if ((e.target as HTMLElement).closest("button")) return;
      drag.current = { dx: e.clientX - widget.x, dy: e.clientY - widget.y };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [widget.x, widget.y],
  );

  return (
    <div
      onPointerDown={onDown}
      onPointerMove={(e) => {
        if (!drag.current) return;
        onMove(
          widget.id,
          Math.max(4, Math.min(window.innerWidth - widget.w - 4, e.clientX - drag.current.dx)),
          Math.max(44, Math.min(window.innerHeight - widget.h - 4, e.clientY - drag.current.dy)),
        );
      }}
      onPointerUp={() => (drag.current = null)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="glass pointer-events-auto absolute cursor-grab overflow-hidden p-3 active:cursor-grabbing"
      style={{ left: widget.x, top: widget.y, width: widget.w, height: widget.h, borderRadius: "var(--radius)" }}
    >
      {hover && (
        <button
          onClick={() => onRemove(widget.id)}
          className="absolute right-1.5 top-1.5 z-10 grid h-5 w-5 place-items-center rounded-full bg-black/40 hover:bg-[var(--danger)]"
          title="Remove widget"
          aria-label="Remove widget"
        >
          <Icon name="close" size={10} />
        </button>
      )}
      <WidgetBody kind={widget.kind} />
    </div>
  );
}

function WidgetBody({ kind }: { kind: string }) {
  switch (kind) {
    case "clock": return <ClockWidget />;
    case "calendar": return <CalendarWidget />;
    case "system": return <SystemWidget />;
    case "quick": return <QuickWidget />;
    case "notes": return <StickyWidget />;
    case "ai": return <AIWidget />;
    case "storage": return <StorageWidget />;
    default: return <div className="text-[var(--muted)]">Unknown widget</div>;
  }
}

function ClockWidget() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="flex h-full flex-col justify-center">
      <div className="tabular-nums text-3xl font-light">{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
      <div className="text-[11px] text-[var(--muted)]">{now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</div>
    </div>
  );
}

function CalendarWidget() {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1).getDay();
  const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return (
    <div className="h-full overflow-hidden">
      <div className="mb-1 text-[11px] font-medium">{now.toLocaleDateString([], { month: "long", year: "numeric" })}</div>
      <div className="grid grid-cols-7 gap-px text-center text-[9px]">
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => <div key={i} className="text-[var(--muted)]">{d}</div>)}
        {Array.from({ length: first }, (_, i) => <div key={`e${i}`} />)}
        {Array.from({ length: days }, (_, i) => (
          <div key={i} className={i + 1 === now.getDate() ? "rounded bg-[var(--accent)] font-bold text-black" : ""}>{i + 1}</div>
        ))}
      </div>
    </div>
  );
}

function SystemWidget() {
  const wm = useWM();
  const [mem, setMem] = useState<number | null>(null);
  useEffect(() => {
    const read = () => {
      const perf = performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } };
      if (perf.memory) setMem(Math.round((perf.memory.usedJSHeapSize / perf.memory.jsHeapSizeLimit) * 100));
    };
    read();
    const t = setInterval(read, 3000);
    return () => clearInterval(t);
  }, []);
  const rows: [string, string][] = [
    ["Windows", String(wm.windows.length)],
    ["Workspace", `${wm.activeWorkspace} / ${wm.workspaces}`],
    ["Viewport", typeof window !== "undefined" ? `${window.innerWidth}×${window.innerHeight}` : "—"],
    ["JS heap", mem === null ? "n/a" : `${mem}%`],
  ];
  return (
    <div className="flex h-full flex-col justify-center gap-1 text-[11px]">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between"><span className="text-[var(--muted)]">{k}</span><span className="tabular-nums">{v}</span></div>
      ))}
    </div>
  );
}

function QuickWidget() {
  const wm = useWM();
  const { dockApps } = useSettings();
  return (
    <div className="grid h-full grid-cols-4 content-start gap-1.5">
      {dockApps.slice(0, 8).map((id) => {
        const app = getApp(id);
        if (!app) return null;
        return (
          <button
            key={id}
            onClick={() => wm.open(id, { title: app.name, icon: app.icon, size: app.defaultSize, singleton: app.singleton })}
            title={app.name}
            className="grid aspect-square place-items-center rounded-lg hover:bg-white/10"
            style={{ color: app.accent ?? "var(--accent)" }}
          >
            <Icon name={app.icon} size={20} />
          </button>
        );
      })}
    </div>
  );
}

function StickyWidget() {
  const vfs = useVFS();
  const path = "/widgets/sticky.md";
  const [text, setText] = useState(() => vfs.read(path)?.content ?? "");
  return (
    <textarea
      value={text}
      onChange={(e) => { setText(e.target.value); vfs.write(path, e.target.value, { appId: "widget" }); }}
      placeholder="Sticky note…"
      className="h-full w-full resize-none bg-transparent text-[12px] outline-none"
    />
  );
}

function AIWidget() {
  const { ai } = useSettings();
  const pct = ai.budgetUsd > 0 ? Math.min(100, (ai.spentUsd / ai.budgetUsd) * 100) : 0;
  return (
    <div className="flex h-full flex-col justify-center gap-1.5 text-[11px]">
      <div className="flex justify-between"><span className="text-[var(--muted)]">Provider</span><span>{ai.provider}</span></div>
      <div className="flex justify-between"><span className="text-[var(--muted)]">Model</span><span className="truncate">{ai.model}</span></div>
      <div className="flex justify-between"><span className="text-[var(--muted)]">Spend</span><span className="tabular-nums">${ai.spentUsd.toFixed(3)} / ${ai.budgetUsd}</span></div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: pct > 85 ? "var(--danger)" : "var(--accent)" }} />
      </div>
    </div>
  );
}

function StorageWidget() {
  const usage = useVFS((s) => s.usage)();
  const cap = 5 * 1024 * 1024;
  const pct = Math.min(100, (usage.bytes / cap) * 100);
  return (
    <div className="flex h-full flex-col justify-center gap-1.5 text-[11px]">
      <div className="flex justify-between"><span className="text-[var(--muted)]">Files</span><span>{usage.count}</span></div>
      <div className="flex justify-between"><span className="text-[var(--muted)]">Used</span><span>{bytes(usage.bytes)}</span></div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: pct > 85 ? "var(--warn)" : "var(--ok)" }} />
      </div>
      <div className="text-[10px] text-[var(--muted)]">Local browser storage</div>
    </div>
  );
}
