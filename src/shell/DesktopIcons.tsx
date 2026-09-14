"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSettings, type DesktopItem } from "@/kernel/settings";
import { useWM } from "@/kernel/wm";
import { useVFS } from "@/kernel/vfs";
import { getApp } from "@/kernel/registry";
import { useStudio } from "@/apps/Studio";
import { bus } from "@/kernel/bus";
import { Icon } from "./icons";
import { cn } from "@/lib/cn";

/* ────────────────────────────────────────────────────────────────────────────
   The desktop surface: marquee selection and free-positioned icons.

   This is the interaction everyone has muscle memory for from macOS and
   Windows, and the details are what make it feel right rather than
   approximately right:

   - A drag that starts on empty desktop draws a rubber band; a drag that
     starts on an icon moves icons. The same pointerdown cannot mean both, so
     the target decides.
   - Dragging an icon that is already part of a selection moves the whole
     selection. Dragging an unselected icon selects it first, discarding the
     old selection — which is what every desktop does and what people expect.
   - Nothing commits until pointerup. During the drag we translate visually, so
     moving twelve icons is one state write instead of one per frame.
   - Shift or Cmd/Ctrl adds to the selection instead of replacing it.
   ──────────────────────────────────────────────────────────────────────────── */

const GRID = 92;
const ICON_W = 84;
const ICON_H = 88;

interface Rect { x: number; y: number; w: number; h: number }

const intersects = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

