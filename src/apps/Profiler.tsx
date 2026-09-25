"use client";

import { useCallback, useRef, useState } from "react";
import { useVFS } from "@/kernel/vfs";
import { bus } from "@/kernel/bus";
import { ask } from "@/lib/useAI";
import type { AppProps } from "@/kernel/types";
import { download } from "@/lib/format";
import { Markdown, CopyButton, ErrorNote, Empty, Spinner } from "./_ui";
import { cn } from "@/lib/cn";
import { Icon } from "@/shell/icons";

/* ────────────────────────────────────────────────────────────────────────────
   Profiler — ported from ai-social-media-profiler.

   The original ran a three-stage analysis over material a user pasted in. That
   staging is kept, and so is the constraint that made it defensible: the model
   analyses only the text you provide, it never goes looking for a person, and
   every inference is labelled as an inference. A tool that quietly blurs the
   line between "this is what the text says" and "this is what I assume about
   you" is the version worth not building.
   ──────────────────────────────────────────────────────────────────────────── */

const STAGES = [
  {
    id: "signals", name: "Signals", icon: "play",
    prompt: `Extract the observable signals from this material. Cover: topics raised, vocabulary and register, stated positions, recurring references, posting rhythm if visible, and tone.

Report only what the text actually contains. Quote the specific line behind each signal. Where the material is thin, say so rather than padding.`,
  },
  {
    id: "profile", name: "Profile", icon: "vault",
    prompt: `From the signals, build a profile of the author as a communicator: what they care about, how they argue, who they seem to be writing for, and what they avoid.

Mark every line as either [OBSERVED] — directly supported by the text — or [INFERRED] — your reading of it. Do not merge the two. An inference stated as an observation is the failure mode of this entire exercise.`,
  },
  {
    id: "brief", name: "Brief", icon: "report",
    prompt: `Write a short brief: how to communicate effectively with this person, what would land, what would not, and what you still do not know.

End with "Confidence and limits": what the sample was too small to support. Be honest about it — a profile built on four posts is a guess wearing a suit.`,
  },
];

