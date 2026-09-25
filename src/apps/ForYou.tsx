"use client";

import { useMemo, useState } from "react";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { AppProps } from "@/kernel/types";
import { useSettings } from "@/kernel/settings";
import { useCustomWidgets } from "@/kernel/widgets";
import { useUserApps } from "@/kernel/userapps";
import { bus } from "@/kernel/bus";
import { trackJob } from "@/kernel/jobs";
import { gatherSignals, clearActivity } from "@/kernel/activity";
import { extractInterests } from "@/lib/interests";
import type { SignalSource } from "@/lib/interest-types";
import { suggestionPrompt, parseSuggestions, offlineSuggestions, type Suggestion, type SuggestAllowed } from "@/lib/suggest";
import {
  applyFeedback, rateSuggestion, muteTerm, unmuteTerm, isDismissed, dropDismissed, matchTerms, explainSuggestion,
  outboundAllowed, manifest, utf8Bytes, aiosHandoff, agoLabel, suggestionKey, EMPTY_FEEDBACK, type Feedback,
} from "@/lib/foryou";
import { NEWS_SOURCES } from "@/lib/feeds";
import { SERVICES } from "@/lib/services";
import { ask } from "@/lib/useAI";
import { useNow } from "@/lib/useNow";
import { extractCode, explainNoCode } from "@/lib/extract-code";
import { WIDGET_KINDS } from "@/shell/Widgets";
import { WIDGET_SYSTEM } from "@/apps/WidgetBuilder";
import { ModelOverride, overrideOpts, type ModelChoice } from "@/shell/ModelOverride";
import { CopyButton, Empty, ErrorNote, Spinner, Toggle } from "./_ui";
import { Icon } from "@/shell/icons";

/* The model in the top bar looks at what you have been doing here and
   proposes widgets and apps. Only the extracted TERMS are sent — never files,
   chats or prompts — and the terms are passed as quoted data, not as
   instructions, so a file named "ignore previous instructions" stays a file.

   Everything else on this screen is worked out here and stays here: why each
   suggestion is shown (lib/foryou.ts explainSuggestion), what More / Less and
   Mute do to the profile (applyFeedback), and the panel that shows exactly
   what Suggest would send (manifest), built from the same list the request is
   built from so the two cannot disagree. */

const SIZE: Record<string, { w: number; h: number }> = { news: { w: 320, h: 280 }, data: { w: 300, h: 240 } };
/** Terms considered before feedback, so a term the user lifted can climb into the list. */
const PROFILE_POOL = 40;
/** Terms shown and sent, as before this app had feedback. */
const SEND_LIMIT = 12;
const MAX_SUGGESTIONS = 8;
const OFFLINE_SUGGESTIONS = 6;

const SOURCE_LABEL: Record<SignalSource, string> = {
  chat: "chat", file: "file", app: "app you built", widget: "widget you built",
  search: "search", harness: "agent run", service: "data service",
};

interface LastRun {
  list: Suggestion[];
  rejected: Array<{ title: string; reason: string }>;
  offline: boolean;
  at: number;
}

interface ForYouState {
  feedback: Feedback;
  /** Off by default: the names you gave your own widgets and apps stay here. */
  shareNames: boolean;
  last: LastRun | null;
  done: string[];
  setFeedback: (fn: (fb: Feedback) => Feedback) => void;
  setShareNames: (v: boolean) => void;
  /** Stamps the time itself: a clock read belongs in the store, not in a component. */
  setLast: (l: Omit<LastRun, "at"> | null) => void;
  markDone: (key: string) => void;
  resetFeedback: () => void;
}

/* Kept in this browser, like the activity log it sits on. The last reply is
   kept so opening For You tomorrow shows what it said, without asking again. */
const useForYou = create<ForYouState>()(
  persist(
    (set) => ({
      feedback: EMPTY_FEEDBACK,
      shareNames: false,
      last: null,
      done: [],
      setFeedback: (fn) => set((s) => ({ feedback: fn(s.feedback) })),
      setShareNames: (v) => set({ shareNames: v }),
      setLast: (last) => set({ last: last ? { ...last, at: Date.now() } : null }),
      markDone: (key) => set((s) => ({ done: [...s.done.filter((d) => d !== key), key].slice(-200) })),
      resetFeedback: () => set({ feedback: EMPTY_FEEDBACK }),
    }),
    { name: "webaios.foryou.v1", storage: createJSONStorage(() => localStorage) },
  ),
);

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

