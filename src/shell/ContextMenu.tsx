"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useCtxMenu } from "@/kernel/ctxmenu";
import {
  placeMenu, placeSubmenu, moveFocus, firstFocusable, lastFocusable, typeAhead,
  isItem, isSeparator, TYPEAHEAD_MS, type Entry, type MenuItem,
} from "@/lib/ctxmenu";
import { Icon } from "@/shell/icons";
import { cn } from "@/lib/cn";

/* The menu itself. One instance, mounted by the shell, driven by the store.
 *
 * Follows the WAI-ARIA menu pattern rather than approximating it: role=menu
 * with roving focus, Up/Down wrapping over separators and disabled items,
 * Home/End, Left/Right for submenus, Escape closing one level at a time, and
 * type-ahead. Those rules live in src/lib/ctxmenu.ts and are tested there. */

const EST_ITEM_H = 28;
const EST_SEP_H = 9;
const MIN_W = 200;

/** A menu's size before it is in the DOM. Measuring after mount and then
 *  moving would show the menu in the wrong place for a frame, which is very
 *  visible at the screen edge — so the first paint uses an estimate and a
 *  layout effect corrects it before the browser paints. */
function estimate(entries: Entry[]): { w: number; h: number } {
  let h = 8;
  let longest = 0;
  for (const e of entries) {
    if (isSeparator(e)) { h += EST_SEP_H; continue; }
    h += EST_ITEM_H;
    longest = Math.max(longest, e.label.length + (e.hint?.length ?? 0) + (e.submenu ? 3 : 0));
  }
  return { w: Math.max(MIN_W, Math.min(360, 44 + longest * 7)), h };
}

export function ContextMenuHost() {
  const menu = useCtxMenu((s) => s.menu);
  const hide = useCtxMenu((s) => s.hide);
  if (!menu) return null;
  return (
    <MenuLevel
      key={`${menu.x}:${menu.y}`}
      entries={menu.entries}
      x={menu.x}
      y={menu.y}
      autoFocus={menu.viaKeyboard}
      onClose={hide}
      depth={0}
    />
  );
}