export default function Profiler({}: AppProps) {
  const vfs = useVFS();
  const [material, setMaterial] = useState("");
  const [context, setContext] = useState("");
  const [results, setResults] = useState<Record<string, string>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<string>("signals");
  const abortRef = useRef<AbortController | null>(null);

  /** Run the stages from `from` onward. Earlier stages keep their results and
   *  feed the first one run, so a weak brief can be redone without paying for
   *  the signals again. */
  const runFrom = useCallback(async (from = 0) => {
    if (!material.trim() || running) return;
    setError(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setResults((r) => Object.fromEntries(STAGES.slice(0, from).filter((st) => r[st.id]).map((st) => [st.id, r[st.id]])));
    let carried = from > 0 ? results[STAGES[from - 1].id] ?? "" : "";
    for (const stage of STAGES.slice(from)) {
      setRunning(stage.id);
      setView(stage.id);
      try {
        const res = await ask({
          signal: ctrl.signal,
          messages: [{
            role: "user",
            content: `${context ? `Context provided by the user: ${context}\n\n` : ""}${carried ? `Previous stage output:\n${carried}\n\n---\n\n` : ""}Material:\n\n${material.slice(0, 60_000)}`,
          }],
          system: `${stage.prompt}\n\nYou analyse only the material provided. You do not search for anyone, you do not speculate about identity, location, employer or anything else the text does not state. If asked to do so, decline and explain why.`,
          maxTokens: 2200,
          onDelta: (_d, full) => setResults((r) => ({ ...r, [stage.id]: full })),
        });
        setResults((r) => ({ ...r, [stage.id]: res.text }));
        carried = res.text;
      } catch (e) {
        setError((e as Error).name === "AbortError" ? `Stopped during ${stage.name}. Finished stages are kept.` : e instanceof Error ? e.message : "Stage failed.");
        break;
      }
    }
    abortRef.current = null;
    setRunning(null);
  }, [material, context, running, results]);
  const runAll = useCallback(() => runFrom(0), [runFrom]);

  const words = material.split(/\s+/).filter(Boolean).length;
  const lines = material ? material.split("\n").filter((l) => l.trim()).length : 0;

  const report = useCallback(
    () => [`# Profile analysis`, "", `> ${new Date().toISOString()}`, "", ...STAGES.flatMap((s) => [`## ${s.name}`, "", results[s.id] ?? "_(not run)_", ""])].join("\n"),
    [results],
  );

  const done = Object.keys(results).length;

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-[var(--border)] p-2.5">
        <ErrorNote error={error} onDismiss={() => setError(null)} />
        <textarea
          value={material}
          onChange={(e) => setMaterial(e.target.value)}
          rows={4}
          placeholder="Paste the material to analyse — posts, messages, articles, transcripts…"
          className="os-input mb-1.5 resize-none text-[12px]"
        />
        <input
          value={context}
          onChange={(e) => setContext(e.target.value)}
          placeholder="Optional context: what are you trying to work out?"
          className="os-input mb-2 !py-1 text-[12px]"
        />
        <div className="flex flex-wrap items-center gap-1.5">
          <button className="os-btn !py-1 text-[11px]" data-variant="primary" onClick={runAll} disabled={!!running || !material.trim()}>
            {running ? `Running ${running}…` : "Run analysis"}
          </button>
          {running && <Spinner />}
          {running && <button className="os-btn !py-1 text-[11px]" onClick={() => abortRef.current?.abort()}><Icon name="stop" size={11} className="mr-1" />Stop</button>}
          <span className="text-[10.5px] tabular-nums text-[var(--muted)]">{material.length.toLocaleString()} chars · {words.toLocaleString()} words · {lines.toLocaleString()} lines</span>
          {words > 0 && words < 150 && <span className="os-chip !py-0 !text-[10px]" title="Under 150 words, any profile is mostly guesswork">thin sample</span>}
          <div className="flex-1" />
          {done > 0 && (
            <>
              <CopyButton text={report()} label="Copy report" />
              <button className="os-btn !py-1 text-[11px]" onClick={() => { vfs.write(`/profiles/${Date.now()}.md`, report(), { appId: "profiler" }); bus.emit("notify", { title: "Saved to Files", kind: "success" }); }}>Save</button>
              <button className="os-btn !py-1 text-[11px]" onClick={() => download(`profile-${Date.now()}.md`, report(), "text/markdown")}>Export</button>
            </>
          )}
        </div>
      </div>

      <div className="flex shrink-0 gap-1 border-b border-[var(--border)] px-2 py-1.5">
        {STAGES.map((s) => (
          <button
            key={s.id}
            onClick={() => setView(s.id)}
            className={cn("os-btn !py-1 text-[11px]", view === s.id && "!border-[var(--accent)] !bg-[var(--accent)]/16")}
          >
            <Icon name={s.icon} size={11} className="mr-1 inline-block align-[-1px]" />{s.name}
            {results[s.id] && <Icon name="check" size={10} className="ml-1 inline-block align-[-1px] text-[var(--ok)]" />}
            {running === s.id && <span className="ml-1">…</span>}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {results[view] ? (
          <div className="mx-auto max-w-3xl">
            <Markdown text={results[view]} />
            {!running && (
              <button
                className="os-btn mt-3 !py-1 text-[11px]"
                onClick={() => void runFrom(STAGES.findIndex((st) => st.id === view))}
                disabled={STAGES.findIndex((st) => st.id === view) > 0 && !results[STAGES[STAGES.findIndex((st) => st.id === view) - 1].id]}
                title="Run this stage again, and every stage after it, from the stages before it"
              >
                <Icon name="refresh" size={11} className="mr-1" />Re-run from {STAGES.find((st) => st.id === view)?.name}
              </button>
            )}
          </div>
        ) : (
          <Empty
            icon="profiler"
            title="Nothing analysed yet"
            body="Paste material above and run. The three stages build on each other: observable signals first, then a profile that labels every line as observed or inferred, then a brief that states its own limits."
          />
        )}
      </div>

      <div className="shrink-0 border-t border-[var(--border)] px-3 py-1.5 text-[10.5px] text-[var(--muted)]">
        Analyses only the text you paste. It does not search for anyone, and inferences are labelled as inferences rather than presented as fact.
      </div>
    </div>
  );
}