const fmt = (n: number) => n.toFixed(2);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export default function ForYou({ win }: AppProps) {
  // Bumped by Refresh; the profile is recomputed only when asked, so reading
  // every store is not a per-render cost.
  const now = useNow(60_000);
  const [epoch, setEpoch] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- now and epoch are refresh triggers
  const signals = useMemo(() => gatherSignals(), [now, epoch]);
  const profile = useMemo(() => extractInterests(signals, now, { limit: PROFILE_POOL }), [signals, now]);
  const feedback = useForYou((s) => s.feedback);
  const shareNames = useForYou((s) => s.shareNames);
  const last = useForYou((s) => s.last);
  const done = useForYou((s) => s.done);
  // The list that is shown, explained, and sent: one list, three uses.
  const interests = useMemo(() => applyFeedback(profile, feedback, SEND_LIMIT), [profile, feedback]);
  const provider = useSettings((s) => s.ai.provider);
  const model = useSettings((s) => s.ai.model);

  const [choice, setChoice] = useState<ModelChoice>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [whyKey, setWhyKey] = useState<string | null>(null);
  const [privacyOpen, setPrivacyOpen] = useState(false);

  const list = useMemo(() => last?.list ?? [], [last]);

  const why = useMemo(() => {
    const s = whyKey ? list.find((x) => suggestionKey(x) === whyKey) : undefined;
    return s ? explainSuggestion(s, interests, signals, now) : null;
  }, [whyKey, list, interests, signals, now]);

  const outbound = useMemo(() => {
    if (!privacyOpen) return null;
    const allowed = allowedNow();
    const prompt = suggestionPrompt(interests, outboundAllowed(allowed, shareNames), MAX_SUGGESTIONS);
    return { m: manifest(interests, profile, feedback, allowed, shareNames, signals), prompt, bytes: utf8Bytes(prompt) };
  }, [privacyOpen, interests, profile, feedback, shareNames, signals]);

  const target = { appId: "foryou", windowId: win.id };
  const destination = choice.provider || choice.model
    ? [choice.provider, choice.model].filter(Boolean).join(" · ")
    : [provider, model].filter(Boolean).join(" · ");

  const suggest = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    const allowed = allowedNow();
    const sent = interests;
    // Built exactly as the privacy panel builds it.
    const prompt = suggestionPrompt(sent, outboundAllowed(allowed, useForYou.getState().shareNames), MAX_SUGGESTIONS);
    try {
      const res = await trackJob(
        { kind: "ai", title: "For You: finding suggestions", detail: `Sending ${plural(sent.length, "term")}`, target },
        async (report) => {
          const r = await ask({
            system: "You suggest desktop widgets and apps for one person. You return JSON only.",
            messages: [{ role: "user", content: prompt }],
            persona: false, maxTokens: 1500, temperature: 0.7, ...overrideOpts(choice),
          });
          report(0.95, "Checking the reply");
          return r;
        },
      );
      // Duplicate checks use the full local list, names included, whatever was sent.
      const r = parseSuggestions(res.text, allowed, MAX_SUGGESTIONS);
      const { kept, dropped } = dropDismissed(r.suggestions, useForYou.getState().feedback);
      useForYou.getState().setLast({ list: kept, rejected: [...r.rejected, ...dropped], offline: false });
      if (kept.length === 0) setError("The model's suggestions were all rejected as invalid, duplicates, or ones you said less to — see below.");
    } catch (e) {
      // Honest error, and still useful: the offline matcher needs no model.
      setError(e instanceof Error ? e.message : "The model call failed.");
      const { kept, dropped } = dropDismissed(offlineSuggestions(sent, allowed, OFFLINE_SUGGESTIONS), useForYou.getState().feedback);
      useForYou.getState().setLast({ list: kept, rejected: dropped, offline: true });
    } finally { setBusy(false); }
  };

  const act = async (s: Suggestion) => {
    const key = suggestionKey(s);
    const { markDone } = useForYou.getState();
    if (s.type === "app") {
      bus.emit("app:open", { appId: "studio", args: { tab: "build", prompt: s.prompt } });
      markDone(key);
      return;
    }
    if (s.type === "widget" && s.kind) {
      useSettings.getState().addWidget(s.kind, { config: s.config, ...(SIZE[s.kind] ?? {}) });
      bus.emit("notify", { title: `Added "${s.title}" to the desktop`, kind: "success" });
      markDone(key);
      return;
    }
    setWorking(key); setError(null);
    try {
      await trackJob({ kind: "ai", title: `For You: building ${s.title}`, detail: "Writing the widget", target }, async (report) => {
        const res = await ask({ system: WIDGET_SYSTEM, messages: [{ role: "user", content: s.prompt ?? s.title }], maxTokens: 8000, persona: false, ...overrideOpts(choice) });
        report(0.9, "Installing");
        const code = extractCode(res.text);
        if (!code) throw new Error(explainNoCode(res.text));
        const id = useCustomWidgets.getState().add({ name: s.title, prompt: s.prompt ?? s.title, html: code, icon: "widgets", w: 260, h: 170 });
        useSettings.getState().addWidget("custom", { customId: id, w: 260, h: 170 });
      });
      bus.emit("notify", { title: `Built "${s.title}"`, kind: "success" });
      markDone(key);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not build that widget.");
    } finally { setWorking(null); }
  };

  const rate = (s: Suggestion, dir: 1 | -1) => {
    const terms = matchTerms(s, interests);
    useForYou.getState().setFeedback((fb) => rateSuggestion(fb, suggestionKey(s), terms, dir));
    if (dir === -1 && whyKey === suggestionKey(s)) setWhyKey(null);
  };

  const askAios = (s: Suggestion) => {
    bus.emit("aios-chat:open");
    bus.emit("aios-chat:ask", { prompt: aiosHandoff(s) });
  };

  const mute = (term: string) => useForYou.getState().setFeedback((fb) => muteTerm(fb, term));

  return (
    <div className="h-full overflow-y-auto p-3">
      <ErrorNote error={error} onDismiss={() => setError(null)} />

      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="os-label !mb-0">What I think you are into</span>
        <button className="os-chip !py-0 !text-[10px]" onClick={() => setEpoch((e) => e + 1)}><Icon name="refresh" size={10} /> Refresh</button>
        <button className="os-chip !py-0 !text-[10px]" onClick={() => { clearActivity(); setEpoch((e) => e + 1); }}>Forget activity</button>
        <button className="os-chip !py-0 !text-[10px]" aria-expanded={privacyOpen} onClick={() => setPrivacyOpen((o) => !o)}>
          <Icon name="shield" size={10} /> What gets sent
        </button>
      </div>
      {interests.length === 0 ? (
        <Empty icon="sparkles" title="Nothing yet" body="Search, build, write and read around the OS for a while — suggestions get better the more there is to go on." />
      ) : (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {interests.map((i) => (
            <span key={i.term} className="os-chip inline-flex items-center gap-1 !pr-1 !text-[10.5px]" title={`from ${i.sources.join(", ")} · score ${fmt(i.score)}${i.votes ? ` (${fmt(i.base)} before your votes)` : ""}`}>
              {i.term}
              {i.votes !== 0 && <span className="text-[9px] text-[var(--muted)]">{i.votes > 0 ? `+${i.votes}` : i.votes}</span>}
              <button aria-label={`Stop using and sending "${i.term}"`} title="Stop using and sending this term" className="grid h-3.5 w-3.5 place-items-center rounded-full opacity-60 hover:opacity-100" onClick={() => mute(i.term)}>
                <Icon name="close" size={8} />
              </button>
            </span>
          ))}
        </div>
      )}
      <p className="mb-3 text-[10.5px] text-[var(--muted)]">
        Built from your activity and kept in this browser. When you press Suggest, these terms are all that is sent from your activity{shareNames ? ", with the names of your own widgets and apps" : ""}. What gets sent shows the whole request.
        {feedback.muted.length > 0 && ` ${plural(feedback.muted.length, "term")} muted by you.`}
      </p>

      {privacyOpen && outbound && (
        <section className="os-card mb-3 !p-2.5 text-[11px]" aria-label="What gets sent">
          <div className="os-label">If you press Suggest, exactly this leaves the browser</div>
          <p className="mb-1.5 text-[var(--muted)]">{outbound.m.terms.length ? `These ${plural(outbound.m.terms.length, "term")} and their scores, marked as data:` : "No terms: the model gets nothing about you."}</p>
          {outbound.m.terms.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1">
              {outbound.m.terms.map((t) => (
                <span key={t.term} className="os-chip inline-flex items-center gap-1 !pr-1 !text-[10.5px]">
                  {t.term} <span className="text-[9px] text-[var(--muted)]">{t.score}</span>
                  <button aria-label={`Do not send "${t.term}"`} title="Do not send this term" className="grid h-3.5 w-3.5 place-items-center rounded-full opacity-60 hover:opacity-100" onClick={() => mute(t.term)}>
                    <Icon name="close" size={8} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <Toggle
            label="Also send the names of my own widgets and apps"
            hint={shareNames
              ? `Sent so the model does not suggest them again: ${[...outbound.m.names.customWidgets, ...outbound.m.names.apps].join(", ") || "you have none yet"}.`
              : `Off: ${plural(outbound.m.withheldNames, "name")} stay here. Duplicates are still caught on this device.`}
            checked={shareNames}
            onChange={(v) => useForYou.getState().setShareNames(v)}
          />
          <p className="mb-1 text-[var(--muted)]">
            Also sent, the same for everyone: the instructions, this OS&apos;s catalogue ({outbound.m.catalogue.widgetKinds} widget kinds, {outbound.m.catalogue.services} data services, {outbound.m.catalogue.newsSources} news feeds), and the kinds of built-in widget already on your desktop ({outbound.m.widgetKindsOnDesktop.length ? [...new Set(outbound.m.widgetKindsOnDesktop)].join(", ") : "none"}).
          </p>
          <p className="mb-1.5">In total {outbound.bytes.toLocaleString()} bytes, to {destination || "the model in the top bar"}.</p>
          <details className="mb-2">
            <summary className="cursor-pointer text-[var(--muted)]">Show the exact text</summary>
            <pre className="my-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-[color-mix(in_srgb,var(--muted)_10%,transparent)] p-1.5 text-[10px]">{outbound.prompt}</pre>
            <CopyButton text={outbound.prompt} />
          </details>
          <p className="mb-1.5 text-[var(--muted)]">
            Never sent: your {plural(outbound.m.local.total, "signal")}
            {outbound.m.local.total > 0 && ` (${(Object.entries(outbound.m.local.bySource) as Array<[SignalSource, number]>).map(([src, n]) => `${n} ${SOURCE_LABEL[src]}`).join(", ")})`}
            , their dates, and every explanation under a suggestion. Ask AIOS hands only that suggestion&apos;s text to AIOS Chat, which then works as it always does.
          </p>
          {feedback.muted.length > 0 && (
            <div className="mb-1.5">
              <div className="mb-1 text-[var(--muted)]">
                Muted by you{outbound.m.heldBack.length ? ` (holding back ${plural(outbound.m.heldBack.length, "term")} from your profile right now)` : ""}:
              </div>
              <div className="flex flex-wrap gap-1">
                {feedback.muted.map((m) => (
                  <button key={m} className="os-chip !text-[10.5px]" title="Use and send this term again" onClick={() => useForYou.getState().setFeedback((fb) => unmuteTerm(fb, m))}>
                    <Icon name="eye" size={10} /> Unmute {m}
                  </button>
                ))}
              </div>
            </div>
          )}
          <button
            className="os-btn !py-1 text-[11px]"
            disabled={feedback.muted.length === 0 && Object.keys(feedback.votes).length === 0 && Object.keys(feedback.rated).length === 0}
            onClick={() => useForYou.getState().resetFeedback()}
          >
            Reset More / Less and mutes
          </button>
        </section>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button className="os-btn" data-variant="primary" disabled={busy} onClick={() => void suggest()}>
          <Icon name="sparkles" size={13} /> {busy ? "Thinking…" : "Suggest for me"}
        </button>
        <ModelOverride id="foryou" value={choice} onChange={setChoice} />
        {busy && <Spinner />}
      </div>

      {last && (
        <div className="mb-2 flex flex-wrap items-center gap-2 text-[10.5px] text-[var(--muted)]">
          <span>
            {plural(list.length, "suggestion")} from {last.offline ? "the offline matcher" : "the model"}, {agoLabel(now - last.at)}.
          </span>
          <button className="os-chip !py-0 !text-[10px]" onClick={() => { useForYou.getState().setLast(null); setWhyKey(null); }}>Clear</button>
        </div>
      )}
      {last?.offline && list.length > 0 && <p className="mb-2 text-[10.5px] text-[var(--muted)]">No model answered, so these come from matching your interests against the free services and news feeds.</p>}

      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(240px, 100%), 1fr))" }}>
        {list.map((s) => {
          const key = suggestionKey(s);
          const rating = feedback.rated[key];
          if (isDismissed(feedback, s)) {
            return (
              <div key={key} className="os-card flex items-center gap-2 !p-2 text-[11px] text-[var(--muted)]">
                <span className="min-w-0 flex-1 truncate">Hidden: {s.title}{rating?.terms.length ? ` (less of ${rating.terms.join(", ")})` : ""}</span>
                <button className="os-chip !py-0 !text-[10px]" onClick={() => rate(s, -1)}>Undo</button>
              </div>
            );
          }
          const isDone = done.includes(key);
          const open = whyKey === key && why;
          return (
            <div key={key} className="os-card !p-2.5">
              <div className="mb-1 flex items-center gap-1.5">
                <span className="os-chip !px-1.5 !py-0 !text-[9px]">{s.type === "widget" ? `${s.kind} widget` : s.type === "custom-widget" ? "new widget" : "app"}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium" title={s.title}>{s.title}</span>
              </div>
              <p className="mb-2 text-[11px] leading-snug text-[var(--muted)]">{s.why}</p>
              <div className="mb-1.5 flex flex-wrap gap-1">
                <button className="os-btn !py-1 text-[11px]" data-variant="primary" disabled={working !== null || isDone} onClick={() => void act(s)}>
                  {isDone ? "Added" : working === key ? "Building…" : s.type === "app" ? "Build in AI Studio" : s.type === "custom-widget" ? "Build it" : "Add to desktop"}
                </button>
                <button className="os-btn !py-1 text-[11px]" title="Opens AIOS Chat with this suggestion's text, which it sends to your model" onClick={() => askAios(s)}>
                  <Icon name="chat" size={11} /> Ask AIOS
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-1">
                <button className="os-chip !py-0 !text-[10px]" aria-pressed={rating?.dir === 1} style={rating?.dir === 1 ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined} onClick={() => rate(s, 1)}>
                  <Icon name="plus" size={10} /> More like this
                </button>
                <button className="os-chip !py-0 !text-[10px]" onClick={() => rate(s, -1)}>
                  <Icon name="ban" size={10} /> Less like this
                </button>
                <button className="os-chip !py-0 !text-[10px]" aria-expanded={!!open} onClick={() => setWhyKey(whyKey === key ? null : key)}>
                  <Icon name="info" size={10} /> Why this?
                </button>
              </div>
              {rating?.dir === 1 && (
                <p className="mt-1 text-[10px] text-[var(--muted)]">
                  {rating.terms.length ? `Lifted: ${rating.terms.join(", ")}.` : "Noted, but it names none of your terms, so nothing was re-weighted."}
                </p>
              )}
              {open && (
                <div className="mt-2 border-t border-[var(--border)] pt-1.5 text-[10.5px]">
                  {open.terms.length === 0 ? (
                    <p className="text-[var(--muted)]">
                      None of your current terms appear in it. {last?.offline ? "It was matched on a term that has since moved out of your top list." : "The model chose it from your whole list; its reason is above."}
                    </p>
                  ) : (
                    open.terms.map((t) => {
                      const ex = t.explanation;
                      const restParts = [
                        ex.restSignals > 0 ? plural(ex.restSignals, "other signal") : "",
                        ex.unscanned > 0 ? `up to ${plural(ex.unscanned, "older signal")} not examined one by one` : "",
                      ].filter(Boolean);
                      return (
                        <div key={t.term} className="mb-1.5">
                          <div>
                            <b>{t.term}</b> is #{t.rank} of {interests.length}, score {fmt(t.score)}
                            {t.votes !== 0 && ` (${fmt(t.base)} × ${t.factor.toFixed(2)} for your ${t.votes > 0 ? "+" : ""}${t.votes})`}
                          </div>
                          <ul className="ml-1 mt-0.5 space-y-0.5 text-[var(--muted)]">
                            {ex.evidence.map((e, i) => (
                              <li key={i} className="flex min-w-0 gap-1.5">
                                <span className="shrink-0 tabular-nums">+{fmt(e.contribution)}{ex.base > 0 ? ` (${Math.round((e.contribution / ex.base) * 100)}%)` : ""}</span>
                                <span className="min-w-0 flex-1 truncate" title={e.snippet}>{SOURCE_LABEL[e.source]}, {e.ageDays === 0 ? "today" : `${e.ageDays}d ago`}: {e.snippet}</span>
                              </li>
                            ))}
                            {ex.rest > 0 && <li>+{fmt(ex.rest)} from {restParts.join(" and ") || "other signals"}</li>}
                          </ul>
                        </div>
                      );
                    })
                  )}
                  {open.moreTerms.length > 0 && <p className="text-[var(--muted)]">Also names: {open.moreTerms.join(", ")}.</p>}
                  <p className="mt-1 text-[10px] text-[var(--muted)]">Worked out in this browser from your own activity. None of it is sent.</p>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {last && last.rejected.length > 0 && (
        <details className="mt-3 text-[10.5px] text-[var(--muted)]">
          <summary className="cursor-pointer">{last.rejected.length} suggestion(s) rejected</summary>
          {last.rejected.map((r, i) => <p key={i}>· {r.title}: {r.reason}</p>)}
        </details>
      )}
    </div>
  );
}
