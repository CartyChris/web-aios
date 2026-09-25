"use client";

import { useRef, useState } from "react";
import { useWM } from "@/kernel/wm";
import { useSettings } from "@/kernel/settings";
import { getApp } from "@/kernel/registry";
import { cn } from "@/lib/cn";
import { Icon } from "@/shell/icons";
import { useViewport } from "@/lib/useViewport";

/** Below this width the minimized-windows tray is folded into the dock:
 *  drawn separately above it, it read as a second, smaller dock on phones. */
export const NARROW_DOCK = 768;

/** The dock is data, not markup: it renders whatever ids are in
 *  `settings.dockApps`, in that order, and supports drag-to-reorder in place. */
export function Dock({ onLauncher }: { onLauncher: () => void }) {
  const wm = useWM();
  const { dockApps, dockPosition, dockMagnify, dockAutohide, dockLabels, reorderDock, motion } = useSettings();
  const [hovered, setHovered] = useState<number | null>(null);
  const [peek, setPeek] = useState(false);
  const dragIndex = useRef<number | null>(null);
  const vp = useViewport();
  const narrow = vp.w < NARROW_DOCK;

  if (dockPosition === "hidden") return null;
  const minimized = narrow ? wm.windows.filter((w) => w.state === "minimized" && (w.pinned || w.workspace === wm.activeWorkspace)) : [];

  const vertical = dockPosition === "left" || dockPosition === "right";
  // "Running" means running HERE. Counting every workspace put a solid dot
  // under an app you cannot see, and made the hollow "open elsewhere" marker
  // below unreachable — a guard that excludes exactly the case it exists for.
  const running = new Set(
    wm.windows.filter((w) => w.pinned || w.workspace === wm.activeWorkspace).map((w) => w.appId),
  );
  const hiddenAway = dockAutohide && !peek;

  const scaleFor = (i: number) => {
    if (!dockMagnify || hovered === null || !motion) return 1;
    const d = Math.abs(i - hovered);
    return d === 0 ? 1.42 : d === 1 ? 1.2 : d === 2 ? 1.07 : 1;
  };

  return (
    <div
      onMouseEnter={() => setPeek(true)}
      onMouseLeave={() => { setPeek(false); setHovered(null); }}
      className={cn(
        "fixed z-[9000] flex items-end justify-center",
        dockPosition === "bottom" && "bottom-0 left-0 right-0 pb-2",
        dockPosition === "top" && "top-10 left-0 right-0 pt-2 items-start",
        dockPosition === "left" && "left-0 top-0 bottom-0 pl-2 items-center",
        dockPosition === "right" && "right-0 top-0 bottom-0 pr-2 items-center justify-end",
      )}
      style={{
        transform: hiddenAway
          ? dockPosition === "bottom" ? "translateY(calc(100% - 6px))"
          : dockPosition === "top" ? "translateY(calc(-100% + 6px))"
          : dockPosition === "left" ? "translateX(calc(-100% + 6px))"
          : "translateX(calc(100% - 6px))"
          : "none",
        transition: motion ? "transform 240ms cubic-bezier(.2,.9,.3,1)" : "none",
      }}
    >
      <div
        className={cn("glass no-select flex gap-1.5 p-1.5", vertical ? "flex-col" : "flex-row", "items-center", narrow && !vertical && "max-w-[calc(100vw-16px)] overflow-x-auto")}
        style={{ borderRadius: "calc(var(--radius) * 1.2)" }}
        data-dock
      >
        <DockButton
          label="Launcher"
          icon="launcher"
          active={false}
          running={false}
          scale={1}
          showLabel={dockLabels}
          vertical={vertical}
          onClick={onLauncher}
        />
        <div className={cn("bg-[var(--border)]", vertical ? "h-px w-6" : "h-6 w-px")} />
        {dockApps.map((id, i) => {
          const app = getApp(id);
          if (!app) return null;
          return (
            <DockButton
              key={id}
              label={app.name}
              icon={app.icon}
              accent={app.accent}
              running={running.has(id)}
              active={wm.windows.some((w) => w.appId === id && w.id === wm.focused)}
              // A dot per workspace this app is open on, so "it is running,
              // just not here" is visible rather than puzzling.
              elsewhere={wm.windows.some(
                (w) => w.appId === id && !w.pinned && w.workspace !== wm.activeWorkspace,
              )}
              scale={scaleFor(i)}
              showLabel={dockLabels}
              vertical={vertical}
              onMouseEnter={() => setHovered(i)}
              draggable
              onDragStart={() => (dragIndex.current = i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragIndex.current !== null && dragIndex.current !== i) reorderDock(dragIndex.current, i);
                dragIndex.current = null;
              }}
              onClick={() => {
                // Only windows you can actually SEE from here. Filtering on
                // appId alone restored a window sitting on another workspace,
                // so the tile lit up and nothing appeared — the same mistake
                // `singleton` used to make in wm.open.
                const open = wm.windows.filter(
                  (w) => w.appId === id && (w.pinned || w.workspace === wm.activeWorkspace),
                );
                if (!open.length) {
                  wm.open(id, { title: app.name, icon: app.icon, size: app.defaultSize, singleton: app.singleton });
                } else if (open.some((w) => w.id === wm.focused && w.state !== "minimized")) {
                  // Clicking the focused app's dock tile hides it, like macOS.
                  open.forEach((w) => wm.minimize(w.id));
                } else {
                  wm.restore(open[0].id);
                }
              }}
              onAuxClick={(e) => {
                // Middle-click opens an extra instance of a non-singleton app.
                if (e.button === 1 && !app.singleton) {
                  e.preventDefault();
                  wm.open(id, { title: app.name, icon: app.icon, size: app.defaultSize });
                }
              }}
            />
          );
        })}
        {minimized.length > 0 && (
          <>
            <div className={cn("bg-[var(--border)]", vertical ? "h-px w-6" : "h-6 w-px")} />
            {minimized.map((w) => (
              <DockButton
                key={w.id}
                label={`Restore ${w.title}`}
                icon={w.icon}
                running
                active={false}
                scale={1}
                showLabel={dockLabels}
                vertical={vertical}
                onClick={() => wm.restore(w.id)}
                data-dock-minimized={w.id}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

interface DockButtonProps extends React.HTMLAttributes<HTMLButtonElement> {
  label: string;
  icon: string;
  accent?: string;
  running: boolean;
  active: boolean;
  /** Open on another workspace, not this one. */
  elsewhere?: boolean;
  scale: number;
  showLabel: boolean;
  vertical: boolean;
  draggable?: boolean;
}

function DockButton({ label, icon, accent, running, active, elsewhere, scale, showLabel, vertical, ...rest }: DockButtonProps) {
  return (
    <button
      {...rest}
      title={label}
      aria-label={label}
      className="group relative grid place-items-center rounded-[calc(var(--radius)*0.8)] transition-transform"
      style={{
        width: "var(--dock-size)",
        height: "var(--dock-size)",
        transform: `scale(${scale})`,
        transformOrigin: vertical ? "left center" : "bottom center",
        background: active
          ? `color-mix(in srgb, ${accent ?? "var(--accent)"} 26%, transparent)`
          : "color-mix(in srgb, var(--panel-solid) 60%, transparent)",
        border: `1px solid ${active ? (accent ?? "var(--accent)") : "var(--border)"}`,
        transitionDuration: "160ms",
      }}
    >
      <Icon name={icon} size="calc(var(--dock-size) * 0.46)" />
      {showLabel && <span className="mt-0.5 max-w-full truncate px-1 text-[9px] text-[var(--muted)]">{label}</span>}
      {running && (
        <span
          className="absolute rounded-full"
          style={{
            background: accent ?? "var(--accent)",
            ...(vertical ? { left: 2, top: "50%", width: 3, height: 12, marginTop: -6 } : { bottom: 2, left: "50%", width: 12, height: 3, marginLeft: -6 }),
          }}
        />
      )}
      {/* A hollow marker for "running, but on another desktop". Without it,
          clicking the tile opens a second copy for no visible reason. */}
      {!running && elsewhere && (
        <span
          className="absolute rounded-full"
          style={{
            border: `1px solid ${accent ?? "var(--accent)"}`,
            ...(vertical ? { left: 2, top: "50%", width: 3, height: 8, marginTop: -4 } : { bottom: 2, left: "50%", width: 8, height: 3, marginLeft: -4 }),
          }}
        />
      )}
      {!showLabel && (
        <span
          className={cn(
            "pointer-events-none absolute whitespace-nowrap rounded-md bg-[var(--panel-solid)] px-2 py-1 text-[11px] opacity-0 shadow-lg transition group-hover:opacity-100",
            vertical ? "left-full ml-2" : "bottom-full mb-2",
          )}
          style={{ border: "1px solid var(--border)" }}
        >
          {label}
        </span>
      )}
    </button>
  );
}
