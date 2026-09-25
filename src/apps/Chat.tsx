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
import { registerContextTarget } from "@/kernel/ctxmenu";
import type { MenuItem } from "@/lib/ctxmenu";
import {
  cutForRegenerate, cutForEdit, branchTurns, branchTitle, withAttachments, searchThreads, threadMarkdown, ATTACH_MAX_CHARS,
} from "@/lib/chat-thread";

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
  /** Streamed thinking from a reasoning model, shown collapsed. */
  reasoning?: string;
  /** Files attached as context (shown as chips). */
  attachments?: Array<{ path: string; chars: number }>;
  /** What the model actually received for this user turn, when it differs
   *  from `content` (attached files are fenced in ahead of the text). */
  sent?: string;
}

export interface Thread {
  id: string;
  title: string;
  turns: Turn[];
  personaId: string;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
  /** Per-thread model override. Unset means "use the OS model". */
  provider?: string;
  model?: string;
  /** The thread this one was branched from, for the sidebar. */
  parentId?: string;
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
  setTurns: (threadId: string, turns: Turn[]) => void;
  branchFrom: (threadId: string, turnId: string) => string | null;
  setThreadModel: (threadId: string, provider?: string, model?: string) => void;
}

export const useChat = create<ChatState>()(
  persist(
    (set, get) => ({
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

      setTurns: (threadId, turns) =>
        set((s) => ({ threads: s.threads.map((t) => (t.id === threadId ? { ...t, turns, updatedAt: Date.now() } : t)) })),

      branchFrom: (threadId, turnId) => {
        const src = get().threads.find((t) => t.id === threadId);
        const turns = src ? branchTurns(src.turns, turnId) : null;
        if (!src || !turns) return null;
        const id = uid("t");
        const thread: Thread = {
          id, title: branchTitle(src.title), turns: turns.map((t) => ({ ...t })), personaId: src.personaId,
          createdAt: Date.now(), updatedAt: Date.now(), provider: src.provider, model: src.model, parentId: src.id,
        };
        set((s) => ({ threads: [thread, ...s.threads], activeId: id }));
        return id;
      },

      setThreadModel: (threadId, provider, model) =>
        set((s) => ({ threads: s.threads.map((t) => (t.id === threadId ? { ...t, provider, model } : t)) })),
    }),
    { name: "webaios.chat.v1", storage: createJSONStorage(() => localStorage) },
  ),
);

