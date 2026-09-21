"use client";

import { useEffect } from "react";
import { useWM } from "@/kernel/wm";
import { useSettings } from "@/kernel/settings";
import { getApp } from "@/kernel/registry";
import { bus } from "@/kernel/bus";
import { useScenes } from "@/kernel/scenes";
import { useCtxMenu, collectSections } from "@/kernel/ctxmenu";
import { mergeSections, labelFor, type Entry, type MenuSection } from "@/lib/ctxmenu";
import { LAYOUTS } from "@/lib/zones";

/* Right-click works everywhere, and it is this listener that guarantees it.
 *
 * Installed on the document in the CAPTURE phase for one specific reason: a
 * handler anywhere in the tree that calls stopPropagation would otherwise stop
 * the event reaching us, and the browser's own menu would appear instead.
 * Capture runs before every target and bubble handler, so nothing can prevent
 * it. That is also why this is the only contextmenu handler in the shell —
 * the surfaces that used to have their own now contribute sections instead.
 *
 * The bug this replaces: Desktop's handler returned early for anything inside
 * [role=dialog] BEFORE calling preventDefault, and every window carries
 * role="dialog". So right-clicking inside any window in the OS fell straight
 * through to Chrome. */

const isEditable = (el: HTMLElement | null): el is HTMLInputElement | HTMLTextAreaElement => {
  if (!el) return false;
  const t = el.tagName;
  if (t === "TEXTAREA") return true;
  if (t === "INPUT") return !["checkbox", "radio", "button", "submit", "range", "color", "file"].includes((el as HTMLInputElement).type);
  return false;
};

const notify = (title: string, kind: "info" | "success" | "warn" | "error" = "info") =>
  bus.emit("notify", { title, kind });

async function writeClipboard(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    notify(`${what} copied`, "success");
  } catch {
    notify("The browser refused clipboard access — use the keyboard shortcut", "warn");
  }
}

export function useGlobalContextMenu() {
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      // An app that genuinely uses the right button itself — Minesweeper
      // flagging a square — marks its surface. We still suppress the browser
      // menu; we just do not add ours on top of the app's own gesture.
      if (target.closest("[data-ctx-skip]")) { e.preventDefault(); return; }

      e.preventDefault();

      const sections: MenuSection[] = [
        ...selectionSections(target, e),
        ...collectSections(target, e),
        ...windowSections(target),
        ...desktopSection(target, e),
        shellSection(),
      ];

      const entries = mergeSections(sections);
      if (!entries.length) return;
      useCtxMenu.getState().show({ x: e.clientX, y: e.clientY, entries, viaKeyboard: false });
    };

    // Shift+F10 and the Menu key open a context menu without a mouse — part of
    // the ARIA menu pattern, and the only way to reach these commands from the
    // keyboard.
    const onKeyDown = (e: KeyboardEvent) => {
      const wants = e.key === "ContextMenu" || (e.shiftKey && e.key === "F10");
      if (!wants) return;
      const el = (document.activeElement as HTMLElement) ?? document.body;
      const r = el.getBoundingClientRect();
      e.preventDefault();
      const fake = new MouseEvent("contextmenu", { clientX: r.left + 8, clientY: r.bottom });
      const sections: MenuSection[] = [
        ...selectionSections(el, fake),
        ...collectSections(el, fake),
        ...windowSections(el),
        ...desktopSection(el, fake),
        shellSection(),
      ];
      const entries = mergeSections(sections);
      if (!entries.length) return;
      useCtxMenu.getState().show({ x: r.left + 8, y: r.bottom, entries, viaKeyboard: true });
    };

    const close = () => useCtxMenu.getState().hide();
    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target as HTMLElement)?.closest("[role=menu]")) close();
    };

    document.addEventListener("contextmenu", onContextMenu, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("contextmenu", onContextMenu, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, []);
}

/* ── text, inputs, links and images ──────────────────────────────────────── */