export function DesktopIcons({ topInset }: { topInset: number }) {
  const settings = useSettings();
  const wm = useWM();
  const vfs = useVFS();
  const userApps = useStudio((s) => s.apps);

  const [selected, setSelected] = useState<string[]>([]);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [drag, setDrag] = useState<{ dx: number; dy: number; ids: string[] } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const marqueeStart = useRef<{ x: number; y: number } | null>(null);
  // Live pixel offset during a drag, so we can translate without writing state.
  const [dragDelta, setDragDelta] = useState<{ dx: number; dy: number }>({ dx: 0, dy: 0 });

  const items = settings.desktopItems;

  /** Resolve an item to something renderable, whatever kind it is. */
  const resolve = useCallback(
    (item: DesktopItem): { label: string; icon: string; accent?: string; open: () => void } | null => {
      if (item.kind === "app") {
        const app = getApp(item.ref);
        if (!app) return null;
        return {
          label: item.label ?? app.name,
          icon: app.icon,
          accent: app.accent,
          open: () => wm.open(app.id, { title: app.name, icon: app.icon, size: app.defaultSize, singleton: app.singleton }),
        };
      }
      if (item.kind === "userapp") {
        const ua = userApps.find((a) => a.id === item.ref);
        if (!ua) return null;
        return {
          label: item.label ?? ua.name,
          icon: "app",
          accent: "var(--accent2)",
          // Studio hosts the runtime, so a built app opens in its sandbox.
          open: () => bus.emit("app:open", { appId: "studio", args: { runUserApp: ua.id } }),
        };
      }
      const node = vfs.read(item.ref);
      if (!node) return null;
      const editor = node.name.endsWith(".md") || node.name.endsWith(".txt") ? "notes" : "ide";
      return {
        label: item.label ?? node.name,
        icon: "file",
        accent: "var(--muted)",
        open: () => bus.emit("app:open", { appId: editor, args: { path: node.path } }),
      };
    },
    [wm, vfs, userApps],
  );

  // An item whose target no longer exists (app uninstalled, file deleted) is
  // shown as a dead icon rather than silently vanishing, so the user can
  // choose to remove it.
  const resolved = useMemo(
    () => items.map((item) => ({ item, view: resolve(item) })),
    [items, resolve],
  );

  /* ── Marquee ─────────────────────────────────────────────────────────── */
  const onSurfacePointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Only a drag starting on bare desktop draws a band.
      if ((e.target as HTMLElement).closest("[data-desktop-icon]")) return;
      if (e.button !== 0) return;
      const host = surfaceRef.current;
      if (!host) return;
      const box = host.getBoundingClientRect();
      const x = e.clientX - box.left;
      const y = e.clientY - box.top;
      marqueeStart.current = { x, y };
      setMarquee({ x, y, w: 0, h: 0 });
      setMenu(null);
      if (!e.shiftKey && !e.metaKey && !e.ctrlKey) setSelected([]);
      host.setPointerCapture(e.pointerId);
    },
    [],
  );

  const onSurfacePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const host = surfaceRef.current;

      if (drag && host) {
        const box = host.getBoundingClientRect();
        setDragDelta({ dx: e.clientX - box.left - drag.dx, dy: e.clientY - box.top - drag.dy });
        return;
      }

      const start = marqueeStart.current;
      if (!start || !host) return;
      const box = host.getBoundingClientRect();
      const cx = e.clientX - box.left;
      const cy = e.clientY - box.top;
      const rect: Rect = {
        x: Math.min(start.x, cx),
        y: Math.min(start.y, cy),
        w: Math.abs(cx - start.x),
        h: Math.abs(cy - start.y),
      };
      setMarquee(rect);

      const hits = resolved
        .filter(({ item }) => intersects(rect, { x: item.x, y: item.y, w: ICON_W, h: ICON_H }))
        .map(({ item }) => item.id);
      // Additive when a modifier is held, so you can lasso in two passes.
      setSelected((prev) => (e.shiftKey || e.metaKey || e.ctrlKey ? [...new Set([...prev, ...hits])] : hits));
    },
    [drag, resolved],
  );

  const commitDrag = useCallback(() => {
    if (!drag) return;
    const { dx, dy } = dragDelta;
    if (dx !== 0 || dy !== 0) {
      const moving = drag.ids.map((id) => items.find((d) => d.id === id)!).filter(Boolean);
      const maxX = (surfaceRef.current?.clientWidth ?? 1200) - ICON_W;
      // Leave room for the dock so an icon cannot be dragged underneath it.
      const maxY = (surfaceRef.current?.clientHeight ?? 800) - ICON_H - 76;

      // Clamp the DELTA against the whole selection's bounding box, not each
      // icon on its own. Clamping individually lets the leading icon stop at
      // the edge while the rest keep going, which quietly destroys the
      // arrangement the user had built.
      const minIx = Math.min(...moving.map((i) => i.x));
      const maxIx = Math.max(...moving.map((i) => i.x));
      const minIy = Math.min(...moving.map((i) => i.y));
      const maxIy = Math.max(...moving.map((i) => i.y));
      const cdx = Math.max(-minIx, Math.min(maxX - maxIx, dx));
      const cdy = Math.max(-minIy, Math.min(maxY - maxIy, dy));

      const snap = (n: number) => (settings.snapIconsToGrid ? Math.round(n / GRID) * GRID : n);
      settings.moveDesktopItems(
        moving.map((it) => ({ id: it.id, x: Math.max(0, snap(it.x + cdx)), y: Math.max(0, snap(it.y + cdy)) })),
      );
    }
    setDrag(null);
    setDragDelta({ dx: 0, dy: 0 });
  }, [drag, dragDelta, items, settings]);

  const onSurfacePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (drag) commitDrag();
      marqueeStart.current = null;
      setMarquee(null);
      try { surfaceRef.current?.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    },
    [drag, commitDrag],
  );

  /* ── Icon pointer handling ───────────────────────────────────────────── */
  const onIconPointerDown = useCallback(
    (e: React.PointerEvent, id: string) => {
      if (e.button === 2) return; // right-click opens the menu instead
      e.stopPropagation();
      setMenu(null);

      const additive = e.shiftKey || e.metaKey || e.ctrlKey;
      let ids: string[];
      if (additive) {
        ids = selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id];
        setSelected(ids);
        return; // a modifier click toggles; it does not start a drag
      }
      // Dragging something already selected moves the whole selection.
      ids = selected.includes(id) ? selected : [id];
      setSelected(ids);

      const host = surfaceRef.current;
      if (!host) return;
      const box = host.getBoundingClientRect();
      setDrag({ dx: e.clientX - box.left, dy: e.clientY - box.top, ids });
      setDragDelta({ dx: 0, dy: 0 });
      host.setPointerCapture(e.pointerId);
    },
    [selected],
  );

  /* ── Keyboard ────────────────────────────────────────────────────────── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes((e.target as HTMLElement)?.tagName);
      if (typing || renaming) return;

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a" && settings.showDesktopIcons) {
        // Only claim select-all when the desktop is what you are looking at.
        if (wm.windows.some((w) => w.state !== "minimized" && (w.pinned || w.workspace === wm.activeWorkspace))) return;
        e.preventDefault();
        setSelected(items.map((i) => i.id));
        return;
      }
      if (!selected.length) return;

      if (e.key === "Escape") { setSelected([]); return; }
      if (e.key === "Enter") {
        e.preventDefault();
        for (const id of selected) resolved.find((r) => r.item.id === id)?.view?.open();
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        settings.removeDesktopItems(selected);
        setSelected([]);
        return;
      }
      const nudge: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
      };
      const d = nudge[e.key];
      if (d) {
        e.preventDefault();
        const step = e.shiftKey ? GRID : 8;
        settings.moveDesktopItems(
          selected.map((id) => {
            const it = items.find((x) => x.id === id)!;
            return { id, x: Math.max(0, it.x + d[0] * step), y: Math.max(0, it.y + d[1] * step) };
          }),
        );
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, items, resolved, settings, renaming, wm.windows, wm.activeWorkspace]);

  if (!settings.showDesktopIcons) return null;

  return (
    <div
      ref={surfaceRef}
      onPointerDown={onSurfacePointerDown}
      onPointerMove={onSurfacePointerMove}
      onPointerUp={onSurfacePointerUp}
      onPointerCancel={onSurfacePointerUp}
      className="absolute inset-x-0 bottom-0 z-[1]"
      style={{ top: topInset }}
    >
      {resolved.map(({ item, view }) => {
        const isSel = selected.includes(item.id);
        const moving = drag?.ids.includes(item.id);
        return (
          <div
            key={item.id}
            data-desktop-icon={item.id}
            onPointerDown={(e) => onIconPointerDown(e, item.id)}
            onDoubleClick={(e) => { e.stopPropagation(); view?.open(); }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (!selected.includes(item.id)) setSelected([item.id]);
              setMenu({ x: e.clientX, y: e.clientY, id: item.id });
            }}
            className={cn(
              "no-select absolute flex cursor-default flex-col items-center gap-1 rounded-lg p-1.5 text-center",
              isSel ? "bg-[var(--accent)]/25 ring-1 ring-[var(--accent)]" : "hover:bg-white/10",
              moving && "opacity-80",
            )}
            style={{
              left: item.x,
              top: item.y,
              width: ICON_W,
              transform: moving ? `translate(${dragDelta.dx}px, ${dragDelta.dy}px)` : undefined,
              zIndex: moving ? 5 : 2,
              fontSize: `calc(1em * ${settings.iconSize})`,
            }}
            title={view ? `${view.label} — double-click to open` : "This item's target no longer exists"}
          >
            <Icon
              name={view?.icon ?? "ban"}
              size={26 * settings.iconSize}
              style={{ color: view ? view.accent ?? "var(--accent)" : "var(--danger)" }}
            />
            {renaming === item.id ? (
              <input
                autoFocus
                defaultValue={view?.label ?? item.ref}
                onPointerDown={(e) => e.stopPropagation()}
                onBlur={(e) => { settings.renameDesktopItem(item.id, e.target.value.trim()); setRenaming(null); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") setRenaming(null);
                }}
                className="w-full rounded bg-[var(--panel-solid)] px-1 text-center text-[10px] outline-none ring-1 ring-[var(--accent)]"
              />
            ) : (
              <span className="w-full break-words text-[10px] leading-tight">
                {view?.label ?? item.ref}
              </span>
            )}
          </div>
        );
      })}

      {/* Rubber band. Rendered above icons so the outline stays visible over them. */}
      {marquee && (marquee.w > 2 || marquee.h > 2) && (
        <div
          className="pointer-events-none absolute z-[4] rounded-[3px]"
          style={{
            left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h,
            border: "1px solid var(--accent)",
            background: "color-mix(in srgb, var(--accent) 18%, transparent)",
          }}
        />
      )}

      {selected.length > 1 && !marquee && (
        <div
          className="glass pointer-events-none absolute left-1/2 z-[6] -translate-x-1/2 px-2.5 py-1 text-[11px]"
          style={{ bottom: 92, borderRadius: 99 }}
        >
          {selected.length} selected — drag to move them together
        </div>
      )}

      {menu && (
        <IconMenu
          x={menu.x}
          y={menu.y}
          count={selected.length}
          onClose={() => setMenu(null)}
          onOpen={() => selected.forEach((id) => resolved.find((r) => r.item.id === id)?.view?.open())}
          onRename={() => setRenaming(menu.id)}
          onRemove={() => { settings.removeDesktopItems(selected); setSelected([]); }}
          onTidy={() => settings.tidyDesktop()}
        />
      )}
    </div>
  );
}

