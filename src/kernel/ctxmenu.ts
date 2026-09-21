"use client";

/** The open context menu, and the registry that lets any element contribute to
 *  one without knowing anything about the shell.
 *
 *  A store rather than React context because the global `contextmenu` listener
 *  is installed once on the document and has to reach the menu from outside the
 *  tree. The decisions (placement, keyboard, assembly) are in
 *  `src/lib/ctxmenu.ts`, which is pure and tested.
 */
import { create } from "zustand";
import type { Entry, MenuSection } from "@/lib/ctxmenu";

export interface OpenMenu {
  x: number;
  y: number;
  entries: Entry[];
  /** Set when the menu was opened by keyboard (Shift+F10 / the Menu key), so
   *  the first item takes focus immediately as the ARIA pattern requires. */
  viaKeyboard: boolean;
}

interface CtxMenuState {
  menu: OpenMenu | null;
  show: (m: OpenMenu) => void;
  hide: () => void;
}

export const useCtxMenu = create<CtxMenuState>()((set) => ({
  menu: null,
  show: (menu) => set({ menu }),
  hide: () => set({ menu: null }),
}));

/* ── the contributor registry ────────────────────────────────────────────── */

export interface TargetContext {
  /** The element the right-click actually landed on. */
  target: HTMLElement;
  /** The registered element that matched. */
  host: HTMLElement;
  event: MouseEvent;
}

export type SectionBuilder = (ctx: TargetContext) => MenuSection | MenuSection[] | null;

/**
 * Elements that want to add items to a right-click menu.
 *
 * A WeakMap so an unmounted element is collected without anyone having to
 * remember to unregister — though `useContextMenu` unregisters anyway, because
 * relying on GC for correctness is how you get a menu built from a component
 * that no longer exists.
 */
const targets = new WeakMap<HTMLElement, SectionBuilder>();

export function registerContextTarget(el: HTMLElement, build: SectionBuilder): () => void {
  targets.set(el, build);
  return () => targets.delete(el);
}

/**
 * Every contributor from the event target up to the document, nearest first.
 *
 * Nearest-first is what makes the menu read correctly: the thing you clicked
 * contributes before the window that contains it, which contributes before the
 * desktop underneath.
 */
export function collectSections(target: HTMLElement, event: MouseEvent): MenuSection[] {
  const out: MenuSection[] = [];
  let el: HTMLElement | null = target;
  while (el) {
    const build = targets.get(el);
    if (build) {
      const got = build({ target, host: el, event });
      if (got) out.push(...(Array.isArray(got) ? got : [got]));
    }
    el = el.parentElement;
  }
  return out;
}
