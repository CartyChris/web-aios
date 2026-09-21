"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { APPS, CATEGORY_LABELS } from "@/kernel/registry";
import { useWM } from "@/kernel/wm";
import { useSettings } from "@/kernel/settings";
import { bus } from "@/kernel/bus";
import { registerContextTarget, type TargetContext } from "@/kernel/ctxmenu";
import { cn } from "@/lib/cn";
import { Icon } from "@/shell/icons";

/** Mounted only while open (see Desktop), so its state is fresh on every
 *  invocation and no reset effect is needed. */
export function Launcher({ onClose }: { onClose: () => void }) {
  const wm = useWM();
  const settings = useSettings();
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string>("all");
  const inputRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);


  useEffect(() => {
    // rAF, not a bare focus(): the input is not laid out until after paint.
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return APPS.filter((a) => cat === "all" || a.category === cat).filter(
      (a) => !needle || a.name.toLowerCase().includes(needle) || a.description.toLowerCase().includes(needle) || a.id.includes(needle),
    );
  }, [q, cat]);

  /** Drop it in the first free grid slot rather than on top of something. */
  const pin = useCallback((id: string, name: string) => {
    const taken = new Set(settings.desktopItems.map((d) => `${d.x},${d.y}`));
    const COL = 92;
    const ROW = 100;
    let x = 24;
    let y = 56;
    // Walk columns, then rows. A pin that lands under an existing icon looks
    // like nothing happened, which is the complaint this whole affordance
    // exists to answer.
    outer: for (let col = 0; col < 12; col++) {
      for (let row = 0; row < 8; row++) {
        const cx = 24 + col * COL;
        const cy = 56 + row * ROW;
        if (!taken.has(`${cx},${cy}`)) { x = cx; y = cy; break outer; }
      }
    }
    settings.addDesktopItem({ kind: "app", ref: id, x, y });
    bus.emit("notify", { title: `Pinned "${name}" to the desktop`, kind: "success" });
  }, [settings]);

  const launch = useCallback((id: string) => {
    const app = APPS.find((a) => a.id === id);
    if (!app) return;
    wm.open(id, { title: app.name, icon: app.icon, size: app.defaultSize, singleton: app.singleton });
    onClose();
  }, [wm, onClose]);

  /* Pinning used to be an undiscoverable right-click that silently pinned and
     told nobody. It is a named menu item now, on the same gesture. */
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    return registerContextTarget(el, ({ target }: TargetContext) => {
      const id = (target.closest("[data-app-id]") as HTMLElement | null)?.dataset.appId;
      const app = APPS.find((a) => a.id === id);
      if (!app) return null;
      return {
        id: "launcher",
        entries: [
          { id: "open", label: `Open ${app.name}`, icon: app.icon, run: () => launch(app.id) },
          { id: "pin", label: "Pin to the desktop", icon: "pin", run: () => pin(app.id, app.name) },
        ],
      };
    });
  }, [launch, pin]);

  const cats = ["all", ...Array.from(new Set(APPS.map((a) => a.category)))];

  return (
    <div
      className="fixed inset-0 z-[9600] flex flex-col items-center px-4 pt-16 backdrop-blur-xl"
      style={{ background: "color-mix(in srgb, var(--bg) 72%, transparent)" }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter" && results[0]) launch(results[0].id);
        }}
        placeholder="Search apps…"
        className="os-input mb-3 max-w-lg text-center text-base"
        style={{ maxWidth: 520 }}
      />

      <div className="mb-5 flex flex-wrap justify-center gap-1.5">
        {cats.map((c) => (
          <button
            key={c}
            onClick={() => setCat(c)}
            className={cn("os-btn !py-1 text-[11px]", cat === c && "!border-[var(--accent)] !bg-[var(--accent)]/15")}
          >
            {c === "all" ? "All" : CATEGORY_LABELS[c] ?? c}
          </button>
        ))}
      </div>

      <div ref={gridRef} className="grid w-full max-w-5xl gap-3 overflow-y-auto pb-16" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
        {results.map((app, i) => (
          <button
            key={app.id}
            data-app-id={app.id}
            onClick={() => launch(app.id)}
            title={`${app.description}\n\nRight-click for more`}
            className="os-card group relative flex flex-col items-center gap-2 text-center transition hover:-translate-y-1"
            style={{ animation: `os-fade-up 260ms ease both`, animationDelay: `${Math.min(i * 18, 300)}ms` }}
          >
            <span
              role="button"
              tabIndex={-1}
              aria-label={`Pin ${app.name} to the desktop`}
              title={`Pin ${app.name} to the desktop`}
              onClick={(e) => { e.stopPropagation(); pin(app.id, app.name); }}
              className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full border border-[var(--border)] bg-[var(--panel-solid)] opacity-0 transition group-hover:opacity-100 hover:!border-[var(--accent)]"
            >
              <Icon name="pin" size={11} />
            </span>
            <div
              className="grid h-14 w-14 place-items-center rounded-[calc(var(--radius)*0.9)]"
              style={{ background: `color-mix(in srgb, ${app.accent ?? "var(--accent)"} 22%, transparent)`, border: `1px solid ${app.accent ?? "var(--accent)"}`, color: app.accent ?? "var(--accent)" }}
            >
              <Icon name={app.icon} size={26} />
            </div>
            <div className="text-[13px] font-medium">{app.name}</div>
            <div className="line-clamp-2 text-[10.5px] leading-snug text-[var(--muted)]">{app.description}</div>
          </button>
        ))}
        {results.length === 0 && <div className="col-span-full py-10 text-center text-[var(--muted)]">No apps match “{q}”.</div>}
      </div>
    </div>
  );
}