function selectionSections(target: HTMLElement, e: MouseEvent): MenuSection[] {
  const out: MenuSection[] = [];
  const editable = isEditable(target);
  const sel = window.getSelection()?.toString() ?? "";
  const fieldSel = editable ? target.value.slice(target.selectionStart ?? 0, target.selectionEnd ?? 0) : "";
  const text = (editable ? fieldSel : sel).trim();

  if (editable || text) {
    const entries: Entry[] = [];
    if (editable) {
      entries.push({
        id: "cut", label: "Cut", icon: "copy", hint: "Ctrl X", disabled: !fieldSel,
        run: () => {
          const s = target.selectionStart ?? 0;
          const en = target.selectionEnd ?? 0;
          void writeClipboard(fieldSel, "Text");
          // Written through the native setter so React's onChange still fires;
          // assigning .value directly updates the DOM and leaves state stale.
          setFieldValue(target, target.value.slice(0, s) + target.value.slice(en), s);
        },
      });
    }
    entries.push({ id: "copy", label: "Copy", icon: "copy", hint: "Ctrl C", disabled: !text, run: () => void writeClipboard(text, "Text") });
    if (editable) {
      entries.push({
        id: "paste", label: "Paste", icon: "download", hint: "Ctrl V",
        run: async () => {
          try {
            const t = await navigator.clipboard.readText();
            const s = target.selectionStart ?? 0;
            const en = target.selectionEnd ?? 0;
            setFieldValue(target, target.value.slice(0, s) + t + target.value.slice(en), s + t.length);
          } catch {
            notify("The browser will not hand over the clipboard here — press Ctrl/Cmd+V", "warn");
          }
        },
      });
      entries.push({ id: "selectAll", label: "Select all", hint: "Ctrl A", run: () => target.select() });
    }
    out.push({ id: "edit", entries });
  }

  if (text) {
    const short = labelFor(text);
    out.push({
      id: "text",
      entries: [
        {
          id: "ask", label: `Ask AI about "${short}"`, icon: "spark",
          run: () => bus.emit("app:open", { appId: "chat", args: { prompt: `Explain this:\n\n${text.slice(0, 2000)}` } }),
        },
        {
          id: "search", label: `Search the web for "${short}"`, icon: "search",
          run: () => bus.emit("app:open", { appId: "browser", args: { url: `https://duckduckgo.com/?q=${encodeURIComponent(text.slice(0, 300))}` } }),
        },
      ],
    });
  }

  const link = target.closest("a[href]") as HTMLAnchorElement | null;
  if (link?.href) {
    out.push({
      id: "link",
      entries: [
        { id: "openLink", label: "Open link in Browser", icon: "browser", run: () => bus.emit("app:open", { appId: "browser", args: { url: link.href } }) },
        { id: "copyLink", label: "Copy link address", icon: "link", run: () => void writeClipboard(link.href, "Link") },
      ],
    });
  }

  const img = (target.tagName === "IMG" ? target : target.closest("img")) as HTMLImageElement | null;
  if (img?.src) {
    out.push({
      id: "image",
      entries: [
        { id: "openImg", label: "Open image in Browser", icon: "image", run: () => bus.emit("app:open", { appId: "browser", args: { url: img.src } }) },
        { id: "copyImg", label: "Copy image address", icon: "link", run: () => void writeClipboard(img.src, "Image address") },
      ],
    });
  }

  void e;
  return out;
}

/** React tracks an input's value on the DOM node; assigning `.value` directly
 *  updates the field but leaves React's copy stale, so the next render puts the
 *  old text back. Going through the prototype setter makes the input event look
 *  exactly like a user keystroke. */
function setFieldValue(el: HTMLInputElement | HTMLTextAreaElement, next: string, caret: number) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, next);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.setSelectionRange(caret, caret);
  el.focus();
}

/* ── the window you right-clicked in ─────────────────────────────────────── */

function windowSections(target: HTMLElement): MenuSection[] {
  const frame = target.closest("[data-window-id]") as HTMLElement | null;
  const id = frame?.dataset.windowId;
  if (!id) return [];
  const wm = useWM.getState();
  const win = wm.windows.find((w) => w.id === id);
  if (!win) return [];
  const app = getApp(win.appId);

  return [
    {
      id: "window",
      entries: [
        { id: "min", label: "Minimize", icon: "minimize", run: () => useWM.getState().minimize(id) },
        {
          id: "max", label: win.state === "maximized" ? "Restore" : "Maximize", icon: "maximize",
          run: () => useWM.getState().toggleMaximize(id),
        },
        { id: "pin", label: "Keep on every desktop", checked: !!win.pinned, run: () => useWM.getState().togglePin(id) },
        {
          id: "snap", label: "Move to", icon: "layout",
          submenu: (["left", "right", "tl", "tr", "bl", "br", "max"] as const).map((z) => ({
            id: `snap:${z}`,
            label: { left: "Left half", right: "Right half", tl: "Top left", tr: "Top right", bl: "Bottom left", br: "Bottom right", max: "Full screen" }[z],
            run: () => useWM.getState().snap(id, z),
          })),
        },
        {
          id: "send", label: "Send to desktop", icon: "workspaces",
          submenu: Array.from({ length: wm.workspaces }, (_, i) => i + 1).map((n) => ({
            id: `ws:${n}`, label: `Desktop ${n}`, checked: win.workspace === n,
            run: () => useWM.getState().sendToWorkspace(id, n),
          })),
        },
        { separator: true },
        ...(app && !app.singleton
          ? [{ id: "dup", label: `New ${app.name} window`, icon: "plus", run: () => useWM.getState().open(app.id, { title: app.name, icon: app.icon, size: app.defaultSize, forceNew: true }) }]
          : []),
        { id: "close", label: "Close", icon: "close", hint: "Ctrl W", danger: true, run: () => useWM.getState().close(id) },
      ],
    },
  ];
}

