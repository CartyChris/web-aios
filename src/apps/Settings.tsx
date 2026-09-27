"use client";

import { useEffect, useState } from "react";
import { useSettings, DEFAULT_KEYBINDS } from "@/kernel/settings";
import { useModelCatalog, modelsFor } from "@/kernel/modelcatalog";
import { ModelRefreshButton, ModelRefreshStatus } from "@/shell/ModelRefresh";
import { OnDeviceSetup } from "@/shell/OnDeviceSetup";
import { useVFS } from "@/kernel/vfs";
import { useWM } from "@/kernel/wm";
import { PROVIDERS, getProvider } from "@/lib/providers";
import { APPS } from "@/kernel/registry";
import { bus } from "@/kernel/bus";
import type { AppProps } from "@/kernel/types";
import { bytes, download } from "@/lib/format";
import { Tabs, Slider, Field, ErrorNote, Spinner } from "./_ui";
import { cn } from "@/lib/cn";
import { Icon } from "@/shell/icons";
import { findConflicts, actionLabel, searchSettings, type SettingEntry } from "@/lib/keyhelp";
import { ShortcutSheet } from "@/shell/ShortcutSheet";
import { ScreenFit } from "@/shell/ScreenFit";

const TAB_LABELS: Record<string, string> = {
  providers: "Providers & Keys", ai: "AI", keys: "Keyboard", screen: "Phone & Screen", privacy: "Privacy", storage: "Storage", about: "About",
};
const E = (tab: string, label: string, keywords: string): SettingEntry => ({ tab, tabLabel: TAB_LABELS[tab], label, keywords });

/** What the search box can find. Each entry names a real control on that tab. */
const SETTINGS_INDEX: SettingEntry[] = [
  E("providers", "API keys", "key token secret openai anthropic gemini openrouter groq provider"),
  E("providers", "Active provider", "use switch provider vendor"),
  E("providers", "Base URL", "endpoint server compatible url host"),
  E("providers", "Refresh model list", "models catalogue catalog sync list"),
  E("providers", "Local models", "ollama lm studio localhost offline"),
  E("ai", "Model", "model id gpt claude llm"),
  E("ai", "Temperature", "creativity randomness sampling"),
  E("ai", "Max tokens per reply", "length output limit tokens"),
  E("ai", "Budget cap", "budget spend cost limit usd dollars money"),
  E("ai", "Estimated spend", "cost spent usage money"),
  E("ai", "Default system prompt", "persona instructions system prompt"),
  E("keys", "Keyboard shortcuts", "keybinds hotkeys shortcut bindings chord"),
  E("keys", "Shortcut cheat sheet", "cheatsheet overview list help keys"),
  E("keys", "Reset all shortcuts", "default restore keybinds"),
  E("screen", "Phone layout", "mobile phone desktop auto layout screen"),
  E("screen", "Phone tips", "tips hints onboarding"),
  E("screen", "Status bar and screen fit", "iphone pwa home screen bottom gap band black bar cut off notch dynamic island status bar"),
  E("privacy", "What leaves this browser", "network data privacy telemetry"),
  E("privacy", "App permissions", "permissions allow deny apps"),
  E("privacy", "Erase everything", "reset wipe delete clear data"),
  E("storage", "Filesystem usage", "storage files bytes quota vfs"),
  E("storage", "Local storage keys", "localstorage persist keys size"),
  E("storage", "Export and import", "backup export import json"),
  E("about", "Version and runtime", "about version pwa runtime build"),
];



