"use client";

import { useCallback, useRef, useState } from "react";
import { useSettings, resolveTokens } from "@/kernel/settings";
import { THEMES, WALLPAPERS, FONT_STACKS } from "@/kernel/themes";
import { SPECIES, PET_FAMILIES, PERSONALITIES, VOICES, getSpecies } from "@/kernel/pets";
import { PROFILES } from "@/kernel/profiles";
import { APPS, getApp } from "@/kernel/registry";
import { WIDGET_KINDS } from "@/shell/Widgets";
import { bus } from "@/kernel/bus";
import type { AppProps } from "@/kernel/types";
import { download } from "@/lib/format";
import { Tabs, Slider, Toggle, Field, ErrorNote } from "./_ui";
import { cn } from "@/lib/cn";
import { Icon } from "@/shell/icons";
import { PetSprite } from "@/shell/pets";
import { WidgetBuilder } from "./WidgetBuilder";

/* ────────────────────────────────────────────────────────────────────────────
   Personalize — the customization surface.

   Everything visible in the OS is a token or a layout field, and every one of
   them is editable here. The Tokens tab is the escape hatch: if a preset is
   almost right, edit the raw custom property rather than waiting for someone to
   ship an option for it.
   ──────────────────────────────────────────────────────────────────────────── */

export default function Personalize({}: AppProps) {
  const s = useSettings();
  const [tab, setTab] = useState("profiles");
  const [error, setError] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const importProfile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      const text = await file.text();
      const res = s.importProfile(text);
      if (res.ok) bus.emit("notify", { title: "Profile imported", kind: "success" });
      else setError(res.error ?? "Import failed.");
    },
    [s],
  );

  return (
    <div className="flex h-full flex-col">
      <Tabs
        tabs={[
          { id: "profiles", label: "OS Profiles", icon: "monitor" },
          { id: "theme", label: "Theme", icon: "personalize" },
          { id: "wallpaper", label: "Wallpaper", icon: "wallpaper" },
          { id: "layout", label: "Layout", icon: "layout" },
          { id: "personality", label: "Personality", icon: "pet" },
          { id: "widgets", label: "Widgets", icon: "widgets" },
          { id: "tokens", label: "Tokens", icon: "tokens" },
          { id: "backup", label: "Backup", icon: "backup" },
        ]}
        active={tab}
        onChange={setTab}
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <ErrorNote error={error} onDismiss={() => setError(null)} />

        {/* ── OS PROFILES ── */}
        {tab === "profiles" && (
          <>
            <p className="mb-3 max-w-2xl text-[12px] leading-relaxed text-[var(--muted)]">
              A profile changes what the machine <em>is</em> — palette, window chrome, dock position, corner radius,
              wallpaper and glass, all at once. Picking one is a starting point, not a lock: everything it sets stays
              editable on the other tabs.
            </p>
            <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}>
              {PROFILES.map((p) => (
                <button
                  key={p.id}
                  onClick={() => { s.applyProfile(p.id); bus.emit("notify", { title: `${p.name} applied`, kind: "success" }); }}
                  className={cn("os-card group text-left transition hover:-translate-y-0.5", s.profileId === p.id && "!border-[var(--accent)] ring-1 ring-[var(--accent)]")}
                >
                  <div className="mb-2 h-16 w-full rounded-[calc(var(--radius)*0.6)] border border-[var(--border)]" style={{ background: p.swatch }} />
                  <div className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{p.name}</span>
                    {s.profileId === p.id && <span className="os-chip !text-[9px]">active</span>}
                  </div>
                  <div className="mt-0.5 truncate text-[10.5px] text-[var(--muted)]">{p.lineage}</div>
                  <div className="mt-1 flex flex-wrap gap-1 text-[9.5px] text-[var(--muted)]">
                    <span className="os-chip !px-1.5 !py-0 !text-[9px]">{p.shell.titlebarStyle ?? "mac"}</span>
                    <span className="os-chip !px-1.5 !py-0 !text-[9px]">dock {p.shell.dockPosition ?? "bottom"}</span>
                    <span className="os-chip !px-1.5 !py-0 !text-[9px]">r{p.shell.radius ?? 14}</span>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}

        {/* ── THEME ── */}
        {tab === "theme" && (
          <div className="grid gap-5 lg:grid-cols-2">
            <div>
              <div className="os-label mb-2">Palette</div>
              <div className="mb-5 grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))" }}>
                {THEMES.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => s.applyTheme(t.id)}
                    className={cn("os-card !p-2 text-left", s.themeId === t.id && "!border-[var(--accent)]")}
                  >
                    <div className="mb-1.5 flex h-8 overflow-hidden rounded border border-[var(--border)]">
                      {["--bg", "--panel-solid", "--accent", "--accent2"].map((k) => (
                        <div key={k} className="flex-1" style={{ background: t.vars[k] }} />
                      ))}
                    </div>
                    <div className="truncate text-[11.5px]">{t.name}</div>
                    <div className="text-[9.5px] text-[var(--muted)]">{t.dark ? "dark" : "light"}</div>
                  </button>
                ))}
              </div>

              <div className="os-label mb-2">Accent overrides</div>
              <div className="mb-4 flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-[12px]">
                  <input type="color" value={s.accent ?? cssVar("--accent")} onChange={(e) => s.set("accent", e.target.value)} className="h-8 w-12 cursor-pointer rounded border border-[var(--border)] bg-transparent" />
                  Primary
                </label>
                <label className="flex items-center gap-2 text-[12px]">
                  <input type="color" value={s.accent2 ?? cssVar("--accent2")} onChange={(e) => s.set("accent2", e.target.value)} className="h-8 w-12 cursor-pointer rounded border border-[var(--border)] bg-transparent" />
                  Secondary
                </label>
                {(s.accent || s.accent2) && (
                  <button className="os-btn !py-1 text-[11px]" onClick={() => { s.set("accent", null); s.set("accent2", null); }}>Reset to theme</button>
                )}
              </div>

              <div className="os-label mb-2">Typography</div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Interface font">
                  <select value={s.fontId} onChange={(e) => s.set("fontId", e.target.value)} className="os-input !py-1 text-[12px]">
                    {FONT_STACKS.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                  </select>
                </Field>
                <Field label="Monospace font">
                  <select value={s.monoFontId} onChange={(e) => s.set("monoFontId", e.target.value)} className="os-input !py-1 text-[12px]">
                    {FONT_STACKS.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                  </select>
                </Field>
              </div>
            </div>

            <div>
              <div className="os-label mb-2">Geometry &amp; feel</div>
              <Slider label="Corner radius" value={s.radius} min={0} max={30} onChange={(v) => s.set("radius", v)} format={(v) => `${v}px`} />
              <Slider label="Glass blur" value={s.glass} min={0} max={44} onChange={(v) => s.set("glass", v)} format={(v) => (v === 0 ? "off" : `${v}px`)} />
              <Slider label="UI scale" value={s.uiScale} min={0.75} max={1.6} step={0.05} onChange={(v) => s.set("uiScale", v)} format={(v) => `${Math.round(v * 100)}%`} />
              <Slider label="Density" value={s.density} min={0.7} max={1.5} step={0.05} onChange={(v) => s.set("density", v)} format={(v) => (v < 0.9 ? "compact" : v > 1.15 ? "roomy" : "normal")} />
              <Slider label="Unfocused window opacity" value={s.windowOpacity} min={0.3} max={1} step={0.05} onChange={(v) => s.set("windowOpacity", v)} format={(v) => `${Math.round(v * 100)}%`} />

              <div className="mt-4">
                <Toggle label="Animations" checked={s.motion} onChange={(v) => s.set("motion", v)} hint="Turning this off disables every transition and the animated wallpaper." />
              </div>

              <div className="os-card mt-4">
                <div className="os-label mb-2">Live preview</div>
                <div className="flex flex-wrap items-center gap-2">
                  <button className="os-btn" data-variant="primary">Primary</button>
                  <button className="os-btn">Secondary</button>
                  <span className="os-chip">Chip</span>
                  <input className="os-input !w-28 !py-1" placeholder="Input" readOnly />
                </div>
                <div className="mt-2 text-[12px]">Body text in the interface font.</div>
                <div className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--muted)]">monospace 0O1lI</div>
              </div>
            </div>
          </div>
        )}

        {/* ── WALLPAPER ── */}
        {tab === "wallpaper" && (
          <div className="max-w-2xl">
            <div className="os-label mb-2">Style</div>
            <div className="mb-4 grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))" }}>
              {WALLPAPERS.map((w) => (
                <button
                  key={w.id}
                  onClick={() => s.set("wallpaper", w.id)}
                  className={cn("os-btn !py-2 text-[11.5px]", s.wallpaper === w.id && "!border-[var(--accent)] !bg-[var(--accent)]/16")}
                >
                  {w.name}
                </button>
              ))}
            </div>

            {s.wallpaper === "image" && (
              <div className="mb-4">
                <label className="os-btn inline-block !py-1 text-[11px]">
                  Choose image…
                  <input
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      if (f.size > 3 * 1024 * 1024) { setError("Pick an image under 3 MB — it is stored in this browser."); return; }
                      const reader = new FileReader();
                      reader.onload = () => s.set("wallpaperImage", String(reader.result));
                      reader.readAsDataURL(f);
                    }}
                  />
                </label>
                {s.wallpaperImage && (
                  <button className="os-btn ml-1.5 !py-1 text-[11px]" onClick={() => s.set("wallpaperImage", null)}>Clear</button>
                )}
              </div>
            )}

            <Slider label="Blur" value={s.wallpaperBlur} min={0} max={40} onChange={(v) => s.set("wallpaperBlur", v)} format={(v) => (v ? `${v}px` : "none")} />
            <Slider label="Dim" value={s.wallpaperDim} min={0} max={0.85} step={0.05} onChange={(v) => s.set("wallpaperDim", v)} format={(v) => `${Math.round(v * 100)}%`} />
            <Toggle label="Animate wallpaper" checked={s.wallpaperAnimate} onChange={(v) => s.set("wallpaperAnimate", v)} hint="Static wallpapers cost nothing per frame." />

          </div>
        )}

        {/* ── LAYOUT ── */}
        {tab === "layout" && (
          <div className="grid max-w-4xl gap-5 lg:grid-cols-2">
            <div>
              <div className="os-label mb-2">Dock</div>
              <div className="mb-2 flex flex-wrap gap-1.5">
                {(["bottom", "left", "right", "top", "hidden"] as const).map((p) => (
                  <button key={p} onClick={() => s.set("dockPosition", p)} className={cn("os-btn !py-1 text-[11px]", s.dockPosition === p && "!border-[var(--accent)] !bg-[var(--accent)]/16")}>{p}</button>
                ))}
              </div>
              <Toggle label="Magnify on hover" checked={s.dockMagnify} onChange={(v) => s.set("dockMagnify", v)} />
              <Toggle label="Auto-hide" checked={s.dockAutohide} onChange={(v) => s.set("dockAutohide", v)} />
              <Toggle label="Show labels" checked={s.dockLabels} onChange={(v) => s.set("dockLabels", v)} />

              <div className="os-label mb-1.5 mt-4">Dock apps ({s.dockApps.length})</div>
              <div className="mb-3 space-y-1">
                {s.dockApps.map((id, i) => {
                  const app = getApp(id);
                  return (
                    <div key={id} className="flex items-center gap-2 rounded-[calc(var(--radius)*0.5)] border border-[var(--border)] px-2 py-1">
                      <Icon name={app?.icon ?? "app"} size={14} style={{ color: app?.accent ?? "var(--accent)" }} />
                      <span className="min-w-0 flex-1 truncate text-[12px]">{app?.name ?? id}</span>
                      <button className="os-btn !px-1.5 !py-0 text-[10px]" disabled={i === 0} onClick={() => s.reorderDock(i, i - 1)}><Icon name="arrowUp" size={10} /></button>
                      <button className="os-btn !px-1.5 !py-0 text-[10px]" disabled={i === s.dockApps.length - 1} onClick={() => s.reorderDock(i, i + 1)}><Icon name="arrowDown" size={10} /></button>
                      <button className="os-btn !px-1.5 !py-0 text-[10px]" onClick={() => s.toggleDockApp(id)}><Icon name="close" size={11} /></button>
                    </div>
                  );
                })}
              </div>
              <details>
                <summary className="cursor-pointer text-[11.5px] text-[var(--muted)]">Add an app to the dock</summary>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {APPS.filter((a) => !s.dockApps.includes(a.id)).map((a) => (
                    <button key={a.id} className="os-btn !py-0.5 text-[10.5px]" onClick={() => s.toggleDockApp(a.id)}><Icon name={a.icon} size={10} className="mr-1" />{a.name}</button>
                  ))}
                </div>
              </details>
            </div>

            <div>
              <div className="os-label mb-2">Windows</div>
              <Field label="Titlebar style">
                <div className="flex gap-1.5">
                  {(["mac", "windows", "minimal"] as const).map((t) => (
                    <button key={t} onClick={() => s.set("titlebarStyle", t)} className={cn("os-btn !py-1 text-[11px]", s.titlebarStyle === t && "!border-[var(--accent)] !bg-[var(--accent)]/16")}>{t}</button>
                  ))}
                </div>
              </Field>
              <div className="mt-3">
                <Field label="Window chrome">
                  <div className="flex gap-1.5">
                    {(["glass", "solid", "outline"] as const).map((t) => (
                      <button key={t} onClick={() => s.set("windowChrome", t)} className={cn("os-btn !py-1 text-[11px]", s.windowChrome === t && "!border-[var(--accent)] !bg-[var(--accent)]/16")}>{t}</button>
                    ))}
                  </div>
                </Field>
              </div>
              <div className="mt-3">
                <Toggle label="Edge snapping" checked={s.snapEnabled} onChange={(v) => s.set("snapEnabled", v)} hint="Drag a window to a screen edge to tile it." />
                <Toggle label="Focus follows mouse" checked={s.focusFollowsMouse} onChange={(v) => s.set("focusFollowsMouse", v)} />
                <Toggle label="Top bar" checked={s.topBarVisible} onChange={(v) => s.set("topBarVisible", v)} />
                <Toggle label="Desktop icons" checked={s.showDesktopIcons} onChange={(v) => s.set("showDesktopIcons", v)} />
                <Toggle label="Widgets" checked={s.showWidgets} onChange={(v) => s.set("showWidgets", v)} />
              </div>

              <div className="os-label mb-1.5 mt-4">Open at startup</div>
              <div className="flex flex-wrap gap-1">
                {APPS.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => s.set("startupApps", s.startupApps.includes(a.id) ? s.startupApps.filter((x) => x !== a.id) : [...s.startupApps, a.id])}
                    className={cn("os-btn !py-0.5 text-[10.5px]", s.startupApps.includes(a.id) && "!border-[var(--accent)] !bg-[var(--accent)]/16")}
                  >
                    <Icon name={a.icon} size={10} className="mr-1" />{a.name}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── PERSONALITY ── */}
        {tab === "personality" && (
          <div className="grid max-w-5xl gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
            <div>
              <div className="os-label mb-1.5">Desktop pet</div>
              <p className="mb-3 max-w-xl text-[12px] leading-relaxed text-[var(--muted)]">
                Click it on the desktop and whichever model you have configured answers in one sentence,
                in the voice you pick below — capped at 60 tokens, so patting the cat costs a fraction of a cent.
                With no key, no network, or a model that errors, it falls back to its own lines instead of going quiet.
              </p>

              <div className="mb-3 flex flex-wrap items-center gap-1.5">
                <button
                  onClick={() => { s.set("pet", "none"); s.set("petVisible", false); }}
                  className={cn("os-btn !py-1 text-[11px]", !s.petVisible && "!border-[var(--accent)] !bg-[var(--accent)]/16")}
                >
                  No pet
                </button>
                <span className="text-[11px] text-[var(--muted)]">{SPECIES.length} creatures</span>
              </div>

              {PET_FAMILIES.map((fam) => (
                <div key={fam.id} className="mb-4">
                  <div className="os-label mb-1.5">{fam.label}</div>
                  <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))" }}>
                    {SPECIES.filter((x) => x.family === fam.id).map((x) => (
                      <button
                        key={x.id}
                        onClick={() => { s.set("pet", x.id); s.set("petVisible", true); }}
                        className={cn("os-card !p-1.5 text-center", s.pet === x.id && s.petVisible && "!border-[var(--accent)] ring-1 ring-[var(--accent)]")}
                        title={x.blurb}
                      >
                        <div className="flex justify-center" style={{ color: "var(--accent)" }}>
                          <PetSprite species={x} detail={s.petDetail as "basic" | "detailed" | "expressive"} size={52} />
                        </div>
                        <div className="truncate text-[10.5px]">{x.name}</div>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="lg:sticky lg:top-0 lg:self-start">
              {s.petVisible && getSpecies(s.pet) && (
                <div className="os-card mb-3 text-center">
                  <div className="mb-1 flex justify-center" style={{ color: "var(--accent)" }}>
                    <PetSprite species={getSpecies(s.pet)!} detail={s.petDetail as "basic" | "detailed" | "expressive"} size={110} mood="happy" />
                  </div>
                  <div className="text-[13px] font-medium">{s.petName || getSpecies(s.pet)!.name}</div>
                  <div className="text-[11px] text-[var(--muted)]">{getSpecies(s.pet)!.blurb}</div>
                </div>
              )}

              <Field label="Name it">
                <input
                  value={s.petName}
                  onChange={(e) => s.set("petName", e.target.value.slice(0, 24))}
                  placeholder={getSpecies(s.pet)?.name ?? "Pet"}
                  className="os-input !py-1 text-[12px]"
                />
              </Field>

              <div className="os-label mb-1.5 mt-3">Detail</div>
              <div className="mb-3 flex gap-1.5">
                {(["basic", "detailed", "expressive"] as const).map((d) => (
                  <button key={d} onClick={() => s.set("petDetail", d)} className={cn("os-btn !py-1 text-[11px]", s.petDetail === d && "!border-[var(--accent)] !bg-[var(--accent)]/16")}>{d}</button>
                ))}
              </div>
              <div className="mb-3 text-[10.5px] leading-relaxed text-[var(--muted)]">
                Basic is a flat outline that takes the theme accent — it is the right look on CRT and Amiga profiles.
                Expressive adds blinking, breathing and a swaying tail.
              </div>

              <div className="os-label mb-1.5">Behaviour</div>
              <div className="mb-3 flex gap-1.5">
                {(["still", "wander", "follow"] as const).map((m) => (
                  <button key={m} onClick={() => s.set("petMotion", m)} className={cn("os-btn !py-1 text-[11px]", s.petMotion === m && "!border-[var(--accent)] !bg-[var(--accent)]/16")}>{m}</button>
                ))}
              </div>

              <Slider label="Size" value={s.petScale} min={0.6} max={2.2} step={0.1} onChange={(v) => s.set("petScale", v)} format={(v) => `${Math.round(v * 100)}%`} />

              <div className="os-label mb-1.5 mt-2">Pet personality</div>
              <div className="mb-3 space-y-1">
                {PERSONALITIES.map((pp) => (
                  <button
                    key={pp.id}
                    onClick={() => s.set("petPersonality", pp.id)}
                    className={cn("block w-full rounded-[calc(var(--radius)*0.5)] border px-2 py-1.5 text-left", s.petPersonality === pp.id ? "border-[var(--accent)] bg-[var(--accent)]/12" : "border-[var(--border)]")}
                  >
                    <div className="text-[12px]">{pp.name}</div>
                    <div className="text-[10.5px] text-[var(--muted)]">{pp.blurb}</div>
                  </button>
                ))}
              </div>

              <Toggle label="Let the pet use your model" checked={s.petTalks} onChange={(v) => s.set("petTalks", v)} hint="Off means it only uses its own written lines — free, offline, and still in character." />

              <div className="my-4 h-px bg-[var(--border)]" />

              <div className="os-label mb-1.5">Assistant voice</div>
              <p className="mb-2 text-[10.5px] leading-relaxed text-[var(--muted)]">
                Prepended to the system prompt in every app that talks to a model. Separate from the pet on purpose —
                wanting a gremlin on your wallpaper is not wanting one in your code review.
              </p>
              <select value={s.voice} onChange={(e) => s.set("voice", e.target.value)} className="os-input mb-1.5 !py-1 text-[12px]">
                {VOICES.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
              <div className="mb-3 text-[10.5px] italic leading-relaxed text-[var(--muted)]">
                {VOICES.find((v) => v.id === s.voice)?.line}
              </div>

              <Field label="About you" hint="Appended to every system prompt. Your role, your stack, how you like answers.">
                <textarea
                  value={s.aboutMe}
                  onChange={(e) => s.set("aboutMe", e.target.value.slice(0, 1200))}
                  rows={4}
                  placeholder="e.g. I write TypeScript and Rust. Skip the preamble and show me the code."
                  className="os-input resize-y !py-1 text-[12px]"
                />
              </Field>

              <div className="mt-3">
                <Toggle label="Fun mode" checked={s.funMode} onChange={(v) => s.set("funMode", v)} hint="Easter eggs, secret key sequences and the hidden arcade entries." />
                <Toggle label="Greet me on boot" checked={s.greeting} onChange={(v) => s.set("greeting", v)} />
              </div>
            </div>
          </div>
        )}

        {/* ── WIDGETS ── */}
        {tab === "widgets" && (
          <div className="max-w-3xl">
            <WidgetBuilder />
            <div className="my-5 h-px bg-[var(--border)]" />
            <p className="mb-3 text-[12px] text-[var(--muted)]">Widgets sit on the desktop behind your windows and can be dragged anywhere.</p>
            <div className="mb-4 flex flex-wrap gap-1.5">
              {WIDGET_KINDS.map((k) => (
                <button key={k.id} className="os-btn !py-1 text-[11px]" onClick={() => s.addWidget(k.id)}>+ {k.icon} {k.name}</button>
              ))}
            </div>
            <div className="os-label mb-1.5">Placed ({s.widgets.length})</div>
            {s.widgets.length === 0 && <div className="text-[12px] text-[var(--muted)]">None placed.</div>}
            <div className="space-y-1">
              {s.widgets.map((w) => (
                <div key={w.id} className="flex items-center gap-2 rounded-[calc(var(--radius)*0.5)] border border-[var(--border)] px-2 py-1.5">
                  <Icon name={WIDGET_KINDS.find((k) => k.id === w.kind)?.icon ?? "widgets"} size={14} />
                  <span className="flex-1 text-[12px]">{WIDGET_KINDS.find((k) => k.id === w.kind)?.name ?? w.kind}</span>
                  <span className="text-[10px] text-[var(--muted)]">{Math.round(w.x)}, {Math.round(w.y)}</span>
                  <button className="os-btn !px-2 !py-0 text-[10px]" onClick={() => s.removeWidget(w.id)}><Icon name="close" size={11} /></button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── TOKENS ── */}
        {tab === "tokens" && (
          <div className="max-w-3xl">
            <p className="mb-3 text-[12px] leading-relaxed text-[var(--muted)]">
              Every colour and measurement in the OS resolves to one of these CSS custom properties. Edit one and the
              change is instant and total — there is no second styling system underneath. Overrides survive theme
              tweaks but are cleared when you switch profile or preset theme.
            </p>
            <div className="grid gap-1.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
              {Object.entries(resolveTokens(s)).map(([name, value]) => {
                const overridden = name in s.customVars;
                const isColor = /^(#|rgb|hsl|color-mix)/.test(value.trim());
                return (
                  <div key={name} className={cn("flex items-center gap-2 rounded-[calc(var(--radius)*0.5)] border px-2 py-1.5", overridden ? "border-[var(--accent)]" : "border-[var(--border)]")}>
                    {isColor && <span className="h-5 w-5 shrink-0 rounded border border-[var(--border)]" style={{ background: value }} />}
                    <code className="shrink-0 text-[10.5px] text-[var(--muted)]">{name}</code>
                    <input
                      value={value}
                      onChange={(e) => s.setVar(name, e.target.value)}
                      className="min-w-0 flex-1 bg-transparent font-[family-name:var(--font-mono)] text-[10.5px] outline-none"
                    />
                    {overridden && <button className="shrink-0 text-[10px] opacity-60 hover:opacity-100" title="Reset to theme value" onClick={() => s.clearVar(name)}><Icon name="backup" size={11} /></button>}
                  </div>
                );
              })}
            </div>
            {Object.keys(s.customVars).length > 0 && (
              <button className="os-btn mt-3 !py-1 text-[11px]" onClick={() => Object.keys(s.customVars).forEach(s.clearVar)}>
                Clear all {Object.keys(s.customVars).length} overrides
              </button>
            )}
          </div>
        )}

        {/* ── BACKUP ── */}
        {tab === "backup" && (
          <div className="max-w-xl">
            <div className="os-card mb-3">
              <div className="mb-1.5 font-medium text-[13px]">Export your setup</div>
              <p className="mb-2 text-[12px] text-[var(--muted)]">
                Everything on these tabs, as JSON. API keys are deliberately stripped, so a profile is safe to share.
              </p>
              <div className="flex gap-1.5">
                <button className="os-btn !py-1 text-[11px]" onClick={() => download(`web-aios-profile-${Date.now()}.json`, s.exportProfile(), "application/json")}>Download profile</button>
                <button className="os-btn !py-1 text-[11px]" onClick={() => navigator.clipboard.writeText(s.exportProfile())}>Copy JSON</button>
              </div>
            </div>

            <div className="os-card mb-3">
              <div className="mb-1.5 font-medium text-[13px]">Import a profile</div>
              <p className="mb-2 text-[12px] text-[var(--muted)]">Your stored keys are never overwritten by an import.</p>
              <button className="os-btn !py-1 text-[11px]" onClick={() => importRef.current?.click()}>Choose file…</button>
              <input ref={importRef} type="file" accept="application/json" hidden onChange={(e) => { importProfile(e.target.files?.[0]); e.target.value = ""; }} />
            </div>

            <div className="os-card" style={{ borderColor: "var(--danger)" }}>
              <div className="mb-1.5 font-medium text-[13px]">Reset personalization</div>
              <p className="mb-2 text-[12px] text-[var(--muted)]">Restores factory defaults. Your files, chats and keys are not touched.</p>
              <button className="os-btn !py-1 text-[11px]" onClick={() => { s.reset(); bus.emit("notify", { title: "Personalization reset", kind: "info" }); }}>Reset to defaults</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function cssVar(name: string): string {
  if (typeof window === "undefined") return "#67e8f9";
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  // <input type="color"> only accepts #rrggbb, so anything else needs a stand-in.
  return /^#[0-9a-f]{6}$/i.test(v) ? v : "#67e8f9";
}
