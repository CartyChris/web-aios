"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { useSettings } from "@/kernel/settings";
import { useVFS } from "@/kernel/vfs";
import { bus } from "@/kernel/bus";
import { PROVIDERS, getProvider } from "@/lib/providers";
import { ask } from "@/lib/useAI";
import type { ChatMessage } from "@/lib/ai-transport";
import type { AppProps } from "@/kernel/types";
import { relTime, uid, download } from "@/lib/format";
import { Markdown, CopyButton, ErrorNote, Empty, Spinner } from "./_ui";
import { cn } from "@/lib/cn";
import { Icon } from "@/shell/icons";

/* ────────────────────────────────────────────────────────────────────────────
   Chat — the OS's primary AI surface.

   Ported from the chat halves of Astro-Atlas, GenAI-OS and the DeepSeek
   harnesses, consolidated into one threaded client that works against any of
   the twelve providers in the catalogue.
   ──────────────────────────────────────────────────────────────────────────── */

export interface Turn {
  id: string;
  role: "user" | "assistant";
  content: string;
  model?: string;
  ms?: number;
  costUsd?: number;
  ts: number;
  error?: boolean;
}

export interface Thread {
  id: string;
  title: string;
  turns: Turn[];
  personaId: string;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
}

export interface Persona {
  id: string;
  name: string;
  icon: string;
  prompt: string;
  builtin?: boolean;
}

export const PERSONAS: Persona[] = [
  { id: "default", name: "Assistant", icon: "spark", prompt: "You are the assistant inside Web-AIOS. Be direct, concrete and useful. Prefer short paragraphs and code blocks over long prose.", builtin: true },
  { id: "engineer", name: "Engineer", icon: "tune", prompt: "You are a senior software engineer. Give working code first, explanation second. Name the tradeoff you are making. Never invent an API that does not exist — say when you are unsure.", builtin: true },
  { id: "critic", name: "Critic", icon: "claim", prompt: "You are a skeptical reviewer. Find the strongest objection to what you are shown. Be specific about what would falsify the claim. Do not manufacture problems that are not there.", builtin: true },
  { id: "researcher", name: "Researcher", icon: "atlas", prompt: "You are a research analyst. Distinguish confirmed facts from inference, and say which is which. Flag anything you cannot verify rather than smoothing it over.", builtin: true },
  { id: "teacher", name: "Teacher", icon: "notes", prompt: "You explain things by building the reader's intuition first, then the formalism. Use one concrete example before any abstraction.", builtin: true },
  { id: "terse", name: "Terse", icon: "app", prompt: "Answer in as few words as the question honestly allows. No preamble, no summary, no offers of further help.", builtin: true },
];

interface ChatState {
  threads: Thread[];
  activeId: string | null;
  personas: Persona[];
  newThread: (personaId?: string) => string;
  removeThread: (id: string) => void;
  setActive: (id: string) => void;
  addTurn: (threadId: string, turn: Turn) => void;
  updateTurn: (threadId: string, turnId: string, patch: Partial<Turn>) => void;
  renameThread: (id: string, title: string) => void;
  pinThread: (id: string) => void;
  setPersona: (threadId: string, personaId: string) => void;
  addPersona: (p: Omit<Persona, "id">) => void;
  removePersona: (id: string) => void;
  clearAll: () => void;
}

export const useChat = create<ChatState>()(
  persist(
    (set) => ({
      threads: [],
      activeId: null,
      personas: [],

      newThread: (personaId = "default") => {
        const id = uid("t");
        const thread: Thread = { id, title: "New chat", turns: [], personaId, createdAt: Date.now(), updatedAt: Date.now() };
        set((s) => ({ threads: [thread, ...s.threads], activeId: id }));
        return id;
      },

      removeThread: (id) =>
        set((s) => {
          const threads = s.threads.filter((t) => t.id !== id);
          return { threads, activeId: s.activeId === id ? threads[0]?.id ?? null : s.activeId };
        }),

      setActive: (id) => set({ activeId: id }),

      addTurn: (threadId, turn) =>
        set((s) => ({
          threads: s.threads.map((t) => {
            if (t.id !== threadId) return t;
            // The first user message names the thread, so the sidebar is
            // readable without anyone having to title anything by hand.
            const title = t.turns.length === 0 && turn.role === "user" ? turn.content.slice(0, 52).replace(/\s+/g, " ").trim() || "New chat" : t.title;
            return { ...t, title, turns: [...t.turns, turn], updatedAt: Date.now() };
          }),
        })),

      updateTurn: (threadId, turnId, patch) =>
        set((s) => ({
          threads: s.threads.map((t) =>
            t.id === threadId ? { ...t, turns: t.turns.map((x) => (x.id === turnId ? { ...x, ...patch } : x)), updatedAt: Date.now() } : t,
          ),
        })),

      renameThread: (id, title) => set((s) => ({ threads: s.threads.map((t) => (t.id === id ? { ...t, title } : t)) })),
      pinThread: (id) => set((s) => ({ threads: s.threads.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t)) })),
      setPersona: (threadId, personaId) => set((s) => ({ threads: s.threads.map((t) => (t.id === threadId ? { ...t, personaId } : t)) })),
      addPersona: (p) => set((s) => ({ personas: [...s.personas, { ...p, id: uid("p") }] })),
      removePersona: (id) => set((s) => ({ personas: s.personas.filter((p) => p.id !== id) })),
      clearAll: () => set({ threads: [], activeId: null }),
    }),
    { name: "webaios.chat.v1", storage: createJSONStorage(() => localStorage) },
  ),
);

