"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { APPS } from "@/kernel/registry";
import { useWM } from "@/kernel/wm";
import { bus } from "@/kernel/bus";
import { useSettings } from "@/kernel/settings";
import { useVFS } from "@/kernel/vfs";
import { WALLPAPERS } from "@/kernel/themes";
import { useCustomThemes, allThemes } from "@/kernel/customthemes";
import { useScenes } from "@/kernel/scenes";
import { LAYOUTS } from "@/lib/zones";
import { describeScene } from "@/lib/scenes";
import { cn } from "@/lib/cn";
import { Icon } from "./icons";

interface Command {
  id: string;
  label: string;
  hint?: string;
  group: string;
  /** Optional glyph from the icon set, shown at the head of the row. */
  icon?: string;
  run: () => void;
}

/** One palette over apps, windows, settings, themes and the filesystem.
 *  Ranking is a simple subsequence match with a bonus for prefix hits — good
 *  enough that "dkl" finds "Dock position: left" without a fuzzy library. */
/** Mounted only while open, so query and selection start fresh each time. */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const wm = useWM();
  const settings = useSettings();
  const vfs = useVFS();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  // See Personalize: allThemes() reads the custom-theme store through
  // getState(), so the subscription has to be explicit.
  const generatedThemes = useCustomThemes((s) => s.themes);
  const scenes = useScenes((s) => s.scenes);
  const commands = useMemo<Command[]>(() => {
    const out: Command[] = [];

    for (const app of APPS) {
      out.push({
        id: `open:${app.id}`,
        label: `Open ${app.name}`,
        hint: app.description,
        group: "Apps",
        icon: app.icon,
        run: () => wm.open(app.id, { title: app.name, icon: app.icon, size: app.defaultSize, singleton: app.singleton }),
      });
    }

    for (const w of wm.windows) {
      out.push({
        id: `focus:${w.id}`,
        label: `Go to ${w.title}`,
        hint: `Workspace ${w.workspace}`,
        group: "Windows",
        icon: w.icon,
        run: () => { wm.setWorkspace(w.workspace); wm.restore(w.id); },
      });
    }

    for (const t of allThemes(generatedThemes)) {
      out.push({ id: `theme:${t.id}`, label: `Theme: ${t.name}`, hint: t.dark ? "dark" : "light", group: "Appearance", icon: "personalize", run: () => settings.applyTheme(t.id) });
    }
    for (const wp of WALLPAPERS) {
      out.push({ id: `wall:${wp.id}`, label: `Wallpaper: ${wp.name}`, group: "Appearance", icon: "wallpaper", run: () => settings.set("wallpaper", wp.id) });
    }
    for (const pos of ["bottom", "left", "right", "top", "hidden"] as const) {
      out.push({ id: `dock:${pos}`, label: `Dock position: ${pos}`, group: "Appearance", icon: "layout", run: () => settings.set("dockPosition", pos) });
    }

    out.push(
      ...LAYOUTS.map((l) => ({
        id: `layout:${l.id}`,
        label: `Layout: ${l.name}`,
        hint: l.hint,
        group: "Window",
        icon: "layout",
        run: () => wm.applyLayout(l.id),
      })),
      ...scenes.map((sc) => ({
        id: `scene:${sc.id}`,
        label: `Scene: ${sc.name}`,
        hint: describeScene(sc),
        group: "Scenes",
        icon: "backup",
        run: () => useScenes.getState().restore(sc.id, { replace: true }),
      })),
      {
        id: "scene.save",
        label: "Save this arrangement as a scene",
        hint: "Every window on every desktop, restorable later",
        group: "Scenes",
        icon: "save",
        run: () => useScenes.getState().save(`Scene ${new Date().toLocaleString()}`),
      },
      { id: "sys.shortcuts", label: "Show keyboard shortcuts", hint: "? anywhere, or the cheat-sheet binding", group: "System", icon: "keyboard", run: () => bus.emit("shortcuts:open") },
      { id: "wm.tile", label: "Tile all windows", group: "Window", run: () => wm.tileAll() },
      { id: "wm.cascade", label: "Cascade all windows", group: "Window", run: () => wm.cascadeAll() },
      { id: "wm.minAll", label: "Show desktop (minimize all)", group: "Window", run: () => wm.minimizeAll() },
      { id: "wm.closeAll", label: "Close all windows on this workspace", group: "Window", run: () => wm.closeAll() },
      { id: "set.motion", label: `Animations: turn ${settings.motion ? "off" : "on"}`, group: "Appearance", run: () => settings.set("motion", !settings.motion) },
      { id: "set.glassUp", label: "Increase glass blur", group: "Appearance", run: () => settings.set("glass", Math.min(40, settings.glass + 4)) },
      { id: "set.glassDown", label: "Decrease glass blur", group: "Appearance", run: () => settings.set("glass", Math.max(0, settings.glass - 4)) },
      { id: "set.scaleUp", label: "Increase UI scale", group: "Appearance", run: () => settings.set("uiScale", Math.min(1.6, +(settings.uiScale + 0.1).toFixed(2))) },
      { id: "set.scaleDown", label: "Decrease UI scale", group: "Appearance", run: () => settings.set("uiScale", Math.max(0.75, +(settings.uiScale - 0.1).toFixed(2))) },
      { id: "set.reset", label: "Reset all personalization", hint: "Restores factory defaults", group: "System", run: () => settings.reset() },
      {
        id: "sys.export",
        label: "Export everything (settings + files)",
        group: "System",
        run: () => {
          const blob = JSON.stringify({ __webaios_backup: 1, at: Date.now(), settings: JSON.parse(settings.exportProfile()), vfs: JSON.parse(vfs.exportAll()) }, null, 2);
          const a = document.createElement("a");
          a.href = URL.createObjectURL(new Blob([blob], { type: "application/json" }));
          a.download = `web-aios-backup-${new Date().toISOString().slice(0, 10)}.json`;
          a.click();
        },
      },
    );

    for (let i = 1; i <= wm.workspaces; i++) {
      out.push({ id: `ws:${i}`, label: `Switch to workspace ${i}`, group: "Workspaces", icon: "workspaces", run: () => wm.setWorkspace(i) });
    }

    if (q.trim().length > 1) {
      for (const f of vfs.search(q).slice(0, 8)) {
        out.push({
          id: `file:${f.path}`,
          label: `Open ${f.name}`,
          hint: f.path,
          group: "Files",
          icon: "file",
          run: () => wm.open("notes", { title: f.name, icon: "notes", args: { path: f.path } }),
        });
      }
    }

    return out;
  }, [wm, settings, vfs, q, generatedThemes, scenes]);

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return commands.slice(0, 60);
    const scored = commands
      .map((c) => ({ c, s: score(c.label.toLowerCase(), needle) + (c.hint ? score(c.hint.toLowerCase(), needle) * 0.3 : 0) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
    return scored.slice(0, 60).map((x) => x.c);
  }, [commands, q]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const exec = (c: Command | undefined) => {
    if (!c) return;
    c.run();
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[9700] flex justify-center px-4"
      style={{ paddingTop: "max(12vh, calc(var(--sa-t) + 16px))", background: "color-mix(in srgb, var(--bg) 55%, transparent)", backdropFilter: "blur(6px)" }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="glass h-fit w-full max-w-2xl overflow-hidden shadow-2xl" style={{ borderRadius: "var(--radius)" }}>
        <input
          ref={inputRef}
          value={q}
          // Selection resets with the query here rather than in an effect:
          // the two always change together, so they belong in one handler.
          onChange={(e) => { setQ(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === "Escape") return onClose();
            if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
            if (e.key === "Enter") { e.preventDefault(); exec(results[sel]); }
          }}
          placeholder="Type a command, app, theme or file…"
          className="w-full bg-transparent px-4 py-3.5 text-[15px] outline-none"
          style={{ borderBottom: "1px solid var(--border)" }}
        />
        <div ref={listRef} className="max-h-[52vh] overflow-y-auto p-1.5">
          {results.map((c, i) => {
            const newGroup = i === 0 || results[i - 1].group !== c.group;
            return (
              <div key={c.id}>
                {newGroup && <div className="os-label px-2.5 pb-1 pt-2">{c.group}</div>}
                <button
                  data-i={i}
                  onMouseMove={() => setSel(i)}
                  onClick={() => exec(c)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-[calc(var(--radius)*0.6)] px-2.5 py-2 text-left",
                    i === sel && "bg-[var(--accent)]/16 ring-1 ring-[var(--accent)]/45",
                  )}
                >
                  {c.icon && <Icon name={c.icon} size={13} className="shrink-0 text-[var(--muted)]" />}
                  <span className="flex-1 truncate text-[13px]">{c.label}</span>
                  {c.hint && <span className="max-w-[45%] truncate text-[11px] text-[var(--muted)]">{c.hint}</span>}
                  {i === sel && <kbd className="rounded bg-white/10 px-1.5 text-[10px]">↵</kbd>}
                </button>
              </div>
            );
          })}
          {results.length === 0 && <div className="px-3 py-8 text-center text-[var(--muted)]">No matches.</div>}
        </div>
      </div>
    </div>
  );
}

/** Subsequence score: every needle char must appear in order. Consecutive and
 *  word-start matches score higher, so short acronyms beat scattered letters. */
function score(hay: string, needle: string): number {
  let hi = 0;
  let total = 0;
  let streak = 0;
  for (const ch of needle) {
    const idx = hay.indexOf(ch, hi);
    if (idx === -1) return 0;
    const atWordStart = idx === 0 || hay[idx - 1] === " " || hay[idx - 1] === ":";
    streak = idx === hi ? streak + 1 : 0;
    total += 1 + streak * 2 + (atWordStart ? 3 : 0);
    hi = idx + 1;
  }
  return total + Math.max(0, 12 - hay.length * 0.05);
}
