"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWM } from "@/kernel/wm";
import { useSettings } from "@/kernel/settings";
import { APPS, getApp } from "@/kernel/registry";
import type { AppManifest } from "@/kernel/types";
import { Wallpaper } from "./Wallpaper";
import { CommandPalette } from "./CommandPalette";
import { cn } from "@/lib/cn";
import { useViewport } from "@/lib/useViewport";
import { Icon } from "./icons";
import { bus } from "@/kernel/bus";
import { ContextMenuHost } from "./ContextMenu";
import { LiveToasts } from "./LiveToasts";
import { AiosChat } from "./AiosChat";

/* ────────────────────────────────────────────────────────────────────────────
   MobileShell — the phone paradigm.

   A floating-window desktop shrunk to 402 points is not a mobile app, it is a
   desktop you cannot use. So on a phone the OS becomes what a phone OS is: one
   full-screen app at a time, a home screen of pages, and a card switcher. The
   kernel underneath is identical — the same window records, the same registry,
   the same state — only the presentation changes, which is why an app written
   once works in both.

   Every fixed edge uses env(safe-area-inset-*), so the Dynamic Island and the
   home indicator never cover content on an iPhone running this as a PWA.
   ──────────────────────────────────────────────────────────────────────────── */

type View = "home" | "app" | "switcher";