export default function Chat({ args }: AppProps) {
  const chat = useChat();
  const settings = useSettings();
  const vfs = useVFS();
  const [input, setInput] = useState(() => (typeof args?.prompt === "string" ? args.prompt : ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSidebar, setShowSidebar] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [streamText, setStreamText] = useState("");

  const allPersonas = useMemo(() => [...PERSONAS, ...chat.personas], [chat.personas]);
  const thread = chat.threads.find((t) => t.id === chat.activeId) ?? null;

  // A thread must always exist, otherwise the composer has nowhere to write.
  useEffect(() => {
    if (!chat.activeId || !chat.threads.some((t) => t.id === chat.activeId)) {
      if (chat.threads.length) chat.setActive(chat.threads[0].id);
      else chat.newThread();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.threads.length, chat.activeId]);

  // A launch payload (from the palette, Terminal or another app) seeds the
  // composer. The initial value is set lazily above; this only re-seeds when a
  // *new* payload arrives at an already-open window.
  const seed = typeof args?.prompt === "string" ? args.prompt : undefined;
  const [seededPrompt, setSeededPrompt] = useState<string | undefined>(seed);
  if (seed !== undefined && seed !== seededPrompt) {
    setSeededPrompt(seed);
    setInput(seed);
  }
  useEffect(() => {
    if (seed) {
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [seed]);

  const atBottom = useRef(true);
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  useEffect(() => {
    // Only autoscroll when the user is already at the bottom — yanking the view
    // away while they are reading history is the classic chat-UI sin.
    if (atBottom.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [thread?.turns.length, streamText]);

  const send = useCallback(
    async (override?: string) => {
      const text = (override ?? input).trim();
      if (!text || busy || !thread) return;
      setError(null);
      setInput("");
      setBusy(true);
      setStreamText("");

      const userTurn: Turn = { id: uid("u"), role: "user", content: text, ts: Date.now() };
      chat.addTurn(thread.id, userTurn);

      const assistantId = uid("a");
      const persona = allPersonas.find((p) => p.id === thread.personaId) ?? PERSONAS[0];
      const history: ChatMessage[] = [...thread.turns, userTurn]
        .filter((t) => !t.error)
        .map((t) => ({ role: t.role, content: t.content }));

      const ctrl = new AbortController();
      abortRef.current = ctrl;

      try {
        const res = await ask({
          messages: history,
          system: persona.prompt,
          signal: ctrl.signal,
          onDelta: (_d, full) => setStreamText(full),
        });
        chat.addTurn(thread.id, {
          id: assistantId, role: "assistant", content: res.text,
          model: settings.ai.model, ms: res.ms, costUsd: res.costUsd, ts: Date.now(),
        });
      } catch (e) {
        if ((e as Error).name === "AbortError") {
          // Keep whatever streamed before the cancel; throwing it away loses work.
          if (streamText) {
            chat.addTurn(thread.id, { id: assistantId, role: "assistant", content: streamText + "\n\n_(stopped)_", model: settings.ai.model, ts: Date.now() });
          }
        } else {
          const msg = e instanceof Error ? e.message : "Request failed.";
          setError(msg);
          chat.addTurn(thread.id, { id: assistantId, role: "assistant", content: msg, ts: Date.now(), error: true });
        }
      } finally {
        setStreamText("");
        setBusy(false);
        abortRef.current = null;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [input, busy, thread, allPersonas, settings.ai.model, streamText],
  );

  const saveToFiles = useCallback(() => {
    if (!thread) return;
    const md = threadToMarkdown(thread, allPersonas);
    const path = `/chats/${thread.title.replace(/[^\w\s-]/g, "").slice(0, 40) || "chat"}-${thread.id}.md`;
    vfs.write(path, md, { appId: "chat" });
    bus.emit("notify", { title: "Saved to Files", body: path, kind: "success" });
  }, [thread, allPersonas, vfs]);

  const provider = getProvider(settings.ai.provider);
  const sorted = useMemo(
    () => [...chat.threads].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt),
    [chat.threads],
  );

  return (
    <div className="app-split flex h-full">
      {showSidebar && (
        <div className="app-sidebar flex w-52 shrink-0 flex-col overflow-y-auto border-r border-[var(--border)]">
          <div className="flex gap-1.5 p-2">
            <button className="os-btn flex-1 !py-1 text-[11px]" data-variant="primary" onClick={() => chat.newThread(thread?.personaId)}>
              + New chat
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
            {sorted.map((t) => (
              <div
                key={t.id}
                onClick={() => chat.setActive(t.id)}
                className={cn(
                  "group mb-1 cursor-pointer rounded-[calc(var(--radius)*0.6)] px-2 py-1.5",
                  t.id === chat.activeId ? "bg-[var(--accent)]/16 ring-1 ring-[var(--accent)]/40" : "hover:bg-white/6",
                )}
              >
                <div className="flex items-center gap-1">
                  {t.pinned && <Icon name="pin" size={9} className="shrink-0 text-[var(--accent)]" />}
                  <span className="min-w-0 flex-1 truncate text-[12px]">{t.title}</span>
                  <button
                    className="shrink-0 text-[10px] opacity-0 transition group-hover:opacity-60 hover:!opacity-100"
                    title="Pin"
                    aria-label="Pin thread"
                    onClick={(e) => { e.stopPropagation(); chat.pinThread(t.id); }}
                  >
                    <Icon name="pin" size={10} />
                  </button>
                  <button
                    className="shrink-0 text-[10px] opacity-0 transition group-hover:opacity-60 hover:!opacity-100"
                    title="Delete thread"
                    aria-label="Delete thread"
                    onClick={(e) => { e.stopPropagation(); chat.removeThread(t.id); }}
                  >
                    <Icon name="close" size={10} />
                  </button>
                </div>
                <div className="text-[10px] text-[var(--muted)]">{t.turns.length} msg · {relTime(t.updatedAt)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Toolbar */}
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border)] px-2.5 py-1.5">
          <button className="os-btn !px-2 !py-1 text-[11px]" onClick={() => setShowSidebar((v) => !v)} title="Toggle thread list">
            <Icon name="menu" size={13} />
          </button>

          <select
            className="os-input !w-auto !py-1 text-[11px]"
            value={settings.ai.provider}
            onChange={(e) => {
              const p = getProvider(e.target.value);
              settings.setAI("provider", e.target.value);
              if (p?.models[0]) settings.setAI("model", p.models[0]);
            }}
          >
            {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>

          <input
            className="os-input !w-44 !py-1 text-[11px]"
            list="chat-models"
            value={settings.ai.model}
            onChange={(e) => settings.setAI("model", e.target.value)}
            placeholder="model id"
            title="Any model id the provider accepts"
          />
          <datalist id="chat-models">
            {(provider?.models ?? []).map((m) => <option key={m} value={m} />)}
          </datalist>

          <select
            className="os-input !w-auto !py-1 text-[11px]"
            value={thread?.personaId ?? "default"}
            onChange={(e) => thread && chat.setPersona(thread.id, e.target.value)}
            title="Persona (system prompt)"
          >
            {allPersonas.map((p) => <option key={p.id} value={p.id}>{p.icon} {p.name}</option>)}
          </select>

          <div className="flex-1" />
          {thread && thread.turns.length > 0 && (
            <>
              <button className="os-btn !py-1 text-[11px]" onClick={saveToFiles}>Save to Files</button>
              <button
                className="os-btn !py-1 text-[11px]"
                onClick={() => download(`${thread.title || "chat"}.md`, threadToMarkdown(thread, allPersonas), "text/markdown")}
              >
                Export
              </button>
            </>
          )}
        </div>

        {/* Transcript */}
        <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {(!thread || thread.turns.length === 0) && !streamText && (
            <Empty
              icon="spark"
              title="Ask anything"
              body={`Talking to ${provider?.name ?? settings.ai.provider} · ${settings.ai.model}. Change provider, model or persona in the bar above. Keys live in Settings and never leave this browser except to the provider you pick.`}
              action={
                <div className="flex flex-wrap justify-center gap-1.5">
                  {["Explain this codebase's architecture", "Draft a release checklist", "What would break this design?"].map((s) => (
                    <button key={s} className="os-btn !py-1 text-[11px]" onClick={() => send(s)}>{s}</button>
                  ))}
                </div>
              }
            />
          )}

          {thread?.turns.map((turn) => (
            <TurnView key={turn.id} turn={turn} onRetry={turn.role === "user" ? () => send(turn.content) : undefined} />
          ))}

          {streamText && (
            <TurnView turn={{ id: "streaming", role: "assistant", content: streamText, ts: 0 }} streaming />
          )}
          {busy && !streamText && <div className="py-3"><Spinner label="Thinking…" /></div>}
        </div>

        {/* Composer */}
        <div className="shrink-0 border-t border-[var(--border)] p-2.5">
          <ErrorNote error={error} onDismiss={() => setError(null)} />
          <div className="flex items-end gap-1.5">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
              }}
              rows={1}
              placeholder="Message… (Enter to send, Shift+Enter for a new line)"
              className="os-input max-h-44 flex-1 resize-none"
              style={{ height: "auto" }}
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = `${Math.min(el.scrollHeight, 176)}px`;
              }}
            />
            {busy ? (
              <button className="os-btn !py-2" onClick={() => abortRef.current?.abort()} title="Stop generating"><Icon name="stop" size={12} className="mr-1 inline-block align-[-1px]" />Stop</button>
            ) : (
              <button className="os-btn !py-2" data-variant="primary" onClick={() => send()} disabled={!input.trim()}>Send</button>
            )}
          </div>
          <div className="mt-1 flex items-center gap-2 text-[10px] text-[var(--muted)]">
            <span>Budget ${settings.ai.spentUsd.toFixed(4)} / ${settings.ai.budgetUsd.toFixed(2)}</span>
            <span>·</span>
            <span>Cost figures are estimates</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function TurnView({ turn, streaming, onRetry }: { turn: Turn; streaming?: boolean; onRetry?: () => void }) {
  const isUser = turn.role === "user";
  return (
    <div className={cn("group mb-4 flex gap-2.5", isUser && "flex-row-reverse")}>
      <div
        className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-[12px]"
        style={{
          background: isUser ? "color-mix(in srgb, var(--accent2) 30%, transparent)" : "color-mix(in srgb, var(--accent) 24%, transparent)",
          border: "1px solid var(--border)",
        }}
      >
        {isUser ? "You" : <Icon name="spark" size={14} />}
      </div>
      <div className={cn("min-w-0 max-w-[min(78ch,88%)]", isUser && "text-right")}>
        <div
          className={cn(
            "inline-block max-w-full rounded-[calc(var(--radius)*0.85)] px-3 py-2 text-left",
            isUser ? "bg-[var(--accent2)]/16" : turn.error ? "border border-[var(--danger)] bg-[var(--danger)]/10" : "bg-white/[0.045]",
          )}
        >
          {isUser ? (
            <div className="whitespace-pre-wrap text-[13px] leading-relaxed">{turn.content}</div>
          ) : (
            <Markdown text={turn.content} />
          )}
          {streaming && <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 bg-[var(--accent)]" style={{ animation: "os-pulse 1s ease-in-out infinite" }} />}
        </div>
        <div className={cn("mt-1 flex items-center gap-2 text-[10px] text-[var(--muted)] opacity-0 transition group-hover:opacity-100", isUser && "justify-end")}>
          {turn.model && <span>{turn.model}</span>}
          {turn.ms !== undefined && <span>{(turn.ms / 1000).toFixed(1)}s</span>}
          {turn.costUsd !== undefined && turn.costUsd > 0 && <span>~${turn.costUsd.toFixed(4)}</span>}
          <CopyButton text={turn.content} label="Copy" className="!px-1.5 !py-0 !text-[10px]" />
          {onRetry && <button className="os-btn !px-1.5 !py-0 !text-[10px]" onClick={onRetry}>Resend</button>}
        </div>
      </div>
    </div>
  );
}

function threadToMarkdown(thread: Thread, personas: Persona[]): string {
  const persona = personas.find((p) => p.id === thread.personaId);
  const head = [
    `# ${thread.title}`,
    "",
    `> Persona: ${persona?.name ?? thread.personaId}`,
    `> Exported: ${new Date().toISOString()}`,
    "",
    "---",
    "",
  ];
  const body = thread.turns.map((t) => `**${t.role === "user" ? "You" : "Assistant"}**${t.model ? ` _(${t.model})_` : ""}\n\n${t.content}\n`);
  return [...head, ...body].join("\n");
}
