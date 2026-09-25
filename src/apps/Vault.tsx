"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { bus } from "@/kernel/bus";
import { ask } from "@/lib/useAI";
import type { AppProps } from "@/kernel/types";
import { uid, relTime, download } from "@/lib/format";
import { Tabs, Empty, ErrorNote, Spinner, Markdown, CopyButton } from "./_ui";
import { cn } from "@/lib/cn";
import { Icon } from "@/shell/icons";
import { registerContextTarget, type TargetContext } from "@/kernel/ctxmenu";

/* ────────────────────────────────────────────────────────────────────────────
   Memory Vault — ported from aurora-os.html.

   Agent memory that is only an append-only log grows until it is useless. The
   original's answer, kept here, is a reflection pass: periodically the model
   reads recent entries and writes durable summaries, and recall searches those
   alongside the raw stream. Pruning is explicit and reversible rather than
   automatic, because silently forgetting is worse than remembering too much.
   ──────────────────────────────────────────────────────────────────────────── */

export interface Memory {
  id: string;
  text: string;
  kind: "note" | "fact" | "preference" | "reflection" | "event";
  tags: string[];
  ts: number;
  /** Reflections cite the entries they were distilled from. */
  sources?: string[];
  pinned?: boolean;
}

interface VaultState {
  memories: Memory[];
  add: (m: Omit<Memory, "id" | "ts">) => string;
  patch: (id: string, p: Partial<Memory>) => void;
  remove: (id: string) => void;
  clear: () => void;
}

export const useVault = create<VaultState>()(
  persist(
    (set) => ({
      memories: [],
      add: (m) => {
        const id = uid("mem");
        set((s) => ({ memories: [{ ...m, id, ts: Date.now() }, ...s.memories] }));
        return id;
      },
      patch: (id, p) => set((s) => ({ memories: s.memories.map((m) => (m.id === id ? { ...m, ...p } : m)) })),
      remove: (id) => set((s) => ({ memories: s.memories.filter((m) => m.id !== id) })),
      clear: () => set({ memories: [] }),
    }),
    { name: "webaios.vault.v1", storage: createJSONStorage(() => localStorage) },
  ),
);

const KINDS: Memory["kind"][] = ["note", "fact", "preference", "reflection", "event"];