const MAX_ATTACH = 5;

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
  const rootRef = useRef<HTMLDivElement>(null);
  const [streamText, setStreamText] = useState("");
  const [streamReasoning, setStreamReasoning] = useState("");
  // What has streamed so far, readable from the catch block of the SAME call
  // (state captured by the closure would be the value from when send began).
  const streamRef = useRef({ text: "", reasoning: "" });
  const [search, setSearch] = useState("");
  const [attached, setAttached] = useState<string[]>([]);
  const [picker, setPicker] = useState<{ open: boolean; q: string }>({ open: false, q: "" });
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);

  const allPersonas = useMemo(() => [...PERSONAS, ...chat.personas], [chat.personas]);
  const thread = chat.threads.find((t) => t.id === chat.activeId) ?? null;
  const override = Boolean(thread?.model);
  const effProvider = thread?.provider ?? settings.ai.provider;
  const effModel = thread?.model ?? settings.ai.model;

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
  }, [thread?.turns.length, streamText, streamReasoning]);

  /**
   * Ask the model to answer the LAST user turn in `turns`, which is already
   * what the thread holds. Shared by send, regenerate and edit-and-resend.
   */
  const generate = useCallback(async (threadId: string, turns: Turn[], personaId: string, provider: string | undefined, model: string | undefined) => {
    setError(null);
    setBusy(true);
    setStreamText("");
    setStreamReasoning("");
    streamRef.current = { text: "", reasoning: "" };
    const assistantId = uid("a");
    const persona = allPersonas.find((p) => p.id === personaId) ?? PERSONAS[0];
    const history: ChatMessage[] = turns.filter((t) => !t.error).map((t) => ({ role: t.role, content: t.sent ?? t.content }));
    const usedModel = model ?? useSettings.getState().ai.model;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await ask({
        messages: history,
        system: persona.prompt,
        signal: ctrl.signal,
        ...(model ? { model, provider } : {}),
        onDelta: (_d, full) => { streamRef.current.text = full; setStreamText(full); },
        onReasoning: (_d, full) => { streamRef.current.reasoning = full; setStreamReasoning(full); },
      });
      chat.addTurn(threadId, {
        id: assistantId, role: "assistant", content: res.text, reasoning: res.reasoning || streamRef.current.reasoning || undefined,
        model: usedModel, ms: res.ms, costUsd: res.costUsd, ts: Date.now(),
      });
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        // Keep whatever streamed before the cancel; throwing it away loses work.
        const partial = streamRef.current;
        if (partial.text || partial.reasoning) {
          chat.addTurn(threadId, { id: assistantId, role: "assistant", content: `${partial.text}\n\n_(stopped)_`, reasoning: partial.reasoning || undefined, model: usedModel, ts: Date.now() });
        }
      } else {
        const msg = e instanceof Error ? e.message : "Request failed.";
        setError(msg);
        chat.addTurn(threadId, { id: assistantId, role: "assistant", content: msg, ts: Date.now(), error: true });
      }
    } finally {
      setStreamText("");
      setStreamReasoning("");
      setBusy(false);
      abortRef.current = null;
    }
  }, [allPersonas, chat]);

  const send = useCallback(async (override?: string) => {
    const text = (override ?? input).trim();
    if (!text || busy || !thread) return;
    // Attached files are read at send time, so the model sees the file as it is now.
    const files = attached
      .map((path) => ({ path, node: vfs.read(path) }))
      .filter((f) => f.node && f.node.kind === "file")
      .map((f) => ({ path: f.path, content: f.node!.content }));
    const userTurn: Turn = {
      id: uid("u"), role: "user", content: text, ts: Date.now(),
      ...(files.length ? {
        attachments: files.map((f) => ({ path: f.path, chars: f.content.length })),
        sent: withAttachments(text, files, ATTACH_MAX_CHARS),
      } : {}),
    };
    setInput("");
    setAttached([]);
    chat.addTurn(thread.id, userTurn);
    await generate(thread.id, [...thread.turns, userTurn], thread.personaId, thread.provider, thread.model);
  }, [input, busy, thread, attached, vfs, chat, generate]);

  const regenerate = useCallback((turnId: string) => {
    if (!thread || busy) return;
    const cut = cutForRegenerate(thread.turns, turnId);
    if (!cut) return;
    chat.setTurns(thread.id, cut.keep);
    void generate(thread.id, cut.keep, thread.personaId, thread.provider, thread.model);
  }, [thread, busy, chat, generate]);

  const resendEdited = useCallback(() => {
    if (!thread || busy || !editing) return;
    const text = editing.text.trim();
    const cut = cutForEdit(thread.turns, editing.id);
    if (!cut || !text) return;
    const turn: Turn = { ...cut.original, id: uid("u"), content: text, ts: Date.now(), sent: cut.original.sent !== undefined ? cut.original.sent.replace(cut.original.content, text) : undefined };
    const turns = [...cut.keep, turn];
    chat.setTurns(thread.id, turns);
    setEditing(null);
    void generate(thread.id, turns, thread.personaId, thread.provider, thread.model);
  }, [thread, busy, editing, chat, generate]);

  const branch = useCallback((turnId: string) => {
    if (!thread) return;
    const id = chat.branchFrom(thread.id, turnId);
    if (id) bus.emit("notify", { title: "Branched conversation", body: branchTitle(thread.title), kind: "success" });
  }, [thread, chat]);

  const exportMd = useCallback((t: Thread) => {
    const persona = allPersonas.find((p) => p.id === t.personaId);
    return threadMarkdown(t, { persona: persona?.name ?? t.personaId, exportedAt: new Date().toISOString(), model: t.model });
  }, [allPersonas]);

  const saveToFiles = useCallback(() => {
    if (!thread) return;
    const path = `/chats/${thread.title.replace(/[^\w\s-]/g, "").slice(0, 40) || "chat"}-${thread.id}.md`;
    vfs.write(path, exportMd(thread), { appId: "chat" });
    bus.emit("notify", { title: "Saved to Files", body: path, kind: "success" });
  }, [thread, exportMd, vfs]);

  // Right-click on a message: copy / regenerate / edit / branch.
  const menuState = useRef({ thread, busy, regenerate, branch });
  useEffect(() => { menuState.current = { thread, busy, regenerate, branch }; });
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    return registerContextTarget(el, ({ target }) => {
      const id = (target.closest("[data-turn-id]") as HTMLElement | null)?.dataset.turnId;
      const { thread: th, busy: b, regenerate: regen, branch: br } = menuState.current;
      const turn = id ? th?.turns.find((t) => t.id === id) : undefined;
      if (!turn) return null;
      const entries: MenuItem[] = [
        { id: "copy", label: "Copy message", icon: "copy", run: () => { void navigator.clipboard?.writeText(turn.content).catch(() => {}); } },
      ];
      if (turn.role === "assistant") entries.push({ id: "regen", label: "Regenerate", icon: "refresh", disabled: b, run: () => regen(turn.id) });
      if (turn.role === "user") entries.push({ id: "edit", label: "Edit and resend", icon: "name", disabled: b, run: () => setEditing({ id: turn.id, text: turn.content }) });
      entries.push({ id: "branch", label: "Branch from here", icon: "layers", run: () => br(turn.id) });
      return { id: "chat", entries };
    });
  }, []);

  const provider = getProvider(effProvider);
  const sorted = useMemo(
    () => [...chat.threads].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt),
    [chat.threads],
  );
  const hits = useMemo(() => searchThreads(chat.threads, search), [chat.threads, search]);
  const files = useMemo(() => {
    if (!picker.open) return [];
    const q = picker.q.toLowerCase();
    return Object.values(vfs.nodes)
      .filter((n) => n.kind === "file" && (!q || n.path.toLowerCase().includes(q)))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 40);
  }, [picker, vfs.nodes]);

  const jumpTo = useCallback((threadId: string, turnId: string | null) => {
    chat.setActive(threadId);
    if (!turnId) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      scrollRef.current?.querySelector(`[data-turn-id="${turnId}"]`)?.scrollIntoView({ block: "center" });
    }));
  }, [chat]);

  const setModel = (p: string, m: string) => {
    if (thread && override) chat.setThreadModel(thread.id, p, m);
    else { settings.setAI("provider", p); settings.setAI("model", m); }
  };

  return (
    <div ref={rootRef} className="app-split flex h-full">
      {showSidebar && (
        <div className="app-sidebar flex w-52 shrink-0 flex-col overflow-y-auto border-r border-[var(--border)]">
          <div className="flex flex-col gap-1.5 p-2">
            <button className="os-btn w-full !py-1 text-[11px]" data-variant="primary" onClick={() => chat.newThread(thread?.personaId)}>
              <Icon name="plus" size={11} /> New chat
            </button>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search all chats"
              aria-label="Search all chats"
              className="os-input !py-1 text-[11.5px]"
              style={{ fontSize: 16 }}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
            {search.trim() ? (
              hits.length === 0 ? <p className="px-2 text-[11px] text-[var(--muted)]">No matches.</p> : hits.map((h) => (
                <button key={h.threadId} onClick={() => jumpTo(h.threadId, h.turnId)} className="mb-1 block w-full rounded px-2 py-1.5 text-left hover:bg-white/6">
                  <div className="flex items-center gap-1">
                    <span className="min-w-0 flex-1 truncate text-[12px]">{h.title}</span>
                    <span className="shrink-0 text-[10px] text-[var(--muted)]">{h.matches}</span>
                  </div>
                  <div className="line-clamp-2 text-[10.5px] text-[var(--muted)]">{h.snippet}</div>
                </button>
              ))
            ) : sorted.map((t) => (
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
                  {t.parentId && <Icon name="layers" size={9} className="shrink-0 text-[var(--muted)]" />}
                  <span className="min-w-0 flex-1 truncate text-[12px]">{t.title}</span>
                  <button
                    className="shrink-0 text-[10px] opacity-0 transition group-hover:opacity-60 hover:!opacity-100 focus:opacity-100"
                    title="Pin"
                    aria-label="Pin thread"
                    onClick={(e) => { e.stopPropagation(); chat.pinThread(t.id); }}
                  >
                    <Icon name="pin" size={10} />
                  </button>
                  <button
                    className="shrink-0 text-[10px] opacity-0 transition group-hover:opacity-60 hover:!opacity-100 focus:opacity-100"
                    title="Delete thread"
                    aria-label="Delete thread"
                    onClick={(e) => { e.stopPropagation(); chat.removeThread(t.id); }}
                  >
                    <Icon name="close" size={10} />
                  </button>
                </div>
                <div className="text-[10px] text-[var(--muted)]">{t.turns.length} msg · {relTime(t.updatedAt)}{t.model ? ` · ${t.model}` : ""}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Toolbar */}
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border)] px-2.5 py-1.5">
          <button className="os-btn !px-2 !py-1 text-[11px]" onClick={() => setShowSidebar((v) => !v)} title="Toggle thread list" aria-label="Toggle thread list">
            <Icon name="menu" size={13} />
          </button>

          <select
            className="os-input !w-auto !py-1 text-[11px]"
            value={effProvider}
            aria-label={override ? "Provider for this thread" : "Provider"}
            onChange={(e) => {
              const p = getProvider(e.target.value);
              setModel(e.target.value, p?.models[0] ?? effModel);
            }}
          >
            {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>

          <input
            className="os-input !w-44 max-w-full !py-1 text-[11px]"
            list="chat-models"
            value={effModel}
            onChange={(e) => setModel(effProvider, e.target.value)}
            placeholder="model id"
            aria-label={override ? "Model for this thread" : "Model"}
            title="Any model id the provider accepts"
          />
          <datalist id="chat-models">
            {(provider?.models ?? []).map((m) => <option key={m} value={m} />)}
          </datalist>
          {thread && (
            <label className="flex items-center gap-1 text-[10.5px] text-[var(--muted)]" title="Use this provider and model for this thread only">
              <input
                type="checkbox"
                checked={override}
                onChange={(e) => chat.setThreadModel(thread.id, e.target.checked ? settings.ai.provider : undefined, e.target.checked ? settings.ai.model : undefined)}
              />
              this thread only
            </label>
          )}

          <select
            className="os-input !w-auto !py-1 text-[11px]"
            value={thread?.personaId ?? "default"}
            onChange={(e) => thread && chat.setPersona(thread.id, e.target.value)}
            title="Persona (system prompt)"
            aria-label="Persona"
          >
            {allPersonas.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>

          <div className="flex-1" />
          {thread && thread.turns.length > 0 && (
            <>
              <button className="os-btn !py-1 text-[11px]" onClick={saveToFiles}>Save to Files</button>
              <button
                className="os-btn !py-1 text-[11px]"
                onClick={() => download(`${thread.title || "chat"}.md`, exportMd(thread), "text/markdown")}
              >
                Export
              </button>
            </>
          )}
        </div>

        {/* Transcript */}
        <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {(!thread || thread.turns.length === 0) && !streamText && !busy && (
            <Empty
              icon="spark"
              title="Ask anything"
              body={`Talking to ${provider?.name ?? effProvider} · ${effModel}${override ? " (this thread only)" : ""}. Change provider, model or persona in the bar above. Keys live in Settings and never leave this browser except to the provider you pick.`}
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
            editing?.id === turn.id ? (
              <div key={turn.id} className="mb-4 ml-auto max-w-[min(78ch,88%)]" data-turn-id={turn.id}>
                <textarea
                  value={editing.text}
                  onChange={(e) => setEditing({ id: turn.id, text: e.target.value })}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); resendEdited(); } if (e.key === "Escape") setEditing(null); }}
                  rows={3}
                  aria-label="Edit message"
                  className="os-input w-full resize-y text-[13px]"
                  style={{ fontSize: 16 }}
                />
                <div className="mt-1 flex justify-end gap-1.5">
                  <button className="os-btn !py-0.5 text-[11px]" onClick={() => setEditing(null)}>Cancel</button>
                  <button className="os-btn !py-0.5 text-[11px]" data-variant="primary" onClick={resendEdited} disabled={busy || !editing.text.trim()}>Save and resend</button>
                </div>
                <p className="mt-1 text-right text-[10px] text-[var(--muted)]">Messages after this one are replaced by the new answer. Branch first to keep them.</p>
              </div>
            ) : (
              <TurnView
                key={turn.id}
                turn={turn}
                busy={busy}
                onRetry={turn.role === "user" ? () => send(turn.content) : undefined}
                onRegenerate={turn.role === "assistant" ? () => regenerate(turn.id) : undefined}
                onEdit={turn.role === "user" ? () => setEditing({ id: turn.id, text: turn.content }) : undefined}
                onBranch={() => branch(turn.id)}
              />
            )
          ))}

          {(streamText || streamReasoning) && (
            <TurnView turn={{ id: "streaming", role: "assistant", content: streamText, reasoning: streamReasoning, ts: 0 }} streaming />
          )}
          {busy && !streamText && !streamReasoning && <div className="py-3"><Spinner label="Thinking…" /></div>}
        </div>

        {/* Composer */}
        <div className="shrink-0 border-t border-[var(--border)] p-2.5">
          <ErrorNote error={error} onDismiss={() => setError(null)} />
          {attached.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1">
              {attached.map((p) => (
                <span key={p} className="os-chip flex items-center gap-1 !text-[10.5px]">
                  <Icon name="file" size={10} />
                  <span className="max-w-40 truncate">{p}</span>
                  <button onClick={() => setAttached((a) => a.filter((x) => x !== p))} aria-label={`Remove attachment ${p}`}><Icon name="close" size={9} /></button>
                </span>
              ))}
            </div>
          )}
          {picker.open && (
            <div className="os-card mb-1.5 !p-2">
              <div className="mb-1 flex items-center gap-1.5">
                <input
                  value={picker.q}
                  onChange={(e) => setPicker({ open: true, q: e.target.value })}
                  placeholder="Filter files"
                  aria-label="Filter files to attach"
                  className="os-input min-w-0 flex-1 !py-0.5 text-[11.5px]"
                  style={{ fontSize: 16 }}
                />
                <span className="shrink-0 text-[10px] text-[var(--muted)]">{attached.length}/{MAX_ATTACH}</span>
                <button className="os-btn !px-1.5 !py-0.5" onClick={() => setPicker({ open: false, q: "" })} aria-label="Close file picker"><Icon name="close" size={10} /></button>
              </div>
              <div className="max-h-40 overflow-y-auto">
                {files.length === 0 ? <p className="text-[11px] text-[var(--muted)]">No files{picker.q ? " match" : " in Files yet"}.</p> : files.map((f) => {
                  const on = attached.includes(f.path);
                  return (
                    <button
                      key={f.path}
                      disabled={!on && attached.length >= MAX_ATTACH}
                      onClick={() => setAttached((a) => (on ? a.filter((x) => x !== f.path) : [...a, f.path]))}
                      className={cn("flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-[11.5px] hover:bg-white/6", on && "bg-[var(--accent)]/14")}
                      aria-pressed={on}
                    >
                      <Icon name={on ? "check" : "file"} size={10} />
                      <span className="min-w-0 flex-1 truncate">{f.path}</span>
                      <span className="shrink-0 text-[10px] text-[var(--muted)]">{f.content.length.toLocaleString()} ch</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <div className="flex items-end gap-1.5">
            <button
              className="os-btn !px-2 !py-2"
              onClick={() => setPicker((p) => ({ open: !p.open, q: "" }))}
              aria-label="Attach a file from Files as context"
              title="Attach a file from Files as context"
              aria-pressed={picker.open}
            >
              <Icon name="file" size={13} />
            </button>
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
              }}
              rows={1}
              placeholder="Message… (Enter to send, Shift+Enter for a new line)"
              aria-label="Message"
              className="os-input max-h-44 min-w-0 flex-1 resize-none"
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
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-[var(--muted)]">
            <span>Budget ${settings.ai.spentUsd.toFixed(4)} / ${settings.ai.budgetUsd.toFixed(2)}</span>
            <span>·</span>
            <span>Cost figures are estimates</span>
            {override && <><span>·</span><span>Thread model: {effModel}</span></>}
          </div>
        </div>
      </div>
    </div>
  );
}

function TurnView({ turn, streaming, busy, onRetry, onRegenerate, onEdit, onBranch }: {
  turn: Turn; streaming?: boolean; busy?: boolean;
  onRetry?: () => void; onRegenerate?: () => void; onEdit?: () => void; onBranch?: () => void;
}) {
  const isUser = turn.role === "user";
  return (
    <div className={cn("group mb-4 flex gap-2.5", isUser && "flex-row-reverse")} data-turn-id={streaming ? undefined : turn.id}>
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
        {turn.reasoning && turn.reasoning.trim() && (
          <details className="mb-1 rounded-[calc(var(--radius)*0.6)] border border-[var(--border)] px-2 py-1 text-left text-[11.5px]" open={streaming && !turn.content}>
            <summary className="cursor-pointer text-[var(--muted)]">
              {streaming && !turn.content ? "Thinking…" : "Reasoning"} ({turn.reasoning.length.toLocaleString()} characters)
            </summary>
            <div className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap text-[var(--muted)]">{turn.reasoning}</div>
          </details>
        )}
        {(turn.content || !streaming) && (
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
        )}
        {turn.attachments && turn.attachments.length > 0 && (
          <div className={cn("mt-1 flex flex-wrap gap-1", isUser && "justify-end")}>
            {turn.attachments.map((a) => (
              <span key={a.path} className="os-chip flex items-center gap-1 !text-[10px]"><Icon name="file" size={9} />{a.path} · {a.chars.toLocaleString()} ch</span>
            ))}
          </div>
        )}
        {!streaming && (
          <div className={cn("mt-1 flex flex-wrap items-center gap-2 text-[10px] text-[var(--muted)] opacity-0 transition focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100", isUser && "justify-end")}>
            {turn.model && <span>{turn.model}</span>}
            {turn.ms !== undefined && <span>{(turn.ms / 1000).toFixed(1)}s</span>}
            {turn.costUsd !== undefined && turn.costUsd > 0 && <span>~${turn.costUsd.toFixed(4)}</span>}
            <CopyButton text={turn.content} label="Copy" className="!px-1.5 !py-0 !text-[10px]" />
            {onRetry && <button className="os-btn !px-1.5 !py-0 !text-[10px]" onClick={onRetry} disabled={busy}>Resend</button>}
            {onEdit && <button className="os-btn !px-1.5 !py-0 !text-[10px]" onClick={onEdit} disabled={busy}>Edit</button>}
            {onRegenerate && <button className="os-btn !px-1.5 !py-0 !text-[10px]" onClick={onRegenerate} disabled={busy}>Regenerate</button>}
            {onBranch && <button className="os-btn !px-1.5 !py-0 !text-[10px]" onClick={onBranch}>Branch</button>}
          </div>
        )}
      </div>
    </div>
  );
}

/** Kept for callers of the old name; the export now lives in lib/chat-thread. */
export function threadToMarkdown(thread: Thread, personas: Persona[]): string {
  const persona = personas.find((p) => p.id === thread.personaId);
  return threadMarkdown(thread, { persona: persona?.name ?? thread.personaId, exportedAt: new Date().toISOString(), model: thread.model });
}
