"use client";

import { useEffect, useState } from "react";
import { useWM } from "@/kernel/wm";
import { useSettings } from "@/kernel/settings";
import { getApp } from "@/kernel/registry";
import { cn } from "@/lib/cn";
import { relTime } from "@/lib/format";
import { Icon } from "@/shell/icons";
import { bus } from "@/kernel/bus";
import { EGGS, useEggs } from "@/lib/easter";

export function TopBar({ onLauncher, onPalette }: { onLauncher: () => void; onPalette: () => void }) {
  const wm = useWM();
  const { topBarVisible, topBarItems, ai, funMode } = useSettings();
  const [clockTaps, setClockTaps] = useState(0);
  const [now, setNow] = useState(() => new Date());
  const [openMenu, setOpenMenu] = useState<"notifications" | "workspaces" | null>(null);
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    const up = () => setOnline(navigator.onLine);
    up();
    window.addEventListener("online", up);
    window.addEventListener("offline", up);
    return () => { clearInterval(t); window.removeEventListener("online", up); window.removeEventListener("offline", up); };
  }, []);

  if (!topBarVisible) return null;

  const focusedWin = wm.windows.find((w) => w.id === wm.focused);
  const focusedApp = focusedWin ? getApp(focusedWin.appId) : null;
  const unread = wm.notifications.filter((n) => !n.read).length;
  const has = (k: string) => topBarItems.includes(k);

  return (
    <div className="glass no-select fixed left-0 right-0 top-0 z-[9500] flex h-10 items-center gap-1 px-2 text-[12px]" style={{ borderRadius: 0, borderLeft: 0, borderRight: 0, borderTop: 0 }}>
      <button onClick={onLauncher} className="os-btn !px-2 !py-1 font-semibold" title="Open launcher">
        <Icon name="launcher" size={13} /> <span className="ml-1 hidden sm:inline">Web-AIOS</span>
      </button>

      {focusedApp && (
        <span className="ml-1 hidden items-center gap-1.5 truncate font-medium sm:flex">
          <Icon name={focusedApp.icon} size={13} />
          {focusedWin?.title}
        </span>
      )}

      <div className="flex-1" />

      {has("spotlight") && (
        <button onClick={onPalette} className="os-btn !py-1 text-[var(--muted)]" title="Command palette (⌘K)">
          <Icon name="search" size={13} /> <span className="ml-1 hidden md:inline">Search</span>
          <kbd className="ml-2 hidden rounded bg-white/10 px-1 text-[10px] md:inline">⌘K</kbd>
        </button>
      )}

      {has("workspaces") && (
        <div className="relative">
          <button onClick={() => setOpenMenu(openMenu === "workspaces" ? null : "workspaces")} className="os-btn !py-1" title="Workspaces">
            <Icon name="workspaces" size={12} /> {wm.activeWorkspace}/{wm.workspaces}
          </button>
          {openMenu === "workspaces" && (
            <Menu onClose={() => setOpenMenu(null)}>
              <div className="os-label mb-1.5">Workspace</div>
              <div className="mb-2 grid grid-cols-3 gap-1.5">
                {Array.from({ length: wm.workspaces }, (_, i) => i + 1).map((n) => (
                  <button
                    key={n}
                    onClick={() => { wm.setWorkspace(n); setOpenMenu(null); }}
                    className={cn("os-btn !px-2 !py-3 text-center", wm.activeWorkspace === n && "!border-[var(--accent)]")}
                  >
                    <div className="text-base">{n}</div>
                    <div className="text-[10px] text-[var(--muted)]">
                      {wm.windows.filter((w) => w.workspace === n).length} win
                    </div>
                  </button>
                ))}
              </div>
              <div className="flex gap-1.5">
                <button className="os-btn flex-1 !py-1 text-[11px]" onClick={() => wm.setWorkspaceCount(wm.workspaces + 1)}>+ Add</button>
                <button className="os-btn flex-1 !py-1 text-[11px]" onClick={() => wm.setWorkspaceCount(wm.workspaces - 1)}>− Remove</button>
              </div>
              <div className="mt-2 flex gap-1.5">
                <button className="os-btn flex-1 !py-1 text-[11px]" onClick={() => { wm.tileAll(); setOpenMenu(null); }}>Tile</button>
                <button className="os-btn flex-1 !py-1 text-[11px]" onClick={() => { wm.cascadeAll(); setOpenMenu(null); }}>Cascade</button>
              </div>
            </Menu>
          )}
        </div>
      )}

      {has("ai") && (
        <span className="os-chip hidden lg:inline-flex" title={`${ai.provider} · ${ai.model}`}>
          <Icon name="spark" size={11} /> {ai.model}
        </span>
      )}

      {has("net") && (
        <span className={cn("os-chip", !online && "!border-[var(--danger)] !bg-[var(--danger)]/15")} title={online ? "Online" : "Offline"}>
          <Icon name="network" size={11} /> {online ? "online" : "offline"}
        </span>
      )}

      {has("notifications") && (
        <div className="relative">
          <button onClick={() => { setOpenMenu(openMenu === "notifications" ? null : "notifications"); wm.markAllRead(); }} className="os-btn relative !py-1" title="Notifications">
            <Icon name="bell" size={13} />
            {unread > 0 && (
              <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-[var(--danger)] px-1 text-[9px] font-bold text-black">
                {unread}
              </span>
            )}
          </button>
          {openMenu === "notifications" && (
            <Menu onClose={() => setOpenMenu(null)} wide>
              <div className="mb-2 flex items-center justify-between">
                <div className="os-label">Notifications</div>
                <button className="os-btn !px-2 !py-0.5 text-[10px]" onClick={() => wm.clearNotifications()}>Clear all</button>
              </div>
              <div className="max-h-80 space-y-1.5 overflow-y-auto">
                {wm.notifications.length === 0 && <div className="py-6 text-center text-[var(--muted)]">Nothing here yet.</div>}
                {wm.notifications.map((n) => (
                  <div key={n.id} className="os-card !p-2">
                    <div className="flex items-start gap-2">
                      <Icon name={n.kind === "error" ? "close" : n.kind === "warn" ? "warning" : n.kind === "success" ? "check" : "info"} size={13} style={{ marginTop: 2, color: n.kind === "error" ? "var(--danger)" : n.kind === "warn" ? "var(--warn)" : n.kind === "success" ? "var(--ok)" : "var(--muted)" }} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12px] font-medium">{n.title}</div>
                        {n.body && <div className="text-[11px] text-[var(--muted)]">{n.body}</div>}
                        <div className="mt-0.5 text-[10px] text-[var(--muted)]">{relTime(n.ts)}</div>
                      </div>
                      <button className="text-[var(--muted)] hover:text-[var(--text)]" onClick={() => wm.dismiss(n.id)} aria-label="Dismiss"><Icon name="close" size={11} /></button>
                    </div>
                  </div>
                ))}
              </div>
            </Menu>
          )}
        </div>
      )}

      {has("clock") && (
        <button
          className="tabular-nums px-1.5 font-medium"
          title={now.toDateString()}
          onClick={() => {
            // The clock is a button that does not announce itself. Seven taps
            // is a secret; the eighth is just a clock again.
            const n = clockTaps + 1;
            setClockTaps(n);
            if (n === 7 && funMode && useEggs.getState().find("clock")) {
              const egg = EGGS.find((e) => e.id === "clock");
              bus.emit("notify", { title: `Secret found: ${egg?.name}`, body: `Up since this tab loaded — ${Math.round(performance.now() / 1000)} seconds and counting.`, kind: "success" });
            }
          }}
        >
          {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </button>
      )}
    </div>
  );
}

function Menu({ children, onClose, wide }: { children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onClick = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-menu]")) onClose();
    };
    window.addEventListener("keydown", onKey);
    // Deferred so the click that opened the menu does not immediately close it.
    const t = setTimeout(() => window.addEventListener("click", onClick), 0);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("click", onClick); clearTimeout(t); };
  }, [onClose]);
  return (
    <div
      data-menu
      className="glass absolute right-0 top-full mt-1.5 p-2.5 shadow-2xl"
      style={{ borderRadius: "var(--radius)", width: wide ? 340 : 260 }}
    >
      {children}
    </div>
  );
}