/* ── the bare desktop ────────────────────────────────────────────────────── */

/** Everything the old right-click-the-wallpaper menu offered, kept verbatim in
 *  behaviour, now shown only when the click really was on the desktop and not
 *  inside a window. */
function desktopSection(target: HTMLElement, e: MouseEvent): MenuSection[] {
  if (target.closest("[data-window-id]") || target.closest("[role=menu]")) return [];
  const s = useSettings.getState();
  return [
    {
      id: "desktop",
      entries: [
        { id: "pinHere", label: "Pin an app here…", icon: "pin", run: () => bus.emit("desktop:pin-picker", { x: e.clientX, y: e.clientY }) },
        { id: "newWidget", label: "New AI widget…", icon: "widgets", run: () => bus.emit("app:open", { appId: "personalize", args: { tab: "widgets", newWidget: true } }) },
        { id: "buildAI", label: "Build something with AI…", icon: "sparkles", run: () => bus.emit("app:open", { appId: "studio" }) },
        { separator: true },
        { id: "tidy", label: "Tidy desktop icons", icon: "grid", run: () => useSettings.getState().tidyDesktop() },
        { id: "snapGrid", label: "Snap icons to grid", checked: s.snapIconsToGrid, run: () => useSettings.getState().set("snapIconsToGrid", !s.snapIconsToGrid) },
        { id: "showDesk", label: "Show desktop", icon: "minimize", run: () => useWM.getState().minimizeAll() },
        { separator: true },
        { id: "motion", label: "Animations", checked: s.motion, run: () => useSettings.getState().set("motion", !s.motion) },
        {
          id: "pet", label: s.petVisible ? "Put the pet away" : "Bring out a pet", icon: "pet",
          run: () => {
            const st = useSettings.getState();
            if (!st.petVisible && st.pet === "none") st.set("pet", "cat");
            st.set("petVisible", !st.petVisible);
          },
        },
      ],
    },
  ];
}

/* ── always available ────────────────────────────────────────────────────── */

function shellSection(): MenuSection {
  const wm = useWM.getState();
  const s = useSettings.getState();
  const scenes = useScenes.getState().scenes;

  return {
    id: "shell",
    entries: [
      {
        id: "layouts", label: "Arrange windows", icon: "layout",
        submenu: [
          ...LAYOUTS.map((l) => ({ id: `l:${l.id}`, label: l.name, hint: l.hint, run: () => useWM.getState().applyLayout(l.id) })),
          ...(scenes.length ? ([{ separator: true }] as Entry[]) : []),
          ...scenes.slice(0, 6).map((sc) => ({
            id: `sc:${sc.id}`, label: `Scene: ${sc.name}`, icon: "backup",
            run: () => useScenes.getState().restore(sc.id, { replace: true }),
          })),
        ],
      },
      {
        id: "desktopN", label: "Desktop", icon: "workspaces",
        submenu: Array.from({ length: wm.workspaces }, (_, i) => i + 1).map((n) => ({
          id: `go:${n}`, label: `Desktop ${n}`, checked: wm.activeWorkspace === n,
          run: () => useWM.getState().setWorkspace(n),
        })),
      },
      { separator: true },
      { id: "widgets", label: "Show widgets", checked: s.showWidgets, run: () => useSettings.getState().set("showWidgets", !s.showWidgets) },
      { id: "icons", label: "Show desktop icons", checked: s.showDesktopIcons, run: () => useSettings.getState().set("showDesktopIcons", !s.showDesktopIcons) },
      { separator: true },
      { id: "personalize", label: "Personalize…", icon: "personalize", run: () => bus.emit("app:open", { appId: "personalize" }) },
      { id: "settings", label: "Settings…", icon: "settings", run: () => bus.emit("app:open", { appId: "settings" }) },
    ],
  };
}
