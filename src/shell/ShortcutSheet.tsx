"use client";

import { useState } from "react";
import { useSettings } from "@/kernel/settings";
import { chordKeys, sheetRows, FIXED_SHORTCUTS } from "@/lib/keyhelp";
import { cn } from "@/lib/cn";
import { Icon } from "./icons";

/* The keyboard cheat sheet. One component for both places it opens: over the
   whole OS (shell/Desktop.tsx: "?" when not typing, or the editable
   shell.shortcuts binding, or the command palette) and inside Settings.
   The editable rows come straight from settings.keybinds, so the sheet shows
   exactly what the keyboard will do, conflicts included. */

export const isMacLike = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function Keys({ chord, mac }: { chord: string; mac: boolean }) {
  // Fixed shortcuts are written "up / down"; editable ones are "mod+shift+t".
  if (chord.includes(" / ")) return <span className="flex flex-wrap gap-0.5">{chord.split(" / ").map((c, i) => <Keys key={i} chord={c} mac={mac} />)}</span>;
  return (
    <span className="flex gap-0.5">
      {chordKeys(chord, mac).map((k, i) => <kbd key={i} className="rounded border border-[var(--border)] bg-white/8 px-1 font-[family-name:var(--font-mono)] text-[10.5px]">{k}</kbd>)}
    </span>
  );
}

export function ShortcutSheet({ onClose, global = false }: { onClose: () => void; global?: boolean }) {
  const binds = useSettings((s) => s.keybinds);
  const [mac] = useState(isMacLike);
  const [q, setQ] = useState("");
  const { shell, apps } = sheetRows(binds, FIXED_SHORTCUTS, q, mac);
  const grid = { gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" };
  const body = (
    <div
      className={cn("flex flex-col overflow-hidden", global ? "max-h-[80vh] w-[min(760px,calc(100vw-32px))] rounded-[var(--radius)] border border-[var(--border)] shadow-2xl" : "absolute inset-0 z-20")}
      // Near-opaque in both places: a cheat sheet over busy windows must stay
      // legible, which translucent glass is not.
      style={{ background: "color-mix(in srgb, var(--panel-solid) 97%, transparent)" }}
      role="dialog" aria-modal="true" aria-label="Keyboard shortcuts"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}
      data-shortcut-sheet={global ? "global" : "settings"}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 py-2">
        <Icon name="keyboard" size={14} />
        <span className="text-[13px] font-medium">Keyboard shortcuts</span>
        <input className="os-input ml-2 !py-0.5 text-[12px] sm:max-w-[220px]" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter: snap, tile, cmd shift..." aria-label="Filter shortcuts" />
        <span className="ml-auto hidden text-[10.5px] text-[var(--muted)] sm:inline">{mac ? "Mac keys" : "Windows / Linux keys"}</span>
        <button className="os-btn !px-2 !py-0.5 text-[11px]" aria-label="Close cheat sheet" onClick={onClose}><Icon name="close" size={11} /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3" data-testid="shortcut-sheet">
        {shell.length > 0 && (
          <>
            <div className="os-label mb-1">Shell (editable in Settings, Keyboard)</div>
            <div className="mb-3 grid gap-x-4 gap-y-1" style={grid}>
              {shell.map((r) => (
                <div key={r.id} className="flex items-center gap-2 text-[12px]" data-shortcut={r.id}>
                  <span className="min-w-0 flex-1 truncate">{r.label}</span>
                  {r.conflict && <span className="text-[10px]" style={{ color: "var(--danger)" }}>conflict</span>}
                  <Keys chord={r.chord} mac={mac} />
                </div>
              ))}
            </div>
          </>
        )}
        {apps.length > 0 && (
          <>
            <div className="os-label mb-1">Everywhere else</div>
            <div className="grid gap-x-4 gap-y-1" style={grid}>
              {apps.map((r) => (
                <div key={r.id} className="flex items-center gap-2 text-[12px]" data-shortcut={r.id}>
                  <span className="min-w-0 flex-1">{r.label}</span>
                  <Keys chord={r.chord} mac={mac} />
                </div>
              ))}
            </div>
          </>
        )}
        {shell.length + apps.length === 0 && <p className="text-[12px] text-[var(--muted)]">No shortcut matches &quot;{q}&quot;.</p>}
      </div>
    </div>
  );
  if (!global) return body;
  return (
    <div className="fixed inset-0 z-[9000] flex items-center justify-center bg-black/35 px-4" onClick={onClose}>
      {body}
    </div>
  );
}
