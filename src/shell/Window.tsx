"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useWM, snapGeometry, type SnapZone } from "@/kernel/wm";
import { useSettings } from "@/kernel/settings";
import { getApp } from "@/kernel/registry";
import type { WindowInstance } from "@/kernel/types";
import { cn } from "@/lib/cn";
import { Icon } from "@/shell/icons";

const EDGES = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;
type Edge = (typeof EDGES)[number];

export function WindowFrame({ win }: { win: WindowInstance }) {
  const wm = useWM();
  const settings = useSettings();
  const app = getApp(win.appId);
  const focused = wm.focused === win.id;
  const [snapHint, setSnapHint] = useState<SnapZone | null>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);

  const minW = app?.minSize?.w ?? 360;
  const minH = app?.minSize?.h ?? 220;

  /** Pointer-events drag. Using setPointerCapture means the drag survives the
   *  cursor leaving the titlebar — and crucially, crossing an iframe, which is
   *  where naive mousemove window managers lose the pointer. */
  const onTitlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
      if (win.state === "maximized") return;
      wm.focus(win.id);
      dragRef.current = { dx: e.clientX - win.x, dy: e.clientY - win.y };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [win.id, win.x, win.y, win.state, wm],
  );

  const onTitlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const x = e.clientX - d.dx;
      const y = Math.max(settings.topBarVisible ? 40 : 0, e.clientY - d.dy);
      wm.move(win.id, x, y);

      if (!settings.snapEnabled) return;
      const T = 18;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const nearL = e.clientX < T, nearR = e.clientX > vw - T;
      const nearT = e.clientY < T + 40, nearB = e.clientY > vh - T;
      let zone: SnapZone | null = null;
      if (nearT && nearL) zone = "tl";
      else if (nearT && nearR) zone = "tr";
      else if (nearB && nearL) zone = "bl";
      else if (nearB && nearR) zone = "br";
      else if (nearT) zone = "max";
      else if (nearL) zone = "left";
      else if (nearR) zone = "right";
      setSnapHint(zone);
    },
    [win.id, wm, settings.snapEnabled, settings.topBarVisible],
  );

  const onTitlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (dragRef.current && snapHint) wm.snap(win.id, snapHint);
      dragRef.current = null;
      setSnapHint(null);
      try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* already released */ }
    },
    [snapHint, win.id, wm],
  );

  /** Resize from any of the eight edges/corners. North and west handles move
   *  the origin as well as the size, which is what makes them feel native. */
  const startResize = useCallback(
    (edge: Edge) => (e: React.PointerEvent) => {
      e.stopPropagation();
      wm.focus(win.id);
      const start = { mx: e.clientX, my: e.clientY, x: win.x, y: win.y, w: win.w, h: win.h };
      const target = e.currentTarget as HTMLElement;
      target.setPointerCapture(e.pointerId);

      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - start.mx;
        const dy = ev.clientY - start.my;
        let { x, y, w, h } = start;
        if (edge.includes("e")) w = Math.max(minW, start.w + dx);
        if (edge.includes("s")) h = Math.max(minH, start.h + dy);
        if (edge.includes("w")) { w = Math.max(minW, start.w - dx); x = start.x + (start.w - w); }
        if (edge.includes("n")) { h = Math.max(minH, start.h - dy); y = start.y + (start.h - h); }
        wm.resize(win.id, w, h, x, y);
      };
      const onUp = () => {
        target.removeEventListener("pointermove", onMove);
        target.removeEventListener("pointerup", onUp);
      };
      target.addEventListener("pointermove", onMove);
      target.addEventListener("pointerup", onUp);
    },
    [win.id, win.x, win.y, win.w, win.h, wm, minW, minH],
  );

  // Maximized windows must track viewport changes, otherwise rotating a tablet
  // or opening devtools leaves a window sized for a screen that no longer exists.
  useEffect(() => {
    if (win.state !== "maximized") return;
    const onResize = () => {
      const g = snapGeometry("max");
      wm.resize(win.id, g.w, g.h, g.x, g.y);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [win.state, win.id, wm]);

  if (win.state === "minimized") return null;
  if (!app) {
    return null;
  }

  const Body = app.component;
  const mac = settings.titlebarStyle === "mac";
  const minimal = settings.titlebarStyle === "minimal";
  const chrome = settings.windowChrome;

  return (
    <>
      {snapHint && (
        <div
          className="pointer-events-none fixed z-[9998] rounded-[var(--radius)] border-2 border-[var(--accent)]"
          style={{ ...snapGeometry(snapHint), background: "color-mix(in srgb, var(--accent) 14%, transparent)" }}
        />
      )}
      <div
        ref={frameRef}
        role="dialog"
        aria-label={win.title}
        onPointerDown={() => wm.focus(win.id)}
        onMouseEnter={() => settings.focusFollowsMouse && wm.focus(win.id)}
        className={cn(
          "absolute flex flex-col overflow-hidden",
          chrome === "glass" && "glass",
          chrome === "solid" && "border border-[var(--border)] bg-[var(--panel-solid)]",
          chrome === "outline" && "border-2 border-[var(--accent)]/40 bg-[var(--bg)]",
          focused ? "shadow-[0_24px_70px_-12px_rgba(0,0,0,0.75)]" : "shadow-[0_10px_30px_-14px_rgba(0,0,0,0.6)]",
        )}
        style={{
          left: win.x,
          top: win.y,
          width: win.w,
          height: win.h,
          zIndex: win.z,
          borderRadius: win.state === "maximized" ? 0 : "var(--radius)",
          opacity: focused ? 1 : `calc(0.55 + 0.45 * var(--window-opacity))`,
          transition: "opacity 160ms ease, box-shadow 160ms ease",
        }}
      >
        {/* ── Titlebar ── */}
        <div
          onPointerDown={onTitlePointerDown}
          onPointerMove={onTitlePointerMove}
          onPointerUp={onTitlePointerUp}
          onDoubleClick={() => wm.toggleMaximize(win.id)}
          className={cn(
            "no-select flex shrink-0 items-center gap-2 px-2.5",
            "border-b border-[var(--border)]",
            win.state === "maximized" ? "cursor-default" : "cursor-grab active:cursor-grabbing",
            minimal && "opacity-80 hover:opacity-100",
          )}
          style={{
            height: minimal ? 30 : "var(--titlebar)",
            background: focused ? "color-mix(in srgb, var(--accent) 7%, transparent)" : "transparent",
          }}
        >
          {mac && (
            <div className="flex items-center gap-[7px] pr-1" data-no-drag>
              <TrafficLight color="#ff5f57" title="Close" onClick={() => wm.close(win.id)} glyph="close" />
              <TrafficLight color="#febc2e" title="Minimize" onClick={() => wm.minimize(win.id)} glyph="minimize" />
              <TrafficLight color="#28c840" title="Maximize" onClick={() => wm.toggleMaximize(win.id)} glyph="maximize" />
            </div>
          )}
          <Icon name={win.icon} size={14} className="opacity-90" />
          <span className="truncate text-[13px] font-medium">{win.title}</span>
          {win.pinned && <span className="os-chip text-[10px]">pinned</span>}
          <div className="flex-1" />
          {!mac && (
            <div className="flex items-center" data-no-drag>
              <ChromeBtn title="Minimize" onClick={() => wm.minimize(win.id)}><Icon name="minimize" size={11} /></ChromeBtn>
              <ChromeBtn title="Maximize" onClick={() => wm.toggleMaximize(win.id)}><Icon name="maximize" size={11} /></ChromeBtn>
              <ChromeBtn title="Close" onClick={() => wm.close(win.id)} danger><Icon name="close" size={11} /></ChromeBtn>
            </div>
          )}
        </div>

        {/* ── App surface ──
            Each app renders inside its own scroll container so a scrolling app
            can never scroll the desktop underneath it. */}
        <div className="app-surface relative min-h-0 flex-1 overflow-hidden">
          <Body win={win} args={win.args} />
        </div>

        {/* ── Resize handles ── */}
        {win.state === "normal" &&
          EDGES.map((edge) => (
            <div
              key={edge}
              onPointerDown={startResize(edge)}
              className="absolute"
              style={{
                cursor: `${edge}-resize`,
                ...(edge === "n" ? { top: -3, left: 10, right: 10, height: 7 } : {}),
                ...(edge === "s" ? { bottom: -3, left: 10, right: 10, height: 7 } : {}),
                ...(edge === "w" ? { left: -3, top: 10, bottom: 10, width: 7 } : {}),
                ...(edge === "e" ? { right: -3, top: 10, bottom: 10, width: 7 } : {}),
                ...(edge === "nw" ? { left: -4, top: -4, width: 14, height: 14 } : {}),
                ...(edge === "ne" ? { right: -4, top: -4, width: 14, height: 14 } : {}),
                ...(edge === "sw" ? { left: -4, bottom: -4, width: 14, height: 14 } : {}),
                ...(edge === "se" ? { right: -4, bottom: -4, width: 14, height: 14 } : {}),
              }}
            />
          ))}
      </div>
    </>
  );
}

function TrafficLight({ color, title, onClick, glyph }: { color: string; title: string; onClick: () => void; glyph: string }) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      className="group grid h-[12px] w-[12px] place-items-center rounded-full"
      style={{ background: color }}
    >
      <span className="leading-none text-black/60 opacity-0 transition group-hover:opacity-100">
        <Icon name={glyph} size={8} strokeWidth={2.6} />
      </span>
    </button>
  );
}

function ChromeBtn({ children, onClick, title, danger }: { children: React.ReactNode; onClick: () => void; title: string; danger?: boolean }) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cn(
        "grid h-[26px] w-[34px] place-items-center rounded text-[11px] transition",
        danger ? "hover:bg-[var(--danger)] hover:text-black" : "hover:bg-white/10",
      )}
    >
      {children}
    </button>
  );
}