/** Settings — providers and keys, AI tuning, keybindings, privacy and storage. */
export default function Settings({}: AppProps) {
  const s = useSettings();
  const vfs = useVFS();
  const wm = useWM();
  const [tab, setTab] = useState("providers");
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState<string | null>(null);
  const [capturing, setCapturing] = useState<string | null>(null);
  const [find, setFind] = useState("");
  const [sheet, setSheet] = useState(false);
  const found = searchSettings(SETTINGS_INDEX, find);
  const conflicts = findConflicts(s.keybinds);
  const conflicted = new Set(conflicts.flatMap((c) => c.actions));

  const provider = getProvider(s.ai.provider);

  // The refreshed list for the active provider, persisted per provider in the
  // model-catalogue store (so a refresh here also updates the model picker),
  // or the built-in catalogue until the first refresh. Keyed by provider, so
  // switching provider can never show another provider's stale list.
  const catalogLists = useModelCatalog((st) => st.lists);
  const models = provider ? modelsFor(provider.id, catalogLists).map((m) => m.id) : [];
  const loadingModels = useModelCatalog((st) => Boolean(provider && st.busy[provider.id]));

  // Keybinding capture: read the next chord the user presses.
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") { setCapturing(null); return; }
      if (["Meta", "Control", "Shift", "Alt"].includes(e.key)) return;
      const parts: string[] = [];
      if (e.metaKey || e.ctrlKey) parts.push("mod");
      if (e.shiftKey) parts.push("shift");
      if (e.altKey) parts.push("alt");
      const named: Record<string, string> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", " ": "space" };
      parts.push(named[e.key] ?? e.key.toLowerCase());
      s.set("keybinds", { ...s.keybinds, [capturing]: parts.join("+") });
      setCapturing(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing, s]);

  const usage = vfs.usage();

  return (
    <div
      className="relative flex h-full flex-col"
      onKeyDown={(e) => {
        const t = e.target as HTMLElement;
        if (e.key === "?" && !capturing && t.tagName !== "INPUT" && t.tagName !== "TEXTAREA" && t.tagName !== "SELECT") { e.preventDefault(); setSheet(true); }
        if (e.key === "Escape" && sheet) setSheet(false);
      }}
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--border)] px-2.5 py-1.5">
        <Icon name="search" size={12} className="text-[var(--muted)]" />
        <input
          value={find}
          onChange={(e) => setFind(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && found[0]) { setTab(found[0].tab); setFind(""); } if (e.key === "Escape") setFind(""); }}
          placeholder="Search settings (budget, keys, ollama...)"
          aria-label="Search settings"
          className="os-input min-w-0 flex-1 !py-1 text-[12px]"
        />
        <button className="os-btn !py-1 text-[11px]" onClick={() => setSheet(true)} aria-label="Keyboard shortcut cheat sheet" title="Keyboard shortcuts (?)">
          <Icon name="keyboard" size={12} /> Shortcuts
        </button>
      </div>
      {find.trim() && (
        <div className="shrink-0 border-b border-[var(--border)] p-1.5" role="listbox" aria-label="Matching settings">
          {found.length === 0 ? (
            <div className="px-1.5 py-1 text-[11px] text-[var(--muted)]">No setting matches &quot;{find}&quot;.</div>
          ) : found.slice(0, 8).map((e) => (
            <button key={e.tab + e.label} role="option" aria-selected={false} className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[12px] hover:bg-white/6" onClick={() => { setTab(e.tab); setFind(""); }}>
              <span className="min-w-0 flex-1 truncate">{e.label}</span>
              <span className="shrink-0 text-[10.5px] text-[var(--muted)]">{e.tabLabel}</span>
            </button>
          ))}
        </div>
      )}
      <Tabs
        tabs={[
          { id: "providers", label: "Providers & Keys", icon: "key" },
          { id: "ai", label: "AI", icon: "spark" },
          { id: "keys", label: "Keyboard", icon: "keyboard" },
          { id: "screen", label: "Phone & Screen", icon: "monitor" },
          { id: "privacy", label: "Privacy", icon: "shield" },
          { id: "storage", label: "Storage", icon: "backup" },
          { id: "about", label: "About", icon: "info" },
        ]}
        active={tab}
        onChange={setTab}
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <ErrorNote error={error} onDismiss={() => setError(null)} />

        {tab === "providers" && (
          <div className="max-w-3xl">
            <div className="os-card mb-3" style={{ borderColor: "var(--accent)" }}>
              <div className="mb-1 font-medium text-[13px]">Where your keys go</div>
              <p className="text-[12px] leading-relaxed text-[var(--muted)]">
                Keys are stored in this browser&apos;s local storage and nowhere else. They are sent only to the provider
                you select, on a request you make. They are stripped from every profile export. If the deployment has its
                own key in an environment variable, you do not need to enter one at all — leave the field blank and it
                will be used instead.
                <br /><br />
                Local providers (Ollama, LM Studio) are called straight from this browser, because a server on Vercel
                has no route to your machine&apos;s localhost.
              </p>
            </div>

            <div className="space-y-2">
              {PROVIDERS.map((p) => {
                const active = s.ai.provider === p.id;
                const hasKey = Boolean(s.ai.keys[p.id]);
                return (
                  <div key={p.id} className={cn("os-card", active && "!border-[var(--accent)]")}>
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <button
                        className={cn("os-btn !py-0.5 text-[11px]", active && "!border-[var(--accent)] !bg-[var(--accent)]/16")}
                        onClick={() => { s.setAI("provider", p.id); if (p.models[0]) s.setAI("model", p.models[0]); }}
                      >
                        {active ? "● Active" : "Use"}
                      </button>
                      <span className="font-medium text-[13px]">{p.name}</span>
                      {p.local && <span className="os-chip !text-[10px]">local · no key needed</span>}
                      {hasKey && <span className="os-chip !text-[10px]" style={{ borderColor: "var(--ok)" }}>key set</span>}
                      <div className="flex-1" />
                      {p.docs && <a href={p.docs} target="_blank" rel="noopener noreferrer" className="text-[11px] text-[var(--accent)] underline">get a key ↗</a>}
                    </div>

                    {!p.local && (
                      <div className="mb-1.5 flex gap-1.5">
                        <input
                          type={reveal === p.id ? "text" : "password"}
                          value={s.ai.keys[p.id] ?? ""}
                          onChange={(e) => s.setAI("keys", { ...s.ai.keys, [p.id]: e.target.value })}
                          placeholder={p.envKey ? `Your key, or leave blank to use ${p.envKey}` : "API key"}
                          autoComplete="off"
                          spellCheck={false}
                          className="os-input flex-1 !py-1 font-[family-name:var(--font-mono)] text-[11px]"
                        />
                        <button className="os-btn !py-1 text-[11px]" onClick={() => setReveal(reveal === p.id ? null : p.id)}>
                          {reveal === p.id ? "Hide" : "Show"}
                        </button>
                        {hasKey && (
                          <button className="os-btn !py-1 text-[11px]" onClick={() => { const k = { ...s.ai.keys }; delete k[p.id]; s.setAI("keys", k); }}>Clear</button>
                        )}
                      </div>
                    )}

                    <input
                      value={s.ai.baseUrls[p.id] ?? ""}
                      onChange={(e) => s.setAI("baseUrls", { ...s.ai.baseUrls, [p.id]: e.target.value })}
                      placeholder={p.baseUrl || "Base URL (OpenAI-compatible)"}
                      className="os-input !py-1 font-[family-name:var(--font-mono)] text-[11px]"
                    />

                    {/* The model list: refresh asks the provider (with the key
                        and base URL above) and every picker uses the result. */}
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10.5px] text-[var(--muted)]">
                      <ModelRefreshButton providerId={p.id} />
                      <span className="tabular-nums">{modelsFor(p.id, catalogLists).length} models</span>
                      <span className="opacity-50">·</span>
                      <ModelRefreshStatus providerId={p.id} className="min-w-0" />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {tab === "ai" && (
          <div className="max-w-xl">
            <Field label="Model" hint="Any model id the provider accepts — the list is a convenience, not a limit.">
              <div className="flex gap-1.5">
                <input value={s.ai.model} onChange={(e) => s.setAI("model", e.target.value)} list="settings-models" className="os-input flex-1" />
                {provider && <ModelRefreshButton providerId={provider.id} />}
              </div>
              {provider && <ModelRefreshStatus providerId={provider.id} className="mt-1 block text-[10.5px] text-[var(--muted)]" />}
              <datalist id="settings-models">{models.map((m) => <option key={m} value={m} />)}</datalist>
            </Field>
            <OnDeviceSetup />
            {loadingModels && <div className="mt-1"><Spinner label="Querying provider…" /></div>}

            <div className="mt-4">
              <Slider label="Temperature" value={s.ai.temperature} min={0} max={2} step={0.05} onChange={(v) => s.setAI("temperature", v)} format={(v) => v.toFixed(2)} />
              <Slider label="Max tokens per reply" value={s.ai.maxTokens} min={256} max={32000} step={256} onChange={(v) => s.setAI("maxTokens", v)} format={(v) => v.toLocaleString()} />
              <Slider label="Budget cap" value={s.ai.budgetUsd} min={0} max={200} step={1} onChange={(v) => s.setAI("budgetUsd", v)} format={(v) => (v === 0 ? "no cap" : `$${v}`)} />
            </div>

            <div className="os-card mb-4">
              <div className="mb-1 flex items-baseline justify-between">
                <span className="os-label">Estimated spend</span>
                <span className="tabular-nums text-[12px]">${s.ai.spentUsd.toFixed(4)}</span>
              </div>
              <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full" style={{ width: `${Math.min(100, (s.ai.spentUsd / Math.max(0.0001, s.ai.budgetUsd)) * 100)}%`, background: "var(--accent)" }} />
              </div>
              <div className="flex items-center gap-2">
                <button className="os-btn !py-0.5 text-[10.5px]" onClick={() => s.setAI("spentUsd", 0)}>Reset counter</button>
                <span className="text-[10.5px] text-[var(--muted)]">
                  Estimated from token counts and a published price table — not a bill. Check your provider for actual usage.
                </span>
              </div>
            </div>

            <Field label="Default system prompt" hint="Apps with their own persona override this.">
              <textarea value={s.ai.systemPrompt} onChange={(e) => s.setAI("systemPrompt", e.target.value)} rows={4} className="os-input resize-none text-[12px]" />
            </Field>
          </div>
        )}

        {tab === "keys" && (
          <div className="max-w-xl">
            <p className="mb-3 text-[12px] text-[var(--muted)]">
              Click a shortcut, then press the keys you want. <kbd className="rounded bg-white/10 px-1">mod</kbd> is ⌘ on
              a Mac and Ctrl elsewhere. Escape cancels.
            </p>
            <div className="space-y-1">
              {Object.entries(s.keybinds).map(([action, binding]) => (
                <div key={action} className="flex items-center gap-2 rounded-[calc(var(--radius)*0.5)] border border-[var(--border)] px-2 py-1.5">
                  <span className="flex-1 text-[12px]">{action.replace(/\./g, " › ")}</span>
                  {conflicted.has(action) && <span className="os-chip !text-[10px]" style={{ borderColor: "var(--danger)", color: "var(--danger)" }} title="Another action uses the same keys, so only one of them can run">conflict</span>}
                  <button
                    onClick={() => setCapturing(action)}
                    className={cn("os-btn !py-0.5 font-[family-name:var(--font-mono)] text-[11px]", capturing === action && "!border-[var(--accent)] !bg-[var(--accent)]/16")}
                  >
                    {capturing === action ? "press keys…" : binding}
                  </button>
                  {binding !== DEFAULT_KEYBINDS[action] && (
                    <button className="text-[10px] opacity-60 hover:opacity-100" title="Reset" onClick={() => s.set("keybinds", { ...s.keybinds, [action]: DEFAULT_KEYBINDS[action] })}><Icon name="backup" size={11} /></button>
                  )}
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <button className="os-btn !py-1 text-[11px]" onClick={() => s.set("keybinds", { ...DEFAULT_KEYBINDS })}>Reset all shortcuts</button>
              <button className="os-btn !py-1 text-[11px]" onClick={() => setSheet(true)}>Show cheat sheet</button>
            </div>
            {conflicts.length > 0 && (
              <p className="mt-2 text-[11px]" style={{ color: "var(--danger)" }}>
                {conflicts.length} conflict{conflicts.length === 1 ? "" : "s"}: {conflicts.map((c) => `${c.chord} is bound to ${c.actions.map(actionLabel).join(" and ")}`).join("; ")}.
              </p>
            )}
          </div>
        )}

        {tab === "screen" && (
          <div className="max-w-xl">
            <div className="os-card mb-3">
              <div className="mb-1.5 font-medium text-[13px]">On a phone, show</div>
              <p className="mb-2 text-[12px] text-[var(--muted)]">
                Automatic gives a phone the single-app phone view when upright and the full desktop when you turn it on its side.
              </p>
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Phone layout">
                {([
                  ["auto", "Automatic"],
                  ["phone", "Always phone view"],
                  ["desktop", "Always full desktop"],
                ] as const).map(([id, label]) => (
                  <button
                    key={id}
                    role="radio"
                    aria-checked={s.phoneMode === id}
                    className="os-btn !py-1 text-[11px]"
                    data-variant={s.phoneMode === id ? "primary" : undefined}
                    onClick={() => s.set("phoneMode", id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <ScreenFit />
            <div className="os-card">
              <div className="mb-1.5 font-medium text-[13px]">Phone tips</div>
              <p className="mb-2 text-[12px] text-[var(--muted)]">Show the one-time &ldquo;turn your phone on its side&rdquo; notice again the next time the phone view opens.</p>
              <button className="os-btn !py-1 text-[11px]" disabled={!s.phoneTipSeen} onClick={() => s.set("phoneTipSeen", false)}>
                Show the notice again
              </button>
            </div>
          </div>
        )}

        {tab === "privacy" && (
          <div className="max-w-2xl">
            <div className="os-card mb-3">
              <div className="mb-1.5 font-medium text-[13px]">What leaves this browser</div>
              <ul className="space-y-1.5 text-[12px] leading-relaxed text-[var(--muted)]">
                <li>· <b className="text-[var(--text)]">Model requests</b> go to the provider you select, either directly or relayed by this deployment&apos;s <code>/api/ai/chat</code>.</li>
                <li>· <b className="text-[var(--text)]">Proxied pages</b> — URLs you paste into Atlas or Browser are fetched by <code>/api/proxy</code>, which refuses private and link-local addresses and sends none of your cookies.</li>
                <li>· <b className="text-[var(--text)]">Nothing else.</b> There is no analytics, no telemetry and no account. Files, chats, settings and keys live in this browser&apos;s local storage.</li>
              </ul>
            </div>

            <div className="os-card mb-3">
              <div className="mb-1.5 font-medium text-[13px]">App permissions</div>
              <p className="mb-2 text-[12px] text-[var(--muted)]">Declared by each app so you can see what it can reach.</p>
              <div className="space-y-1">
                {APPS.filter((a) => a.permissions?.length).map((a) => (
                  <div key={a.id} className="flex items-center gap-2 text-[11.5px]">
                    <Icon name={a.icon} size={12} style={{ color: a.accent ?? "var(--accent)" }} />
                    <span className="w-32 shrink-0 truncate">{a.name}</span>
                    <span className="flex flex-wrap gap-1">
                      {a.permissions!.map((p) => <span key={p} className="os-chip !px-1.5 !py-0 !text-[9.5px]">{p}</span>)}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="os-card" style={{ borderColor: "var(--danger)" }}>
              <div className="mb-1.5 font-medium text-[13px]">Erase everything</div>
              <p className="mb-2 text-[12px] text-[var(--muted)]">Clears files, chats, settings and stored keys from this browser. Cannot be undone.</p>
              <button
                className="os-btn !py-1 text-[11px]"
                onClick={() => {
                  if (!confirm("Erase all Web-AIOS data in this browser? This cannot be undone.")) return;
                  Object.keys(localStorage).filter((k) => k.startsWith("webaios.")).forEach((k) => localStorage.removeItem(k));
                  location.reload();
                }}
              >
                Erase all local data
              </button>
            </div>
          </div>
        )}

        {tab === "storage" && (
          <div className="max-w-xl">
            <div className="os-card mb-3">
              <div className="mb-1 flex items-baseline justify-between">
                <span className="os-label">Filesystem</span>
                <span className="text-[12px]">{usage.count} files · {bytes(usage.bytes)}</span>
              </div>
              <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full" style={{ width: `${Math.min(100, (usage.bytes / (5 * 1024 * 1024)) * 100)}%`, background: usage.bytes > 4e6 ? "var(--warn)" : "var(--ok)" }} />
              </div>
              <p className="text-[11px] text-[var(--muted)]">
                Browsers cap local storage at roughly 5 MB per origin. Export regularly if you are storing much.
              </p>
            </div>

            <div className="flex flex-wrap gap-1.5">
              <button
                className="os-btn !py-1 text-[11px]"
                onClick={() => {
                  const backup = JSON.stringify({ __webaios_backup: 1, at: Date.now(), settings: JSON.parse(s.exportProfile()), vfs: JSON.parse(vfs.exportAll()) }, null, 2);
                  download(`web-aios-backup-${new Date().toISOString().slice(0, 10)}.json`, backup, "application/json");
                }}
              >
                Download full backup
              </button>
              <button className="os-btn !py-1 text-[11px]" onClick={() => { vfs.clear(); bus.emit("notify", { title: "Filesystem cleared", kind: "warn" }); }}>Clear filesystem</button>
              <button className="os-btn !py-1 text-[11px]" onClick={() => { wm.closeAll(); wm.clearNotifications(); }}>Close all windows</button>
            </div>

            <div className="os-label mb-1.5 mt-4">Local storage keys</div>
            <div className="space-y-1">
              {typeof window !== "undefined" && Object.keys(localStorage).filter((k) => k.startsWith("webaios.")).map((k) => (
                <div key={k} className="flex items-center gap-2 text-[11px]">
                  <code className="min-w-0 flex-1 truncate text-[var(--muted)]">{k}</code>
                  <span className="tabular-nums">{bytes(new Blob([localStorage.getItem(k) ?? ""]).size)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === "about" && (
          <div className="max-w-xl">
            <div className="mb-1 text-2xl font-light">Web-AIOS</div>
            <div className="mb-4 text-[12px] text-[var(--muted)]">A fully customizable AI/Agent desktop for the web.</div>
            <div className="os-card mb-3 space-y-1 text-[12px]">
              {[
                ["Apps", String(APPS.length)],
                ["Windows open", String(wm.windows.length)],
                ["Workspaces", String(wm.workspaces)],
                ["Providers", String(PROVIDERS.length)],
                ["Files", `${usage.count} (${bytes(usage.bytes)})`],
                ["Runtime", typeof navigator !== "undefined" && window.matchMedia("(display-mode: standalone)").matches ? "Installed PWA" : "Browser tab"],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between"><span className="text-[var(--muted)]">{k}</span><span>{v}</span></div>
              ))}
            </div>
            <div className="os-card text-[12px] leading-relaxed text-[var(--muted)]">
              Built from fourteen single-file harnesses and bundles, consolidated onto one kernel: a window manager, an
              app registry, a shared virtual filesystem and a provider-agnostic AI transport. Every app is code-split and
              loads on first open. Works offline once installed; model calls obviously still need a network.
            </div>
          </div>
        )}
      </div>
      {sheet && <ShortcutSheet onClose={() => setSheet(false)} />}
    </div>
  );
}
