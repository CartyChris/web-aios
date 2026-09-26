"use client";

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSettings, type WidgetInstance } from "@/kernel/settings";
import { useWM } from "@/kernel/wm";
import { useVFS } from "@/kernel/vfs";
import { getApp } from "@/kernel/registry";
import { bytes } from "@/lib/format";
import { Icon } from "./icons";
import { cn } from "@/lib/cn";
import { useCustomWidgets, widgetDocument } from "@/kernel/widgets";
import { resolveTokens } from "@/kernel/settings";

// Loaded only when one is on the desktop: the data widget carries the whole
// service catalogue (lib/services.ts), which most desktops never need.
const NewsWidget = lazy(() => import("./widgets/NewsWidget").then((m) => ({ default: m.NewsWidget })));
const DataWidget = lazy(() => import("./widgets/DataWidget").then((m) => ({ default: m.DataWidget })));

export const WIDGET_KINDS = [
  { id: "clock", name: "Clock", icon: "clock" },
  { id: "calendar", name: "Calendar", icon: "calendar" },
  { id: "system", name: "System", icon: "system" },
  { id: "quick", name: "Quick Launch", icon: "quick" },
  { id: "notes", name: "Sticky Note", icon: "sticky" },
  { id: "ai", name: "AI Status", icon: "spark" },
  { id: "storage", name: "Storage", icon: "storage" },
  { id: "news", name: "News", icon: "report", w: 320, h: 280 },
  { id: "data", name: "Live data", icon: "signals", w: 300, h: 240 },
] as const;

export function WidgetLayer() {
  const { widgets, showWidgets, moveWidget, removeWidget } = useSettings();
  if (!showWidgets) return null;
  return (
    // Above the icon surface (z-1). The layer itself is pointer-events-none, so
    // a click that misses a widget card still falls through to the marquee
    // underneath — but a click ON a widget reaches the widget, which it did not
    // when the two layers shared a z-index.
    <div className="pointer-events-none absolute inset-0 z-[3]">
      {widgets.map((w) => (
        <WidgetHost key={w.id} widget={w} onMove={moveWidget} onRemove={removeWidget} />
      ))}
    </div>
  );
}

function WidgetHost({ widget, onMove, onRemove }: { widget: WidgetInstance; onMove: (id: string, x: number, y: number) => void; onRemove: (id: string) => void }) {
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const [hover, setHover] = useState(false);

  // Dragging starts ONLY from the handle.
  //
  // The card used to capture the pointer itself, which silently broke every
  // interactive widget: pointer capture on an ancestor redirects events away
  // from a child iframe, so a widget's own buttons never received a click. A
  // handle keeps the body fully interactive — which is the whole point of a
  // widget you can build.
  const onDown = useCallback(
    (e: React.PointerEvent) => {
      if (!(e.target as HTMLElement).closest("[data-widget-handle]")) return;
      e.preventDefault();
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
      data-widget-card
      className="glass pointer-events-auto absolute overflow-hidden"
      style={{ left: widget.x, top: widget.y, width: widget.w, height: widget.h, borderRadius: "var(--radius)" }}
    >
      {/* Handle: the only draggable surface, revealed on hover so it does not
          clutter the widget the rest of the time. */}
      <div
        data-widget-handle
        className="absolute inset-x-0 top-0 z-10 flex h-5 cursor-grab items-center justify-center active:cursor-grabbing"
        style={{ opacity: hover ? 1 : 0, transition: "opacity 140ms ease", background: "linear-gradient(var(--panel-solid), transparent)" }}
        title="Drag to move"
      >
        <span className="h-[3px] w-8 rounded-full" style={{ background: "color-mix(in srgb, var(--muted) 60%, transparent)" }} />
      </div>
      {hover && (
        <button
          onClick={() => onRemove(widget.id)}
          className="absolute right-1 top-0.5 z-20 grid h-5 w-5 place-items-center rounded-full bg-black/45 hover:bg-[var(--danger)]"
          title="Remove widget"
          aria-label="Remove widget"
        >
          <Icon name="close" size={10} />
        </button>
      )}
      <div className={cn("h-full w-full overflow-hidden", widget.kind === "custom" ? "p-0" : "p-3")}>
        {/* Keyed on config so a saved setting remounts with a fresh load
            instead of patching a live fetch mid-flight. */}
        <WidgetBody key={JSON.stringify(widget.config ?? null)} id={widget.id} kind={widget.kind} customId={widget.customId} config={widget.config} />
      </div>
    </div>
  );
}

function WidgetBody({ id, kind, customId, config }: { id: string; kind: string; customId?: string; config?: Record<string, unknown> }) {
  if (kind === "custom") return <CustomWidgetFrame id={customId} />;
  const onConfig = (c: Record<string, unknown>) => useSettings.getState().configureWidget(id, c);
  switch (kind) {
    case "news": return <Suspense fallback={null}><NewsWidget config={config} onConfig={onConfig} /></Suspense>;
    case "data": return <Suspense fallback={null}><DataWidget config={config} onConfig={onConfig} /></Suspense>;
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

/** Runs a user/AI-authored widget inside a sandbox.
 *
 *  `sandbox="allow-scripts"` WITHOUT allow-same-origin puts the frame in an
 *  opaque origin: it can run its own code but cannot read this page, its
 *  localStorage, or the API keys held there. That single omission is what
 *  separates "a widget you generated" from "arbitrary code with your
 *  credentials". */
function CustomWidgetFrame({ id }: { id?: string }) {
  const widget = useCustomWidgets((s) => s.widgets.find((w) => w.id === id));
  const settings = useSettings();
  const doc = useMemo(
    () => (widget ? widgetDocument(widget.html, resolveTokens(settings)) : ""),
    [widget, settings],
  );
  if (!widget) {
    return (
      <div className="grid h-full place-items-center px-2 text-center text-[11px] text-[var(--muted)]">
        This widget was deleted.
      </div>
    );
  }
  return (
    <iframe
      srcDoc={doc}
      sandbox="allow-scripts"
      title={widget.name}
      className="h-full w-full border-0 bg-transparent"
      style={{ colorScheme: "normal" }}
    />
  );
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
      onChange={(e) => { setText(e.target.value); vfs.write(path, e.target.value, { appId: "personalize" }); }}
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
