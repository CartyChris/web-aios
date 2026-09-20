"use client";

import { useState } from "react";
import { useSettings } from "@/kernel/settings";
import { quantize, deriveTheme, passesGates, DERIVED_VARS, type DerivedTheme } from "@/lib/palette";
import { readWallpaperPixels } from "./useBackdropLuminance";

/* pywal for the web: a theme from the wallpaper, held to the same legibility
   gates as the fifty hand-made ones.

   Derived only on click, never in an effect. The procedural wallpapers are
   DRAWN from the theme tokens, so re-deriving automatically would repaint the
   wallpaper, change the palette, and loop. */

export function WallpaperThemeButton() {
  const kind = useSettings((s) => s.wallpaper);
  const image = useSettings((s) => s.wallpaperImage);
  const [prefer, setPrefer] = useState<"auto" | "dark" | "light">("auto");
  const [preview, setPreview] = useState<DerivedTheme | null>(null);
  const [note, setNote] = useState<string | null>(null);

  /* Whether a derived theme is currently in force is a fact about the PERSISTED
     store, not about this component's lifetime. Held in useState it was lost on
     reload: the overrides stayed in customVars, so the wallpaper theme was still
     on screen, but the Revert button had vanished and the only way back was to
     pick a named theme -- which wipes customVars wholesale. Read it from the
     store and the button survives a refresh. */
  const applied = useSettings((s) => DERIVED_VARS.every((v) => v in s.customVars));

  const derive = async (p = prefer) => {
    setNote(null);
    const px = await readWallpaperPixels(kind, image);
    if (!px) {
      setNote("Could not read the wallpaper. A remote image that does not allow cross-origin reads cannot be sampled — upload the file instead.");
      return;
    }
    setPreview(deriveTheme(quantize(px.data, px.width, px.height), { prefer: p }));
  };

  const gates = preview ? passesGates(preview.vars) : null;
  const apply = () => {
    if (!preview || !gates?.ok) return;
    const s = useSettings.getState();
    // Every var, --on-accent included: themes.ts computes those per theme, so
    // overriding --accent alone would leave its button text for the old one.
    for (const v of DERIVED_VARS) s.setVar(v, preview.vars[v] as string);
    setPreview(null);
  };
  const revert = () => {
    const s = useSettings.getState();
    for (const v of DERIVED_VARS) s.clearVar(v);
  };

  return (
    <div className="os-card !p-2.5">
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        <button className="os-btn !py-1 text-[11px]" data-variant="primary" onClick={() => void derive()}>Theme from wallpaper</button>
        {(["auto", "dark", "light"] as const).map((k) => (
          <button key={k} className={`os-chip !py-0 !text-[10px] ${prefer === k ? "!border-[var(--accent)] !text-[var(--accent)]" : ""}`}
            onClick={() => { setPrefer(k); if (preview) void derive(k); }}>{k}</button>
        ))}
        {applied && <button className="os-btn !py-1 text-[11px]" onClick={revert}>Revert</button>}
      </div>
      <p className="text-[10.5px] leading-snug text-[var(--muted)]">
        Pulls a palette from the wallpaper and builds a full theme that still passes every contrast check. Picking a named theme later replaces it.
      </p>
      {note && <p className="mt-1.5 text-[10.5px] text-[var(--danger)]">{note}</p>}
      {preview && (
        <div className="mt-2 rounded p-2" style={{ background: preview.vars["--panel-solid"], color: preview.vars["--text"], border: `1px solid ${preview.vars["--border"]}` }}>
          <div className="mb-1.5 flex h-6 overflow-hidden rounded">
            {(["--bg", "--bg2", "--panel-solid", "--accent", "--accent2"] as const).map((v) => <div key={v} className="flex-1" style={{ background: preview.vars[v] }} title={`${v} ${preview.vars[v]}`} />)}
          </div>
          <p className="text-[11px]">Body text</p>
          <p className="mb-1.5 text-[11px]" style={{ color: preview.vars["--muted"] }}>Secondary text</p>
          <span className="inline-block rounded px-2 py-0.5 text-[11px] font-semibold" style={{ background: preview.vars["--accent"], color: preview.vars["--on-accent"] }}>Button</span>
          {preview.notes.map((n) => <p key={n} className="mt-1 text-[10px]" style={{ color: preview.vars["--muted"] }}>{n}</p>)}
          {gates && !gates.ok && <p className="mt-1 text-[10px] text-[var(--danger)]">{gates.failures.join("; ")}</p>}
          <div className="mt-2 flex gap-1">
            <button className="os-btn !py-1 text-[11px]" data-variant="primary" disabled={!gates?.ok} onClick={apply}>Apply</button>
            <button className="os-btn !py-1 text-[11px]" onClick={() => setPreview(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