export function MobileShell() {
  const wm = useWM();
  const settings = useSettings();
  const vp = useViewport();
  const [rawView, setView] = useState<View>("home");
  const [rawPage, setPage] = useState(0);
  const [palette, setPalette] = useState(false);
  const [search, setSearch] = useState("");
  const touchStart = useRef<{ x: number; y: number; t: number } | null>(null);

  // Something outside the shell (a finished job's toast, a notification)
  // focused a window and wants it on screen. The focus change itself happens in
  // the window manager; this only brings the app surface forward. setView runs
  // inside the event handler, not in the effect body.
  useEffect(() => {
    const show = () => { setView("app"); };
    // app:open covers every other app-to-app hand-off (AIOS Chat, Files, AI
    // Studio): the desktop handler opens the window, this shows it.
    const offs = [bus.on("shell:show-app", show), bus.on("app:open", show)];
    return () => { for (const off of offs) off(); };
  }, []);

  const goDesktop = () => settings.set("phoneMode", "desktop");
  const dismissTip = () => settings.set("phoneTipSeen", true);

  const activeWin = wm.windows.find((w) => w.id === wm.focused) ?? null;
  const activeApp = activeWin ? getApp(activeWin.appId) : null;

  // Derived, not synced: an "app" view with no window would be a blank screen,
  // so it simply reads as "home" until a window exists.
  const view: View = rawView === "app" && !activeWin ? "home" : rawView;

  const open = useCallback(
    (app: AppManifest) => {
      // On a phone every app is effectively a singleton: a second copy of the
      // same app in a card switcher is noise, not a feature.
      const existing = wm.windows.find((w) => w.appId === app.id);
      if (existing) {
        wm.restore(existing.id);
      } else {
        wm.open(app.id, { title: app.name, icon: app.icon, size: { w: vp.w, h: vp.h }, singleton: true });
      }
      setView("app");
      setSearch("");
    },
    [wm, vp.w, vp.h],
  );

  const pages = useMemo(() => {
    const filtered = search.trim()
      ? APPS.filter((a) => (a.name + a.description).toLowerCase().includes(search.trim().toLowerCase()))
      : APPS;
    const perPage = vp.landscape ? 20 : 16;
    const out: AppManifest[][] = [];
    for (let i = 0; i < filtered.length; i += perPage) out.push(filtered.slice(i, i + perPage));
    return out.length ? out : [[]];
  }, [search, vp.landscape]);

  // Clamped on read, so a shrinking page count can never strand the user on
  // a page that no longer exists.
  const page = Math.min(rawPage, Math.max(0, pages.length - 1));

  // Swipe: left/right pages the home screen, up from the bottom goes home.
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    touchStart.current = { x: t.clientX, y: t.clientY, t: Date.now() };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const s = touchStart.current;
    if (!s) return;
    touchStart.current = null;
    const t = e.changedTouches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    const dt = Date.now() - s.t;
    if (dt > 600) return;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && view === "home") {
      setPage((p) => Math.max(0, Math.min(pages.length - 1, p + (dx < 0 ? 1 : -1))));
    }
    // An upward swipe starting near the bottom edge is the home gesture.
    if (dy < -70 && Math.abs(dy) > Math.abs(dx) * 1.5 && s.y > vp.h - 120) {
      setView(view === "app" ? "home" : view);
    }
  };

  const dockApps = settings.dockApps.map(getApp).filter(Boolean).slice(0, 4) as AppManifest[];

  return (
    <div
      className={cn("relative h-[100dvh] w-screen overflow-hidden", !settings.motion && "motion-off")}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <Wallpaper />

      {/* ── Status bar ── */}
      <MobileStatusBar />

      {/* ── App surface ── */}
      {view === "app" && activeWin && activeApp && (
        <div
          className="absolute inset-0 flex flex-col"
          // max(), not a bare inset: in a browser tab the safe-area inset is 0
          // and the app header would sit under the status bar. On a real iPhone
          // the inset is larger and wins.
          style={{ paddingTop: "max(env(safe-area-inset-top, 0px), 26px)", background: "var(--bg)" }}
        >
          <div
            className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-3"
            style={{ height: 44 }}
          >
            <button onClick={() => setView("home")} className="os-btn !px-2 !py-1 text-[12px]" aria-label="Home">‹ Home</button>
            <span className="min-w-0 flex-1 truncate text-center text-[13px] font-medium">
              <Icon name={activeApp.icon} size={14} className="mr-1 inline-block align-[-2px]" />{activeWin.title}
            </span>
            <button onClick={() => setView("switcher")} className="os-btn !px-2 !py-1" aria-label="App switcher"><Icon name="switcher" size={14} /></button>
          </div>
          <div className="app-surface min-h-0 flex-1 overflow-hidden">
            <activeApp.component win={activeWin} args={activeWin.args} />
          </div>
          <div style={{ height: "env(safe-area-inset-bottom, 0px)" }} />
        </div>
      )}

      {/* ── Home screen ── */}
      {view === "home" && (
        <div
          className="absolute inset-0 flex flex-col"
          style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 28px)" }}
        >
          <div className="flex items-center gap-2 px-4 pb-2">
            <input
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
              placeholder="Search apps"
              className="os-input text-[15px]"
              style={{ fontSize: 16 }} /* 16px prevents iOS from zooming on focus */
              autoCapitalize="none"
              autoCorrect="off"
            />
            <button
              onClick={goDesktop}
              className="os-btn shrink-0 !px-2 !py-1.5 text-[11px]"
              aria-label="Switch to full desktop"
              title="Switch to full desktop"
            >
              <Icon name="monitor" size={14} className="mr-1" />Full desktop
            </button>
            <AiosChat />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
            <div className="grid gap-x-2 gap-y-4" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
              {(pages[page] ?? []).map((app) => (
                <button key={app.id} onClick={() => open(app)} className="flex flex-col items-center gap-1.5">
                  <span
                    className="grid place-items-center rounded-[22%] shadow-lg"
                    style={{
                      width: 58, height: 58,
                      background: `linear-gradient(150deg, color-mix(in srgb, ${app.accent ?? "var(--accent)"} 38%, var(--panel-solid)), var(--panel-solid))`,
                      border: "1px solid var(--border)",
                      color: app.accent ?? "var(--accent)",
                    }}
                  >
                    <Icon name={app.icon} size={28} />
                  </span>
                  <span className="w-full truncate text-center text-[10.5px] leading-tight">{app.name}</span>
                </button>
              ))}
            </div>
            {(pages[page] ?? []).length === 0 && (
              <div className="py-12 text-center text-[var(--muted)]">No apps match “{search}”.</div>
            )}
          </div>

          {pages.length > 1 && (
            <div className="flex shrink-0 justify-center gap-1.5 py-2">
              {pages.map((_, i) => (
                <button
                  key={i}
                  onClick={() => setPage(i)}
                  aria-label={`Page ${i + 1}`}
                  className="h-1.5 rounded-full transition-all"
                  style={{ width: i === page ? 18 : 6, background: i === page ? "var(--accent)" : "color-mix(in srgb, var(--muted) 45%, transparent)" }}
                />
              ))}
            </div>
          )}

          {/* ── Dock ── */}
          <div
            className="glass mx-3 mb-2 flex shrink-0 items-center justify-around p-2"
            style={{ borderRadius: 24, marginBottom: "calc(env(safe-area-inset-bottom, 0px) + 8px)" }}
          >
            {dockApps.map((app) => (
              <button key={app.id} onClick={() => open(app)} aria-label={app.name}>
                <span
                  className="grid place-items-center rounded-[22%]"
                  style={{
                    width: 52, height: 52,
                    background: `linear-gradient(150deg, color-mix(in srgb, ${app.accent ?? "var(--accent)"} 38%, var(--panel-solid)), var(--panel-solid))`,
                    border: "1px solid var(--border)",
                    color: app.accent ?? "var(--accent)",
                  }}
                >
                  <Icon name={app.icon} size={26} />
                </span>
              </button>
            ))}
            <button onClick={() => setPalette(true)} aria-label="Command palette">
              <span
                className="grid place-items-center rounded-[22%]"
                style={{ width: 52, height: 52, background: "color-mix(in srgb, var(--accent) 24%, var(--panel-solid))", border: "1px solid var(--border)", color: "var(--accent)" }}
              >
                <Icon name="launcher" size={24} />
              </span>
            </button>
          </div>
        </div>
      )}

      {/* ── App switcher ── */}
      {view === "switcher" && (
        <div
          className="absolute inset-0 flex flex-col"
          style={{ background: "color-mix(in srgb, var(--bg) 88%, transparent)", paddingTop: "calc(env(safe-area-inset-top, 0px) + 36px)" }}
        >
          <div className="flex items-center gap-2 px-4 pb-3">
            <span className="os-label">Open apps ({wm.windows.length})</span>
            <div className="flex-1" />
            {wm.windows.length > 0 && (
              <button className="os-btn !py-1 text-[11px]" onClick={() => { wm.closeAll(); setView("home"); }}>Close all</button>
            )}
            <button className="os-btn !py-1 text-[11px]" onClick={goDesktop} aria-label="Switch to full desktop">
              <Icon name="monitor" size={12} className="mr-1" />Full desktop
            </button>
            <button className="os-btn !py-1 text-[11px]" onClick={() => setView("home")}>Done</button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
            {wm.windows.length === 0 && <div className="py-16 text-center text-[var(--muted)]">Nothing open.</div>}
            <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}>
              {wm.windows.map((w) => {
                const app = getApp(w.appId);
                return (
                  <div key={w.id} className="glass overflow-hidden" style={{ borderRadius: 16 }}>
                    <button
                      onClick={() => { wm.restore(w.id); setView("app"); }}
                      className="grid w-full place-items-center py-7"
                      style={{ background: `color-mix(in srgb, ${app?.accent ?? "var(--accent)"} 16%, transparent)`, color: app?.accent ?? "var(--accent)" }}
                    >
                      <Icon name={w.icon} size={36} />
                    </button>
                    <div className="flex items-center gap-1 p-2">
                      <span className="min-w-0 flex-1 truncate text-[11.5px]">{w.title}</span>
                      <button className="os-btn !px-2 !py-0.5 text-[10px]" onClick={() => wm.close(w.id)} aria-label={`Close ${w.title}`}><Icon name="close" size={11} /></button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {palette && <CommandPalette onClose={() => setPalette(false)} />}

      {/* Right-click and long-press menus, and live job toasts, need their
          hosts in this tree too — the desktop's copies are not mounted here. */}
      <ContextMenuHost />
      <LiveToasts compact />

      {/* One-time notice: the full desktop is one rotation away. */}
      {!settings.phoneTipSeen && (
        <div
          className="absolute inset-0 z-[10000] flex items-end justify-center px-4"
          style={{
            background: "color-mix(in srgb, var(--bg) 55%, transparent)",
            // Clear of the Dynamic Island at the top and the home indicator below.
            paddingTop: "calc(env(safe-area-inset-top, 0px) + 48px)",
            paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 20px)",
          }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="phone-tip-title"
        >
          <div className="glass os-card w-full max-w-sm p-4" style={{ borderRadius: 20 }}>
            <div className="mb-2 flex items-center gap-2">
              <Icon name="monitor" size={18} style={{ color: "var(--accent)" }} />
              <span id="phone-tip-title" className="text-[14px] font-semibold">Want the full desktop?</span>
            </div>
            <p className="mb-3 text-[13px] leading-relaxed text-[var(--muted)]">
              Turn your phone on its side for the full desktop experience — or switch to full desktop now.
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <button className="os-btn !py-1.5 text-[12px]" onClick={dismissTip}>Got it</button>
              <button
                className="os-btn !py-1.5 text-[12px]"
                data-variant="primary"
                onClick={() => { dismissTip(); goDesktop(); }}
              >
                Switch to full desktop
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Home indicator — a real affordance, and it keeps content clear of the
          hardware one on devices that have it. */}
      {view === "app" && (
        <button
          onClick={() => setView("home")}
          aria-label="Home"
          className="absolute left-1/2 z-[9999] h-1 w-32 -translate-x-1/2 rounded-full"
          style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 5px)", background: "color-mix(in srgb, var(--text) 45%, transparent)" }}
        />
      )}
    </div>
  );
}

function MobileStatusBar() {
  const [now, setNow] = useState(() => new Date());
  const [online, setOnline] = useState(true);
  const wm = useWM();

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    const up = () => setOnline(navigator.onLine);
    up();
    window.addEventListener("online", up);
    window.addEventListener("offline", up);
    return () => { clearInterval(t); window.removeEventListener("online", up); window.removeEventListener("offline", up); };
  }, []);

  const unread = wm.notifications.filter((n) => !n.read).length;

  return (
    <div
      className="pointer-events-none absolute left-0 right-0 top-0 z-[9999] flex items-center justify-between px-5 text-[12px] font-medium tabular-nums"
      style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 4px)", height: "calc(env(safe-area-inset-top, 0px) + 26px)" }}
    >
      <span>{now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
      <span className="flex items-center gap-1.5">
        {unread > 0 && <span className="rounded-full bg-[var(--danger)] px-1.5 text-[10px] text-black">{unread}</span>}
        <Icon name="network" size={12} style={{ opacity: online ? 1 : 0.4 }} />
      </span>
    </div>
  );
}
