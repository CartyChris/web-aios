"use client";

import { useEffect, useMemo, useState } from "react";
import { useSettings } from "@/kernel/settings";
import { useVFS } from "@/kernel/vfs";
import { APPS } from "@/kernel/registry";
import { useUserApps } from "@/kernel/userapps";
import { bus } from "@/kernel/bus";
import { Icon } from "./icons";
import { cn } from "@/lib/cn";

/* Pin anything to the desktop: a built-in app, an app you built in Studio, or
 * a file. Opened from the desktop context menu, and it drops the icon where
 * you right-clicked rather than in some default corner. */
export function PinPicker() {
  const settings = useSettings();
  const vfs = useVFS();
  const userApps = useUserApps((s) => s.apps);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<"apps" | "built" | "files">("apps");

  useEffect(() => {
    const off = bus.on("desktop:pin-picker", (p) => {
      const pos = (p ?? {}) as { x?: number; y?: number };
      setAt({ x: pos.x ?? 80, y: pos.y ?? 80 });
      setQ("");
    });
    return off;
  }, []);

  useEffect(() => {
    if (!at) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setAt(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [at]);

  const files = useMemo(
    () => Object.values(vfs.nodes).filter((n) => n.kind === "file").sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 200),
    [vfs.nodes],
  );

  const needle = q.trim().toLowerCase();
  const rows = useMemo(() => {
    if (tab === "apps") {
      return APPS.filter((a) => !needle || a.name.toLowerCase().includes(needle))
        .map((a) => ({ key: a.id, label: a.name, sub: a.description, icon: a.icon, accent: a.accent, kind: "app" as const, ref: a.id }));
    }
    if (tab === "built") {
      return userApps.filter((a) => !needle || a.name.toLowerCase().includes(needle))
        .map((a) => ({ key: a.id, label: a.name, sub: `${(a.html.length / 1024).toFixed(1)} KB · built in Studio`, icon: "app", accent: "var(--accent2)", kind: "userapp" as const, ref: a.id }));
    }
    return files.filter((f) => !needle || f.path.toLowerCase().includes(needle))
      .map((f) => ({ key: f.path, label: f.name, sub: f.path, icon: "file", accent: "var(--muted)", kind: "file" as const, ref: f.path }));
  }, [tab, needle, userApps, files]);

  if (!at) return null;

  const pin = (kind: "app" | "userapp" | "file", ref: string) => {
    // Drop it where the right-click happened, offset so the cursor is not
    // sitting on top of the icon it just made.
    const topInset = settings.topBarVisible ? 40 : 0;
    settings.addDesktopItem({ kind, ref, x: Math.max(0, at.x - 42), y: Math.max(0, at.y - topInset - 20) });
    bus.emit("notify", { title: "Pinned to desktop", kind: "success" });
    setAt(null);
  };

  return (
    <div
      className="fixed inset-0 z-[9700] flex justify-center px-4 pt-[14vh]"
      style={{ background: "color-mix(in srgb, var(--bg) 55%, transparent)", backdropFilter: "blur(6px)" }}
      onPointerDown={(e) => e.target === e.currentTarget && setAt(null)}
    >
      <div className="glass h-fit w-full max-w-lg overflow-hidden shadow-2xl" style={{ borderRadius: "var(--radius)" }}>
        <div className="flex items-center gap-1.5 border-b border-[var(--border)] p-2">
          {([["apps", `Apps (${APPS.length})`], ["built", `Built by you (${userApps.length})`], ["files", "Files"]] as const).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={cn("os-btn !py-1 text-[11px]", tab === id && "!border-[var(--accent)] !bg-[var(--accent)]/16")}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search…"
          className="w-full bg-transparent px-3.5 py-2.5 text-[13px] outline-none"
          style={{ borderBottom: "1px solid var(--border)" }}
        />
        <div className="max-h-[46vh] overflow-y-auto p-1.5">
          {rows.map((r) => (
            <button
              key={r.key}
              onClick={() => pin(r.kind, r.ref)}
              className="flex w-full items-center gap-2.5 rounded-[calc(var(--radius)*0.6)] px-2.5 py-2 text-left hover:bg-[var(--accent)]/16"
            >
              <Icon name={r.icon} size={16} style={{ color: r.accent ?? "var(--accent)" }} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px]">{r.label}</span>
                <span className="block truncate text-[10.5px] text-[var(--muted)]">{r.sub}</span>
              </span>
              <span className="os-chip !px-1.5 !py-0 !text-[9.5px]">pin</span>
            </button>
          ))}
          {rows.length === 0 && (
            <div className="px-3 py-8 text-center text-[12px] text-[var(--muted)]">
              {tab === "built" ? "Nothing built yet — make something in HTML Studio and it appears here." : "No matches."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
