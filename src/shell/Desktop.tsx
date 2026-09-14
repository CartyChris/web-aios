"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWM } from "@/kernel/wm";
import { useSettings, resolveTokens } from "@/kernel/settings";
import { getApp } from "@/kernel/registry";
import { PETS } from "@/kernel/themes";
import { useHydrated } from "@/lib/useHydrated";
import { bus } from "@/kernel/bus";
import { WindowFrame } from "./Window";
import { Dock } from "./Dock";
import { TopBar } from "./TopBar";
import { Launcher } from "./Launcher";
import { CommandPalette } from "./CommandPalette";
import { WidgetLayer } from "./Widgets";
import { Wallpaper } from "./Wallpaper";
import { MobileShell } from "./MobileShell";
import { useViewport } from "@/lib/useViewport";
import { cn } from "@/lib/cn";
import { Icon, PetIcon } from "./icons";

export function Desktop() {
  const hydrated = useHydrated();
  const vp = useViewport();
  const wm = useWM();
  const settings = useSettings();
  const [launcher, setLauncher] = useState(false);
  const [palette, setPalette] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  // ── Token application ─────────────────────────────────────────────────────
  // Every appearance setting lands on <html> as a custom property. This is the
  // single place styling is applied; nothing else writes inline colours.
  useEffect(() => {
    if (!hydrated) return;
    const root = document.documentElement;
    const tokens = resolveTokens(settings);
    for (const [k, v] of Object.entries(tokens)) root.style.setProperty(k, v);
    root.dataset.motion = settings.motion ? "1" : "0";
    root.style.colorScheme = ["sakura", "paper", "daylight", "linen"].includes(settings.themeId) ? "light" : "dark";
  }, [hydrated, settings]);

  // ── Startup apps ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!hydrated) return;
    const fresh = useWM.getState().windows.length === 0;
    if (!fresh) return;
    for (const id of settings.startupApps) {
      const app = getApp(id);
      if (app) wm.open(id, { title: app.name, icon: app.icon, size: app.defaultSize, singleton: app.singleton });
    }
    // Intentionally boot-only: re-running on every settings change would
    // re-open apps the user just closed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  // ── Keybindings ───────────────────────────────────────────────────────────
  const matches = useCallback((e: KeyboardEvent, binding: string) => {
    const parts = binding.toLowerCase().split("+");
    const key = parts[parts.length - 1];
    const needMod = parts.includes("mod");
    const needShift = parts.includes("shift");
    const needAlt = parts.includes("alt");
    const mod = e.metaKey || e.ctrlKey;
    if (needMod !== mod) return false;
    if (needShift !== e.shiftKey) return false;
    if (needAlt !== e.altKey) return false;
    const named: Record<string, string> = { up: "arrowup", down: "arrowdown", left: "arrowleft", right: "arrowright" };
    return e.key.toLowerCase() === (named[key] ?? key);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const onKey = (e: KeyboardEvent) => {
      const kb = settings.keybinds;
      const focused = wm.focused;
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes((e.target as HTMLElement)?.tagName) || (e.target as HTMLElement)?.isContentEditable;

      // The palette and launcher must work even from inside a text field —
      // that is the whole point of a global command surface.
      if (matches(e, kb["palette.open"])) { e.preventDefault(); setPalette((v) => !v); setLauncher(false); return; }
      if (matches(e, kb["launcher.open"])) { e.preventDefault(); setLauncher((v) => !v); setPalette(false); return; }
      if (typing) return;

      const act: Array<[string, () => void]> = [
        ["window.close", () => focused && wm.close(focused)],
        ["window.maximize", () => focused && wm.toggleMaximize(focused)],
        ["window.minimize", () => focused && wm.minimize(focused)],
        ["window.cycle", () => wm.cycle(e.shiftKey ? -1 : 1)],
        ["window.snapLeft", () => focused && wm.snap(focused, "left")],
        ["window.snapRight", () => focused && wm.snap(focused, "right")],
        ["window.tile", () => wm.tileAll()],
        ["workspace.next", () => wm.setWorkspace(Math.min(wm.workspaces, wm.activeWorkspace + 1))],
        ["workspace.prev", () => wm.setWorkspace(Math.max(1, wm.activeWorkspace - 1))],
        ["shell.settings", () => wm.open("settings", { title: "Settings", icon: "settings", singleton: true, size: { w: 960, h: 680 } })],
        ["shell.showDesktop", () => wm.minimizeAll()],
      ];
      for (const [id, run] of act) {
        if (kb[id] && matches(e, kb[id])) { e.preventDefault(); run(); return; }
      }

      // ⌘1..9 jumps straight to a workspace.
      if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
        const n = Number(e.key);
        if (n <= wm.workspaces) { e.preventDefault(); wm.setWorkspace(n); }
      }
      if (e.key === "Escape") { setLauncher(false); setPalette(false); setMenu(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hydrated, settings.keybinds, wm, matches]);

  // ── Cross-app messaging ───────────────────────────────────────────────────
  useEffect(() => {
    const offOpen = bus.on("app:open", (p) => {
      const { appId, args } = (p ?? {}) as { appId?: string; args?: Record<string, unknown> };
      const app = appId ? getApp(appId) : null;
      if (app) wm.open(app.id, { title: app.name, icon: app.icon, size: app.defaultSize, singleton: app.singleton, args });
    });
    const offNotify = bus.on("notify", (p) => {
      const n = (p ?? {}) as { title?: string; body?: string; kind?: "info" | "success" | "warn" | "error" };
      if (n.title) wm.notify({ title: n.title, body: n.body, kind: n.kind ?? "info" });
    });
    return () => { offOpen(); offNotify(); };
  }, [wm]);

  const visible = useMemo(
    () => wm.windows.filter((w) => w.pinned || w.workspace === wm.activeWorkspace),
    [wm.windows, wm.activeWorkspace],
  );

  if (!hydrated) {
    return (
      <div className="grid h-screen w-screen place-items-center bg-[var(--bg)] text-[var(--muted)]">
        <div className="flex items-center gap-3">
          <span className="inline-block h-5 w-5 rounded-full border-2 border-[var(--accent)] border-t-transparent" style={{ animation: "os-spin 700ms linear infinite" }} />
          Starting Web-AIOS…
        </div>
      </div>
    );
  }

  // Below tablet width the floating-window metaphor stops working, so the shell
  // swaps to the phone paradigm. Same kernel, same apps — different presentation.
  if (vp.isPhone) return <MobileShell />;

  const pet = PETS.find((p) => p.id === settings.pet);

  return (
    <div
      className={cn("relative h-screen w-screen overflow-hidden", !settings.motion && "motion-off")}
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest("[role=dialog]")) return;
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      onClick={() => setMenu(null)}
    >
      <Wallpaper />
      <WidgetLayer />

      {settings.showDesktopIcons && (
        <div className="absolute left-0 top-12 z-[1] flex w-24 flex-col gap-1 px-2">
          {settings.desktopIcons.map((id) => {
            const app = getApp(id);
            if (!app) return null;
            return (
              <button
                key={id}
                onDoubleClick={() => wm.open(id, { title: app.name, icon: app.icon, size: app.defaultSize, singleton: app.singleton })}
                className="flex flex-col items-center gap-1 rounded-lg p-2 text-center hover:bg-white/10"
                title={`${app.name} — double-click to open`}
              >
                <Icon name={app.icon} size={26} style={{ color: app.accent ?? "var(--accent)" }} />
                <span className="text-[10px] leading-tight">{app.name}</span>
              </button>
            );
          })}
        </div>
      )}

      {visible.map((w) => <WindowFrame key={w.id} win={w} />)}

      {settings.petVisible && pet && pet.glyph && (
        <button
          className="absolute z-[2]"
          style={{ left: `${settings.petPos.x}%`, top: `${settings.petPos.y}%`, color: "var(--accent)", animation: settings.motion ? "os-pulse 4s ease-in-out infinite" : undefined }}
          title={`${pet.name} — click to move`}
          aria-label={`${pet.name} desktop pet`}
          onClick={() => settings.set("petPos", { x: 8 + Math.random() * 82, y: 18 + Math.random() * 62 })}
        >
          <PetIcon name={pet.glyph} size={44} />
        </button>
      )}

      <TopBar onLauncher={() => setLauncher((v) => !v)} onPalette={() => setPalette((v) => !v)} />
      <Dock onLauncher={() => setLauncher((v) => !v)} />
      {launcher && <Launcher onClose={() => setLauncher(false)} />}
      {palette && <CommandPalette onClose={() => setPalette(false)} />}

      {menu && <DesktopMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}

      {/* Minimized windows live in a tray so nothing can be lost. */}
      <MinimizedTray />
    </div>
  );
}

function MinimizedTray() {
  const wm = useWM();
  const dockPosition = useSettings((s) => s.dockPosition);
  const mins = wm.windows.filter((w) => w.state === "minimized" && (w.pinned || w.workspace === wm.activeWorkspace));
  if (!mins.length) return null;
  return (
    <div
      className="glass fixed z-[8900] flex max-w-[70vw] gap-1.5 overflow-x-auto p-1.5"
      style={{
        borderRadius: "var(--radius)",
        left: "50%",
        transform: "translateX(-50%)",
        bottom: dockPosition === "bottom" ? "calc(var(--dock-size) + 22px)" : 12,
      }}
    >
      {mins.map((w) => (
        <button key={w.id} onClick={() => wm.restore(w.id)} className="os-btn !py-1 text-[11px]" title={`Restore ${w.title}`}>
          <Icon name={w.icon} size={12} className="mr-1" />
          <span className="max-w-28 truncate">{w.title}</span>
        </button>
      ))}
    </div>
  );
}

function DesktopMenu({ x, y, onClose }: { x: number; y: number; onClose: () => void }) {
  const wm = useWM();
  const settings = useSettings();
  const items: Array<{ label: string; run: () => void } | "sep"> = [
    { label: "Personalize…", run: () => wm.open("personalize", { title: "Personalize", icon: "personalize", singleton: true, size: { w: 1020, h: 720 } }) },
    { label: "Settings…", run: () => wm.open("settings", { title: "Settings", icon: "settings", singleton: true, size: { w: 960, h: 680 } }) },
    "sep",
    { label: "Tile windows", run: () => wm.tileAll() },
    { label: "Cascade windows", run: () => wm.cascadeAll() },
    { label: "Show desktop", run: () => wm.minimizeAll() },
    "sep",
    { label: settings.showWidgets ? "Hide widgets" : "Show widgets", run: () => settings.set("showWidgets", !settings.showWidgets) },
    { label: settings.showDesktopIcons ? "Hide desktop icons" : "Show desktop icons", run: () => settings.set("showDesktopIcons", !settings.showDesktopIcons) },
    { label: settings.motion ? "Disable animations" : "Enable animations", run: () => settings.set("motion", !settings.motion) },
  ];
  return (
    <div
      className="glass fixed z-[9800] w-52 p-1.5 shadow-2xl"
      style={{ left: Math.min(x, window.innerWidth - 220), top: Math.min(y, window.innerHeight - 320), borderRadius: "var(--radius)" }}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((it, i) =>
        it === "sep" ? (
          <div key={i} className="my-1 h-px bg-[var(--border)]" />
        ) : (
          <button
            key={i}
            onClick={() => { it.run(); onClose(); }}
            className="w-full rounded-md px-2.5 py-1.5 text-left text-[12px] hover:bg-[var(--accent)]/18"
          >
            {it.label}
          </button>
        ),
      )}
    </div>
  );
}