function IconMenu({ x, y, count, onClose, onOpen, onRename, onRemove, onTidy }: {
  x: number; y: number; count: number;
  onClose: () => void; onOpen: () => void; onRename: () => void; onRemove: () => void; onTidy: () => void;
}) {
  useEffect(() => {
    const close = () => onClose();
    const t = setTimeout(() => window.addEventListener("pointerdown", close), 0);
    window.addEventListener("keydown", close);
    return () => { clearTimeout(t); window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", close); };
  }, [onClose]);

  const items: Array<{ label: string; run: () => void; disabled?: boolean }> = [
    { label: count > 1 ? `Open ${count} items` : "Open", run: onOpen },
    { label: "Rename", run: onRename, disabled: count > 1 },
    { label: count > 1 ? `Remove ${count} from desktop` : "Remove from desktop", run: onRemove },
    { label: "Tidy up", run: onTidy },
  ];
  return (
    <div
      className="glass fixed z-[9800] w-52 p-1.5 shadow-2xl"
      style={{
        left: Math.min(x, window.innerWidth - 220),
        top: Math.min(y, window.innerHeight - 180),
        borderRadius: "var(--radius)",
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {items.map((it) => (
        <button
          key={it.label}
          disabled={it.disabled}
          onClick={() => { it.run(); onClose(); }}
          className="w-full rounded-md px-2.5 py-1.5 text-left text-[12px] hover:bg-[var(--accent)]/18 disabled:opacity-40 disabled:hover:bg-transparent"
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
