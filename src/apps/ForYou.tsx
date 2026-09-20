"use client";

import { useMemo, useState } from "react";
import type { AppProps } from "@/kernel/types";
import { useSettings } from "@/kernel/settings";
import { useCustomWidgets } from "@/kernel/widgets";
import { useUserApps } from "@/kernel/userapps";
import { bus } from "@/kernel/bus";
import { gatherSignals, clearActivity } from "@/kernel/activity";
import { extractInterests } from "@/lib/interests";
import { suggestionPrompt, parseSuggestions, offlineSuggestions, type Suggestion, type SuggestAllowed } from "@/lib/suggest";
import { NEWS_SOURCES } from "@/lib/feeds";
import { SERVICES } from "@/lib/services";
import { ask } from "@/lib/useAI";
import { useNow } from "@/lib/useNow";
import { extractCode, explainNoCode } from "@/lib/extract-code";
import { WIDGET_KINDS } from "@/shell/Widgets";
import { WIDGET_SYSTEM } from "@/apps/WidgetBuilder";
import { ModelOverride, overrideOpts, type ModelChoice } from "@/shell/ModelOverride";
import { Empty, ErrorNote, Spinner } from "./_ui";
import { Icon } from "@/shell/icons";

/* The model in the top bar looks at what you have been doing here and
   proposes widgets and apps. Only the extracted TERMS are sent — never files,
   chats or prompts — and the terms are passed as quoted data, not as
   instructions, so a file named "ignore previous instructions" stays a file. */

const SIZE: Record<string, { w: number; h: number }> = { news: { w: 320, h: 280 }, data: { w: 300, h: 240 } };

function allowedNow(): SuggestAllowed {
  const s = useSettings.getState();
  return {
    widgetKinds: [...new Set([...WIDGET_KINDS.map((k) => k.id), "news", "data"])],
    services: SERVICES.map((d) => ({ id: d.id, name: d.name, description: d.description, params: d.params.map((p) => ({ name: p.name, required: p.required })) })),
    newsSources: NEWS_SOURCES.map((n) => ({ id: n.id, name: n.name, category: n.category })),
    existing: {
      widgetKinds: s.widgets.map((w) => w.kind),
      customWidgetNames: useCustomWidgets.getState().widgets.map((w) => w.name),
      appNames: useUserApps.getState().apps.map((a) => a.name),
      widgetConfigs: s.widgets.map((w) => ({ kind: w.kind, config: w.config })),
    },
  };
}