function MenuLevel({
  entries, x, y, onClose, onDone, depth, autoFocus, parentRect,
}: {
  entries: Entry[];
  x: number;
  y: number;
  /** Close this level (Escape, Left in a submenu). */
  onClose: () => void;
  /** Close the whole menu: an item was chosen. A submenu used to close only
   *  itself here, leaving the parent menu open after every choice in it. */
  onDone?: () => void;
  depth: number;
  autoFocus?: boolean;
  /** Present for a submenu: the parent menu's box, so it can flip sides. */
  parentRect?: { x: number; w: number };
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState<number>(autoFocus ? firstFocusable(entries) : -1);
  const [openSub, setOpenSub] = useState<number | null>(null);
  const buffer = useRef("");
  const bufferAt = useRef(0);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const est = estimate(entries);
  const vp = { w: typeof window === "undefined" ? 1440 : window.innerWidth, h: typeof window === "undefined" ? 900 : window.innerHeight };
  const initial = parentRect
    ? placeSubmenu(parentRect.x, parentRect.w, y, est.w, est.h, vp)
    : placeMenu(x, y, est.w, est.h, vp);
  const [pos, setPos] = useState({ x: initial.x, y: initial.y, maxHeight: initial.maxHeight });
  // The measured width lives in state, not read off the ref during render:
  // reading ref.current in the render body trips the React Compiler `refs`
  // rule, which is an error in this repo, and would also be a real tearing
  // hazard since the ref is mutated by the layout effect below.
  const [measuredW, setMeasuredW] = useState(est.w);

  // Correct the estimate against the real box BEFORE paint, so a menu at the
  // screen edge is never briefly drawn in the wrong place.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const v = { w: window.innerWidth, h: window.innerHeight };
    const p = parentRect
      ? placeSubmenu(parentRect.x, parentRect.w, y, r.width, r.height, v)
      : placeMenu(x, y, r.width, r.height, v);
    setPos((prev) => (prev.x === p.x && prev.y === p.y ? prev : { x: p.x, y: p.y, maxHeight: p.maxHeight }));
    setMeasuredW((prev) => (Math.abs(prev - r.width) < 1 ? prev : r.width));
  }, [x, y, parentRect, entries]);

  // Focus the menu so it receives keys even when the click came from an iframe
  // or a control that kept focus.
  useEffect(() => {
    if (depth === 0) ref.current?.focus({ preventScroll: true });
  }, [depth]);

  const runItem = useCallback((it: MenuItem) => {
    if (it.disabled) return;
    if (it.submenu) return;
    (onDone ?? onClose)();
    // After the menu is gone, so an action that opens a window is not fighting
    // the menu's own teardown for focus.
    queueMicrotask(() => it.run?.());
  }, [onClose, onDone]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const k = e.key;
    if (k === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); return; }
    if (k === "ArrowDown" || k === "ArrowUp") {
      e.preventDefault(); e.stopPropagation();
      setFocus((f) => moveFocus(entries, f, k === "ArrowDown" ? 1 : -1));
      setOpenSub(null);
      return;
    }
    if (k === "Home" || k === "End") {
      e.preventDefault(); e.stopPropagation();
      setFocus(k === "Home" ? firstFocusable(entries) : lastFocusable(entries));
      return;
    }
    if (k === "ArrowRight") {
      const cur = entries[focus];
      if (cur && isItem(cur) && cur.submenu) { e.preventDefault(); e.stopPropagation(); setOpenSub(focus); }
      return;
    }
    if (k === "ArrowLeft") {
      if (depth > 0) { e.preventDefault(); e.stopPropagation(); onClose(); }
      return;
    }
    if (k === "Enter" || k === " ") {
      const cur = entries[focus];
      if (!cur || !isItem(cur)) return;
      e.preventDefault(); e.stopPropagation();
      if (cur.submenu) setOpenSub(focus);
      else runItem(cur);
      return;
    }
    // Type-ahead: single printable characters only.
    if (k.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const now = Date.now();
      buffer.current = now - bufferAt.current > TYPEAHEAD_MS ? k : buffer.current + k;
      bufferAt.current = now;
      const hit = typeAhead(entries, buffer.current, focus);
      if (hit >= 0) { e.preventDefault(); e.stopPropagation(); setFocus(hit); }
    }
  };

  const subRect = { x: pos.x, w: measuredW };

  return (
    <>
      <div
        ref={ref}
        role="menu"
        tabIndex={-1}
        aria-orientation="vertical"
        onKeyDown={onKeyDown}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
        className="glass fixed z-[9950] overflow-y-auto rounded-lg py-1 shadow-[0_18px_50px_-12px_rgba(0,0,0,0.7)] outline-none"
        style={{ left: pos.x, top: pos.y, minWidth: MIN_W, maxHeight: pos.maxHeight }}
      >
        {entries.map((e, i) =>
          isSeparator(e) ? (
            <div key={`s${i}`} role="separator" className="my-1 h-px bg-[var(--border)]" />
          ) : (
            <div
              key={e.id}
              role={e.checked === undefined ? "menuitem" : "menuitemcheckbox"}
              aria-checked={e.checked === undefined ? undefined : !!e.checked}
              aria-disabled={e.disabled || undefined}
              aria-haspopup={e.submenu ? "menu" : undefined}
              aria-expanded={e.submenu ? openSub === i : undefined}
              tabIndex={-1}
              onMouseEnter={() => {
                setFocus(i);
                if (hoverTimer.current) clearTimeout(hoverTimer.current);
                // A short delay before opening a submenu, and before closing a
                // sibling's, so crossing the list diagonally does not flicker.
                hoverTimer.current = setTimeout(() => setOpenSub(e.submenu ? i : null), e.submenu ? 90 : 160);
              }}
              onClick={(ev) => { ev.stopPropagation(); runItem(e); }}
              className={cn(
                "mx-1 flex cursor-default items-center gap-2 rounded px-2 py-1 text-[12.5px]",
                e.disabled ? "opacity-40" : "hover:bg-[var(--accent)]/18",
                focus === i && !e.disabled && "bg-[var(--accent)]/22",
                e.danger && !e.disabled && "text-[var(--danger)]",
              )}
            >
              <span className="flex w-4 shrink-0 justify-center">
                {e.checked ? <Icon name="check" size={11} /> : e.icon ? <Icon name={e.icon} size={12} /> : null}
              </span>
              <span className="min-w-0 flex-1 truncate">{e.label}</span>
              {e.hint && <span className="shrink-0 text-[10.5px] text-[var(--muted)]">{e.hint}</span>}
              {e.submenu && <Icon name="chevronRight" size={11} className="shrink-0 opacity-60" />}
            </div>
          ),
        )}
      </div>

      {openSub !== null && (() => {
        const parent = entries[openSub];
        if (!parent || !isItem(parent) || !parent.submenu) return null;
        const itemTop = pos.y + offsetOf(entries, openSub);
        return (
          <MenuLevel
            entries={parent.submenu}
            x={pos.x}
            y={itemTop}
            parentRect={subRect}
            depth={depth + 1}
            onClose={() => setOpenSub(null)}
            onDone={onDone ?? onClose}
          />
        );
      })()}
    </>
  );
}

/** Vertical offset of item `index` inside a menu, from the same estimates the
 *  first paint uses. Good enough to line a submenu up with its parent item. */
function offsetOf(entries: Entry[], index: number): number {
  let h = 4;
  for (let i = 0; i < index; i++) h += isSeparator(entries[i]) ? EST_SEP_H : EST_ITEM_H;
  return h;
}