export default function Vault({}: AppProps) {
  const vault = useVault();
  const [tab, setTab] = useState("stream");
  const [input, setInput] = useState("");
  const [kind, setKind] = useState<Memory["kind"]>("note");
  const [q, setQ] = useState("");
  const [recall, setRecall] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");

  const filtered = useMemo(() => {
    let out = vault.memories;
    if (filter !== "all") out = out.filter((m) => m.kind === filter);
    if (q.trim()) out = out.filter((m) => (m.text + m.tags.join(" ")).toLowerCase().includes(q.toLowerCase()));
    return [...out].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.ts - a.ts);
  }, [vault.memories, filter, q]);

  const capture = useCallback(() => {
    if (!input.trim()) return;
    // #tags are pulled out of the text so capture stays one keystroke.
    const tags = [...input.matchAll(/#(\w+)/g)].map((m) => m[1]);
    vault.add({ text: input.replace(/#\w+/g, "").trim(), kind, tags });
    setInput("");
  }, [input, kind, vault]);

  const reflect = useCallback(async () => {
    const recent = vault.memories.filter((m) => m.kind !== "reflection").slice(0, 40);
    if (recent.length < 3) { setError("Capture at least three entries before reflecting — there is nothing to distil yet."); return; }
    setBusy("reflect"); setError(null);
    try {
      const res = await ask({
        messages: [{ role: "user", content: recent.map((m) => `[${m.id}] (${m.kind}) ${m.text}`).join("\n") }],
        system: `You distil a memory stream into durable statements.

Return ONLY a JSON array: [{"text": "<one durable statement>", "sources": ["<id>", ...]}]

Rules:
- Between 2 and 8 statements. Each should still be worth knowing in six months.
- Cite the entry ids each statement came from.
- Prefer patterns across entries over restating any single one.
- Do not invent anything the entries do not support.`,
        maxTokens: 1400,
      });
      const s = res.text.indexOf("[");
      const e = res.text.lastIndexOf("]");
      const parsed = JSON.parse(s !== -1 && e > s ? res.text.slice(s, e + 1) : res.text);
      if (!Array.isArray(parsed)) throw new Error("Unexpected response shape.");
      for (const r of parsed) {
        if (!r?.text) continue;
        vault.add({ text: String(r.text), kind: "reflection", tags: ["reflection"], sources: Array.isArray(r.sources) ? r.sources.map(String) : [] });
      }
      bus.emit("notify", { title: `${parsed.length} reflections written`, kind: "success" });
      setTab("stream");
      setFilter("reflection");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reflection failed.");
    } finally { setBusy(null); }
  }, [vault]);

  const doRecall = useCallback(async () => {
    if (!q.trim()) return;
    setBusy("recall"); setError(null); setRecall("");
    try {
      // Reflections first — they are the distilled layer and the most useful
      // context per token.
      const pool = [...vault.memories].sort((a, b) => (a.kind === "reflection" ? -1 : 1) - (b.kind === "reflection" ? -1 : 1)).slice(0, 60);
      const res = await ask({
        messages: [{ role: "user", content: `Question: ${q}\n\nMemory:\n${pool.map((m) => `[${m.kind}] ${m.text}`).join("\n")}` }],
        system: "Answer the question using only what the memory contains. Cite the entries you used. If the memory does not answer it, say so plainly instead of filling the gap.",
        maxTokens: 900,
        onDelta: (_d, f) => setRecall(f),
      });
      setRecall(res.text);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Recall failed.");
    } finally { setBusy(null); }
  }, [q, vault.memories]);

  const streamRef = useRef<HTMLDivElement>(null);
  // Removing a memory is permanent in the store, so the last one removed can be put back.
  const [undo, setUndo] = useState<{ m: Memory; index: number } | null>(null);
  const forget = useCallback((m: Memory) => {
    const index = useVault.getState().memories.findIndex((x) => x.id === m.id);
    vault.remove(m.id);
    setUndo({ m, index });
  }, [vault]);
  const restoreLast = useCallback(() => {
    if (!undo) return;
    useVault.setState((st) => {
      if (st.memories.some((x) => x.id === undo.m.id)) return st;
      const next = [...st.memories];
      next.splice(Math.min(Math.max(0, undo.index), next.length), 0, undo.m);
      return { memories: next };
    });
    setUndo(null);
  }, [undo]);

  useEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    return registerContextTarget(el, ({ target }: TargetContext) => {
      const id = (target.closest("[data-memory-id]") as HTMLElement | null)?.dataset.memoryId;
      const m = id ? useVault.getState().memories.find((x) => x.id === id) : undefined;
      if (!m) return null;
      return {
        id: "vault-memory",
        entries: [
          { id: "pin", label: m.pinned ? "Unpin" : "Pin", icon: "star", checked: Boolean(m.pinned), run: () => vault.patch(m.id, { pinned: !m.pinned }) },
          { id: "kind", label: "Kind", icon: "tune", submenu: KINDS.filter((k) => k !== "reflection").map((k) => ({ id: k, label: k, checked: m.kind === k, run: () => vault.patch(m.id, { kind: k }) })) },
          { id: "copy", label: "Copy text", icon: "copy", run: () => { void navigator.clipboard.writeText(m.text).then(() => bus.emit("notify", { title: "Memory copied", kind: "success" }), () => setError("The browser refused clipboard access.")); } },
          { id: "ask", label: "Ask AI about this", icon: "spark", run: () => bus.emit("aios-chat:ask", { prompt: "What should I do with this memory, and does it conflict with anything else I have told you?", context: { label: `a ${m.kind} from my memory vault`, text: m.text } }) },
          { separator: true },
          { id: "forget", label: "Forget", icon: "close", danger: true, run: () => forget(m) },
        ],
      };
    });
  }, [vault, forget, tab]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: vault.memories.length };
    for (const k of KINDS) c[k] = vault.memories.filter((m) => m.kind === k).length;
    return c;
  }, [vault.memories]);

  return (
    <div className="flex h-full flex-col">
      <Tabs tabs={[{ id: "stream", label: `Stream (${vault.memories.length})`, icon: "vault" }, { id: "recall", label: "Recall", icon: "search" }]} active={tab} onChange={setTab} />

      <div className="shrink-0 border-b border-[var(--border)] p-2.5">
        <ErrorNote error={error} onDismiss={() => setError(null)} />
        {tab === "stream" ? (
          <>
            <div className="mb-2 flex gap-1.5">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && capture()}
                placeholder="Capture something worth remembering… use #tags"
                className="os-input flex-1 !py-1 text-[12px]"
              />
              <select value={kind} onChange={(e) => setKind(e.target.value as Memory["kind"])} className="os-input !w-auto !py-1 text-[11px]">
                {KINDS.filter((k) => k !== "reflection").map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
              <button className="os-btn !py-1 text-[11px]" onClick={capture} disabled={!input.trim()}>Capture</button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {["all", ...KINDS].map((k) => (
                <button key={k} onClick={() => setFilter(k)} className={cn("os-btn !px-2 !py-0.5 text-[10.5px]", filter === k && "!border-[var(--accent)] !bg-[var(--accent)]/16")}>
                  {k} {counts[k] ? `(${counts[k]})` : ""}
                </button>
              ))}
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…" className="os-input !w-32 !py-0.5 text-[11px]" />
              <div className="flex-1" />
              {busy === "reflect" ? <Spinner label="Reflecting…" /> : <button className="os-btn !py-1 text-[11px]" onClick={reflect}>Reflect</button>}
              <button className="os-btn !py-1 text-[11px]" onClick={() => download(`vault-${Date.now()}.json`, JSON.stringify(vault.memories, null, 2), "application/json")}>Export</button>
            </div>
          </>
        ) : (
          <div className="flex gap-1.5">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doRecall()}
              placeholder="Ask the vault a question…"
              className="os-input flex-1 !py-1 text-[12px]"
            />
            <button className="os-btn !py-1 text-[11px]" data-variant="primary" onClick={doRecall} disabled={busy === "recall" || !q.trim()}>Recall</button>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === "stream" && (
          filtered.length === 0 ? (
            <Empty icon="vault" title="Nothing stored" body="Capture facts, preferences and events as you go. Reflect turns the raw stream into durable statements that recall searches first." />
          ) : (
            <div ref={streamRef} className="space-y-1.5">
              {undo && (
                <div className="flex items-center gap-2 rounded-[calc(var(--radius)*0.5)] border border-[var(--border)] px-2 py-1 text-[11px]">
                  <span className="min-w-0 flex-1 truncate">Forgot &quot;{undo.m.text.slice(0, 60)}&quot;</span>
                  <button className="os-btn !py-0.5 text-[11px]" onClick={restoreLast}>Undo</button>
                  <button className="text-[10px] opacity-60 hover:opacity-100" aria-label="Dismiss" onClick={() => setUndo(null)}><Icon name="close" size={10} /></button>
                </div>
              )}
              {filtered.map((m) => (
                <div key={m.id} data-memory-id={m.id} className={cn("os-card !py-2", m.kind === "reflection" && "!border-[var(--accent2)]")}>
                  <div className="flex items-start gap-2">
                    <span className="os-chip mt-0.5 shrink-0 !px-1.5 !py-0 !text-[9.5px]">{m.kind}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[12.5px] leading-relaxed">{m.text}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-[var(--muted)]">
                        <span>{relTime(m.ts)}</span>
                        {m.tags.map((t) => <span key={t} className="os-chip !px-1.5 !py-0 !text-[9px]">#{t}</span>)}
                        {m.sources?.length ? <span>· from {m.sources.length} entries</span> : null}
                      </div>
                    </div>
                    <button className="shrink-0 text-[10px] opacity-60 hover:opacity-100" title="Pin" aria-label="Pin memory" onClick={() => vault.patch(m.id, { pinned: !m.pinned })}><Icon name="star" size={11} style={{ color: m.pinned ? "var(--accent)" : "inherit" }} /></button>
                    <button className="shrink-0 text-[10px] opacity-60 hover:opacity-100" aria-label="Forget memory" title="Forget (can be undone)" onClick={() => forget(m)}><Icon name="close" size={11} /></button>
                  </div>
                </div>
              ))}
            </div>
          )
        )}

        {tab === "recall" && (
          recall ? (
            <div className="mx-auto max-w-3xl">
              <div className="mb-2 flex justify-end"><CopyButton text={recall} /></div>
              <Markdown text={recall} />
            </div>
          ) : (
            <Empty icon="search" title="Ask the vault" body="Recall searches the reflection layer first, then the raw stream, and answers only from what is stored." />
          )
        )}
      </div>
    </div>
  );
}