export default function ForYou({}: AppProps) {
  // Bumped by Refresh; the profile is recomputed only when asked, so reading
  // every store is not a per-render cost.
  const now = useNow(60_000);
  const [epoch, setEpoch] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- epoch is a manual refresh trigger
  const interests = useMemo(() => extractInterests(gatherSignals(), now), [now, epoch]);
  const [choice, setChoice] = useState<ModelChoice>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [list, setList] = useState<Suggestion[]>([]);
  const [rejected, setRejected] = useState<Array<{ title: string; reason: string }>>([]);
  const [offline, setOffline] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [done, setDone] = useState<string[]>([]);

  const suggest = async () => {
    setBusy(true); setError(null); setRejected([]);
    const allowed = allowedNow();
    try {
      const res = await ask({
        system: "You suggest desktop widgets and apps for one person. You return JSON only.",
        messages: [{ role: "user", content: suggestionPrompt(interests, allowed, 8) }],
        persona: false, maxTokens: 1500, temperature: 0.7, ...overrideOpts(choice),
      });
      const r = parseSuggestions(res.text, allowed, 8);
      setList(r.suggestions); setRejected(r.rejected); setOffline(false);
      if (r.suggestions.length === 0) setError("The model's suggestions were all rejected as invalid or duplicates — see below.");
    } catch (e) {
      // Honest error, and still useful: the offline matcher needs no model.
      setError(e instanceof Error ? e.message : "The model call failed.");
      setList(offlineSuggestions(interests, allowed, 6)); setOffline(true);
    } finally { setBusy(false); }
  };

  const act = async (s: Suggestion) => {
    const key = s.title;
    if (s.type === "app") {
      bus.emit("app:open", { appId: "studio", args: { tab: "build", prompt: s.prompt } });
      setDone((d) => [...d, key]);
      return;
    }
    if (s.type === "widget" && s.kind) {
      useSettings.getState().addWidget(s.kind, { config: s.config, ...(SIZE[s.kind] ?? {}) });
      bus.emit("notify", { title: `Added "${s.title}" to the desktop`, kind: "success" });
      setDone((d) => [...d, key]);
      return;
    }
    setWorking(key); setError(null);
    try {
      const res = await ask({ system: WIDGET_SYSTEM, messages: [{ role: "user", content: s.prompt ?? s.title }], maxTokens: 8000, persona: false, ...overrideOpts(choice) });
      const code = extractCode(res.text);
      if (!code) throw new Error(explainNoCode(res.text));
      const id = useCustomWidgets.getState().add({ name: s.title, prompt: s.prompt ?? s.title, html: code, icon: "widgets", w: 260, h: 170 });
      useSettings.getState().addWidget("custom", { customId: id, w: 260, h: 170 });
      bus.emit("notify", { title: `Built "${s.title}"`, kind: "success" });
      setDone((d) => [...d, key]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not build that widget.");
    } finally { setWorking(null); }
  };

  return (
    <div className="h-full overflow-y-auto p-3">
      <ErrorNote error={error} onDismiss={() => setError(null)} />

      <div className="mb-1.5 flex items-center gap-2">
        <span className="os-label !mb-0">What I think you are into</span>
        <button className="os-chip !py-0 !text-[10px]" onClick={() => setEpoch((e) => e + 1)}><Icon name="refresh" size={10} /> Refresh</button>
        <button className="os-chip !py-0 !text-[10px]" onClick={() => { clearActivity(); setEpoch((e) => e + 1); }}>Forget activity</button>
      </div>
      {interests.length === 0 ? (
        <Empty icon="sparkles" title="Nothing yet" body="Search, build, write and read around the OS for a while — suggestions get better the more there is to go on." />
      ) : (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {interests.map((i) => <span key={i.term} className="os-chip !text-[10.5px]" title={`from ${i.sources.join(", ")}`}>{i.term}</span>)}
        </div>
      )}
      <p className="mb-3 text-[10.5px] text-[var(--muted)]">Built from your activity and kept in this browser. Only these terms are sent when you ask for suggestions.</p>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button className="os-btn" data-variant="primary" disabled={busy} onClick={() => void suggest()}>
          <Icon name="sparkles" size={13} /> {busy ? "Thinking…" : "Suggest for me"}
        </button>
        <ModelOverride id="foryou" value={choice} onChange={setChoice} />
        {busy && <Spinner />}
      </div>

      {offline && list.length > 0 && <p className="mb-2 text-[10.5px] text-[var(--muted)]">No model answered, so these come from matching your interests against the free services and news feeds.</p>}

      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
        {list.map((s) => (
          <div key={s.title} className="os-card !p-2.5">
            <div className="mb-1 flex items-center gap-1.5">
              <span className="os-chip !px-1.5 !py-0 !text-[9px]">{s.type === "widget" ? `${s.kind} widget` : s.type === "custom-widget" ? "new widget" : "app"}</span>
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{s.title}</span>
            </div>
            <p className="mb-2 text-[11px] leading-snug text-[var(--muted)]">{s.why}</p>
            <button className="os-btn !py-1 text-[11px]" disabled={working !== null || done.includes(s.title)} onClick={() => void act(s)}>
              {done.includes(s.title) ? "Added" : working === s.title ? "Building…" : s.type === "app" ? "Build in AI Studio" : s.type === "custom-widget" ? "Build it" : "Add to desktop"}
            </button>
          </div>
        ))}
      </div>

      {rejected.length > 0 && (
        <details className="mt-3 text-[10.5px] text-[var(--muted)]">
          <summary className="cursor-pointer">{rejected.length} suggestion(s) rejected</summary>
          {rejected.map((r, i) => <p key={i}>· {r.title}: {r.reason}</p>)}
        </details>
      )}
    </div>
  );
}
