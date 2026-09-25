"use client";

import { extractCode } from "@/lib/extract-code";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVFS } from "@/kernel/vfs";
import { bus } from "@/kernel/bus";
import { ask } from "@/lib/useAI";
import type { AppProps } from "@/kernel/types";
import { download, relTime, uid } from "@/lib/format";
import { ErrorNote, Empty, Spinner, CopyButton, Markdown } from "./_ui";
import { cn } from "@/lib/cn";
import { Icon } from "@/shell/icons";
import { registerContextTarget } from "@/kernel/ctxmenu";
import {
  langFor, formatCode, findAll, replaceAll, lineCol, offsetOfLine, workerSource, userLine, MAX_MATCHES,
  type FindOptions, type Match,
} from "@/lib/codefmt";

/* ────────────────────────────────────────────────────────────────────────────
   Code Studio — ported from MyTermz (AI Super IDE).

   Kept from the original: tabs over the shared filesystem, a live preview that
   renders the document you are editing, AI edits applied to the whole file, and
   snapshots so an AI edit is never a one-way door. Dropped: the local bridge
   and terminal, which live in the Bridge app now that they need a companion
   daemon rather than being assumed.
   ──────────────────────────────────────────────────────────────────────────── */

interface Snapshot { id: string; path: string; content: string; label: string; ts: number }

interface RunLine { level: string; text: string }

/** How long a run may take before the worker is terminated. An infinite loop
 *  in a Worker cannot freeze the OS, but it would burn a core until reload. */
const RUN_TIMEOUT_MS = 8000;

export default function IDE({ args }: AppProps) {
  const vfs = useVFS();
  const [open, setOpen] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pane, setPane] = useState<"preview" | "chat" | "console" | "none">("none");
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [instruction, setInstruction] = useState("");
  const [aiLog, setAiLog] = useState("");
  const [formatOnSave, setFormatOnSave] = useState(true);
  const [saved, setSaved] = useState<string | null>(null);
  // Find / replace
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [findOpts, setFindOpts] = useState<FindOptions>({});
  const [matchIdx, setMatchIdx] = useState(0);
  // Run
  const [runLog, setRunLog] = useState<RunLine[]>([]);
  const [running, setRunning] = useState<{ started: number } | null>(null);
  const [runMs, setRunMs] = useState<number | null>(null);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const taRef = useRef<HTMLTextAreaElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const workerRef = useRef<Worker | null>(null);
  // What the right-click builder reads: it runs at click time, outside render.
  const liveRef = useRef<{ active: string | null; format: () => void; goTo: () => void; ask: () => void; run: () => void; find: () => void }>(null);

  const files = useMemo(
    () => Object.values(vfs.nodes).filter((n) => n.kind === "file").sort((a, b) => b.updatedAt - a.updatedAt),
    [vfs.nodes],
  );

  /** Write the current buffer now. Switching tabs used to cancel the pending
   *  debounced write, so the last half-second of typing could be lost. */
  const flush = useCallback(() => {
    if (active && vfs.read(active)?.content !== draft) vfs.write(active, draft, { appId: "ide" });
  }, [active, draft, vfs]);

  const openFile = useCallback((path: string) => {
    flush();
    setOpen((o) => (o.includes(path) ? o : [...o, path]));
    setActive(path);
    setDraft(vfs.read(path)?.content ?? "");
  }, [vfs, flush]);

  // A launch payload opens one file, once, without an effect round-trip.
  const argPath = args?.path as string | undefined;
  const [seededPath, setSeededPath] = useState<string | undefined>(undefined);
  if (argPath && argPath !== seededPath) {
    setSeededPath(argPath);
    if (vfs.read(argPath)) openFile(argPath);
  }

  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => vfs.write(active, draft, { appId: "ide" }), 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, active]);

  const snapshot = useCallback((label: string) => {
    if (!active) return;
    setSnapshots((s) => [{ id: uid("snap"), path: active, content: draft, label, ts: Date.now() }, ...s].slice(0, 40));
  }, [active, draft]);

  const lang = active ? langFor(active) : null;
  const canRun = lang === "js" && !!active && !/\.jsx$/i.test(active);

  /* ── format and save ── */

  const format = useCallback((quiet = false): string | null => {
    if (!lang) { if (!quiet) setError("No formatter for this file type. Formatting covers JS, TS, CSS, JSON and HTML."); return null; }
    const r = formatCode(draft, lang);
    if (!r.ok) { setError(r.error); return null; }
    if (r.changed) {
      snapshot("before format");
      setDraft(r.text);
    }
    return r.text;
  }, [lang, draft, snapshot]);

  const save = useCallback(() => {
    if (!active) return;
    const text = formatOnSave && lang ? format(true) ?? draft : draft;
    vfs.write(active, text, { appId: "ide" });
    setSaved(new Date().toLocaleTimeString());
  }, [active, formatOnSave, lang, format, draft, vfs]);

  /* ── go to line ── */

  const goToLine = useCallback((line?: number) => {
    const el = taRef.current;
    if (!el) return;
    const total = draft.split("\n").length;
    const n = line ?? Number(window.prompt(`Go to line (1-${total})`, String(cursor.line)));
    if (!Number.isFinite(n) || n < 1) return;
    const at = offsetOfLine(draft, Math.min(total, Math.floor(n)));
    el.focus();
    el.setSelectionRange(at, at);
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 18;
    el.scrollTop = Math.max(0, (Math.min(total, n) - 3) * lh);
    setCursor(lineCol(draft, at));
  }, [draft, cursor.line]);

  /* ── find / replace ── */

  const found = useMemo(() => (findOpen && query ? findAll(draft, query, findOpts) : { matches: [] as Match[] }), [findOpen, query, draft, findOpts]);
  const count = found.matches.length;
  const current = count ? Math.min(matchIdx, count - 1) : -1;

  const selectMatch = useCallback((i: number) => {
    const m = found.matches[i];
    const el = taRef.current;
    if (!m || !el) return;
    setMatchIdx(i);
    el.focus();
    el.setSelectionRange(m.start, m.end);
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 18;
    el.scrollTop = Math.max(0, (lineCol(draft, m.start).line - 4) * lh);
    // Hand focus back to the find box so Enter keeps stepping.
    requestAnimationFrame(() => findRef.current?.focus());
  }, [found.matches, draft]);

  const step = useCallback((dir: 1 | -1) => {
    if (!count) return;
    selectMatch((current + dir + count) % count);
  }, [count, current, selectMatch]);

  const replaceOne = useCallback(() => {
    const m = found.matches[current];
    if (!m) return;
    const one = replaceAll(draft.slice(m.start, m.end), query, replacement, findOpts);
    setDraft(draft.slice(0, m.start) + one.text + draft.slice(m.end));
  }, [found.matches, current, draft, query, replacement, findOpts]);

  const replaceEvery = useCallback(() => {
    const r = replaceAll(draft, query, replacement, findOpts);
    if (r.error) { setError(r.error); return; }
    if (r.count) { snapshot(`before replacing ${r.count}`); setDraft(r.text); }
    bus.emit("notify", { title: `Replaced ${r.count} match${r.count === 1 ? "" : "es"}`, kind: r.count ? "success" : "info" });
  }, [draft, query, replacement, findOpts, snapshot]);

  const openFind = useCallback(() => {
    const el = taRef.current;
    const sel = el ? draft.slice(el.selectionStart, el.selectionEnd) : "";
    if (sel && !sel.includes("\n")) setQuery(sel);
    setFindOpen(true);
    requestAnimationFrame(() => { findRef.current?.focus(); findRef.current?.select(); });
  }, [draft]);

  /* ── ask AI about the selection ── */

  const askAI = useCallback(() => {
    if (!active) return;
    const el = taRef.current;
    const sel = el ? draft.slice(el.selectionStart, el.selectionEnd) : "";
    const text = sel || draft;
    const from = el ? lineCol(draft, el.selectionStart).line : 1;
    const to = el ? lineCol(draft, el.selectionEnd).line : 1;
    const label = sel ? `${active.split("/").pop()} lines ${from}-${to}` : active.split("/").pop() ?? active;
    bus.emit("aios-chat:ask", {
      prompt: sel ? `Explain this code from ${active} and point out anything wrong with it.` : `Review ${active}: what does it do, and what would you change?`,
      context: { label, text: text.slice(0, 12_000) },
    });
  }, [active, draft]);

  /* ── run in a worker ── */

  const stopRun = useCallback((why?: string) => {
    workerRef.current?.terminate();
    workerRef.current = null;
    setRunning(null);
    if (why) setRunLog((l) => [...l, { level: "warn", text: why }]);
  }, []);

  const run = useCallback(() => {
    if (!canRun) return;
    stopRun();
    setPane("console");
    setRunLog([]);
    setRunMs(null);
    const started = performance.now();
    const blob = new Blob([workerSource(draft)], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    let w: Worker;
    try {
      w = new Worker(url);
    } catch (e) {
      URL.revokeObjectURL(url);
      setRunLog([{ level: "error", text: e instanceof Error ? e.message : "Could not start a worker." }]);
      return;
    }
    workerRef.current = w;
    setRunning({ started });
    const timer = setTimeout(() => {
      if (workerRef.current === w) stopRun(`Stopped after ${RUN_TIMEOUT_MS / 1000}s. The script was still running.`);
    }, RUN_TIMEOUT_MS);
    const done = () => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      setRunMs(Math.round(performance.now() - started));
      if (workerRef.current === w) { w.terminate(); workerRef.current = null; setRunning(null); }
    };
    w.onmessage = (e: MessageEvent) => {
      const d = e.data as { __ide?: number; level?: string; text?: string; done?: boolean };
      if (d?.__ide !== 1) return;
      if (d.done) { done(); return; }
      setRunLog((l) => [...l, { level: d.level ?? "log", text: d.text ?? "" }].slice(-500));
    };
    w.onerror = (e: ErrorEvent) => {
      e.preventDefault();
      setRunLog((l) => [...l, { level: "error", text: `${e.message}${e.lineno ? ` (line ${userLine(e.lineno)})` : ""}` }]);
      done();
    };
  }, [canRun, draft, stopRun]);

  useEffect(() => () => workerRef.current?.terminate(), []);

  /* ── the IDE's right-click section ── */

  useEffect(() => {
    liveRef.current = { active, format: () => { format(); }, goTo: () => goToLine(), ask: askAI, run, find: openFind };
  });

  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    return registerContextTarget(el, () => {
      const live = liveRef.current;
      if (!live?.active) return null;
      const l = langFor(live.active);
      return {
        id: "ide",
        entries: [
          { id: "ide-ask", label: "Ask AI about the selection", icon: "chat", run: live.ask },
          { id: "ide-format", label: "Format document", icon: "brush", hint: "Shift+Alt+F", disabled: !l, run: live.format },
          { id: "ide-goto", label: "Go to line…", icon: "chevronRight", hint: "Ctrl+G", run: live.goTo },
          { id: "ide-find", label: "Find and replace", icon: "search", hint: "Ctrl+F", run: live.find },
          ...(l === "js" ? [{ id: "ide-run", label: "Run in a worker", icon: "play", run: live.run }] : []),
        ],
      };
    });
  }, [active]);

  const runAI = useCallback(async () => {
    if (!active || !instruction.trim() || busy) return;
    // Snapshot BEFORE the edit, always. An AI rewrite you cannot undo is a
    // rewrite you cannot trust.
    snapshot(`before: ${instruction.slice(0, 40)}`);
    setBusy(true);
    setError(null);
    setAiLog("");
    try {
      const res = await ask({
        messages: [{ role: "user", content: `File: ${active}\n\nInstruction: ${instruction}\n\nCurrent contents:\n\`\`\`\n${draft}\n\`\`\`` }],
        system: "You edit source files. Return the COMPLETE updated file inside one fenced code block, and nothing else — no explanation before or after. Preserve everything the instruction did not ask you to change.",
        maxTokens: 8000,
        onDelta: (_d, full) => setAiLog(full),
      });
      const code = extractCode(res.text);
      if (!code) throw new Error("No code block found in the response. Try rephrasing, or use a stronger model.");
      setDraft(code);
      setAiLog("");
      setInstruction("");
      bus.emit("notify", { title: "AI edit applied", body: `Snapshot saved — use Revert to undo.`, kind: "success" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Edit failed.");
    } finally { setBusy(false); }
  }, [active, instruction, draft, busy, snapshot]);

  const switchTo = (p: string) => { flush(); setActive(p); setDraft(vfs.read(p)?.content ?? ""); setFindOpen(false); };
  const closeTab = (p: string) => {
    if (active === p) flush();
    setOpen((o) => o.filter((x) => x !== p));
    if (active === p) {
      const next = open.filter((x) => x !== p)[0] ?? null;
      setActive(next);
      setDraft(next ? vfs.read(next)?.content ?? "" : "");
    }
  };

  const isHtml = active?.endsWith(".html") ?? false;
  const lineCount = draft.split("\n").length;
  const updateCursor = (el: HTMLTextAreaElement) => setCursor(lineCol(el.value, el.selectionStart));

  return (
    <div className="app-split flex h-full">
      {/* Explorer */}
      <div className="app-sidebar flex w-48 shrink-0 flex-col overflow-y-auto border-r border-[var(--border)]">
        <div className="flex gap-1 p-2">
          <button
            className="os-btn flex-1 !py-1 text-[10.5px]"
            onClick={() => {
              const name = prompt("File name (e.g. app.html, notes.md)");
              if (!name) return;
              const p = `/code/${name}`;
              vfs.write(p, "", { appId: "ide" });
              openFile(p);
            }}
          >
            + New
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
          {files.map((f) => (
            <button
              key={f.path}
              onClick={() => openFile(f.path)}
              className={cn("mb-0.5 block w-full truncate rounded px-2 py-1 text-left text-[11.5px]", active === f.path ? "bg-[var(--accent)]/16" : "hover:bg-white/6")}
              title={f.path}
            >
              {f.name}
            </button>
          ))}
          {files.length === 0 && <div className="px-2 py-6 text-center text-[11px] text-[var(--muted)]">No files</div>}
        </div>
      </div>

      {/* Editor */}
      <div className="flex min-w-0 flex-1 flex-col">
        {open.length > 0 && (
          <div className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-[var(--border)] px-1.5 pt-1.5" role="tablist" aria-label="Open files">
            {open.map((p) => (
              <div
                key={p}
                className={cn("flex shrink-0 items-center gap-1 rounded-t px-2 py-1 text-[11.5px]", active === p ? "bg-[var(--accent)]/16" : "hover:bg-white/6")}
                onAuxClick={(e) => { if (e.button === 1) closeTab(p); }}
              >
                <button role="tab" aria-selected={active === p} onClick={() => switchTo(p)}>{p.split("/").pop()}</button>
                <button className="opacity-50 hover:opacity-100" aria-label={`Close ${p.split("/").pop()}`} onClick={() => closeTab(p)}>
                  <Icon name="close" size={11} />
                </button>
              </div>
            ))}
          </div>
        )}

        {!active ? (
          <Empty icon="app" title="No file open" body="Pick a file on the left, or create one. Everything written here lands in the OS filesystem and is visible to Files, Notes and the Terminal." />
        ) : (
          <>
            <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border)] px-2.5 py-1.5">
              <span className="min-w-0 truncate text-[11px] text-[var(--muted)]">{active}</span>
              <span className="os-chip !text-[10px] tabular-nums">{lineCount} lines</span>
              <span className="os-chip !text-[10px] tabular-nums" title="Cursor">Ln {cursor.line}, Col {cursor.col}</span>
              {saved && <span className="text-[10px] text-[var(--muted)]">saved {saved}</span>}
              <div className="flex-1" />
              {(["none", "preview", "console", "chat"] as const).map((p) => (
                <button key={p} onClick={() => setPane(p)} className={cn("os-btn !py-1 text-[11px]", pane === p && "!border-[var(--accent)] !bg-[var(--accent)]/16")}>
                  {p === "none" ? "editor" : p === "chat" ? "snapshots" : p}
                </button>
              ))}
              <button className="os-btn !py-1 text-[11px]" onClick={openFind} title="Find and replace (Ctrl+F)">
                <Icon name="search" size={11} className="mr-1" />Find
              </button>
              <button className="os-btn !py-1 text-[11px]" onClick={() => format()} disabled={!lang} title={lang ? `Format ${lang.toUpperCase()} (Shift+Alt+F)` : "No formatter for this file type"}>
                <Icon name="brush" size={11} className="mr-1" />Format
              </button>
              {canRun && (
                running ? (
                  <button className="os-btn !py-1 text-[11px]" onClick={() => stopRun("Stopped.")}><Icon name="stop" size={11} className="mr-1" />Stop</button>
                ) : (
                  <button className="os-btn !py-1 text-[11px]" data-variant="primary" onClick={run} title="Run in a Web Worker"><Icon name="play" size={11} className="mr-1" />Run</button>
                )
              )}
              <button className="os-btn !py-1 text-[11px]" onClick={askAI} title="Ask AIOS Chat about the selection, or the whole file">
                <Icon name="chat" size={11} className="mr-1" />Ask AI
              </button>
              <button className="os-btn !py-1 text-[11px]" onClick={() => snapshot("manual")}>Snapshot</button>
              <CopyButton text={draft} />
              <button className="os-btn !py-1 text-[11px]" onClick={() => download(active.split("/").pop()!, draft)}>Download</button>
              <label className="flex items-center gap-1 text-[10.5px] text-[var(--muted)]" title="Ctrl+S formats JS, TS, CSS, JSON and HTML before writing">
                <input type="checkbox" checked={formatOnSave} onChange={(e) => setFormatOnSave(e.target.checked)} />
                format on save
              </label>
            </div>

            {findOpen && (
              <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--border)] px-2.5 py-1.5">
                <input
                  ref={findRef}
                  value={query}
                  onChange={(e) => { setQuery(e.target.value); setMatchIdx(0); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
                    if (e.key === "Escape") { setFindOpen(false); taRef.current?.focus(); }
                  }}
                  placeholder="Find"
                  aria-label="Find"
                  className="os-input !w-40 min-w-0 flex-1 !py-0.5 text-[11.5px]"
                />
                <input
                  value={replacement}
                  onChange={(e) => setReplacement(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); replaceOne(); } }}
                  placeholder="Replace"
                  aria-label="Replace with"
                  className="os-input !w-40 min-w-0 flex-1 !py-0.5 text-[11.5px]"
                />
                <span className="min-w-14 text-center text-[10.5px] tabular-nums text-[var(--muted)]" aria-live="polite">
                  {found.error ? "bad pattern" : count ? `${current + 1} of ${count}${count >= MAX_MATCHES ? "+" : ""}` : query ? "no results" : ""}
                </span>
                {([["caseSensitive", "Aa", "Match case"], ["wholeWord", "W", "Whole word"], ["regex", ".*", "Regular expression"]] as const).map(([k, label, title]) => (
                  <button
                    key={k}
                    title={title}
                    aria-label={title}
                    aria-pressed={!!findOpts[k]}
                    onClick={() => setFindOpts((o) => ({ ...o, [k]: !o[k] }))}
                    className={cn("os-btn !px-1.5 !py-0.5 font-[family-name:var(--font-mono)] text-[10.5px]", findOpts[k] && "!border-[var(--accent)] !bg-[var(--accent)]/16")}
                  >
                    {label}
                  </button>
                ))}
                <button className="os-btn !px-1.5 !py-0.5 text-[10.5px]" onClick={() => step(-1)} disabled={!count} aria-label="Previous match"><Icon name="arrowUp" size={11} /></button>
                <button className="os-btn !px-1.5 !py-0.5 text-[10.5px]" onClick={() => step(1)} disabled={!count} aria-label="Next match"><Icon name="arrowDown" size={11} /></button>
                <button className="os-btn !px-2 !py-0.5 text-[10.5px]" onClick={replaceOne} disabled={!count}>Replace</button>
                <button className="os-btn !px-2 !py-0.5 text-[10.5px]" onClick={replaceEvery} disabled={!count}>All</button>
                <button className="os-btn !px-1.5 !py-0.5 text-[10.5px]" onClick={() => setFindOpen(false)} aria-label="Close find"><Icon name="close" size={11} /></button>
              </div>
            )}

            <div className="px-2.5 pt-2"><ErrorNote error={error} onDismiss={() => setError(null)} /></div>

            <div className={cn("min-h-0 flex-1", pane !== "none" && "grid grid-cols-1 lg:grid-cols-2")}>
              <div ref={editorRef} className="flex min-h-0 flex-col">
                <textarea
                  ref={taRef}
                  value={draft}
                  aria-label={`Editing ${active}`}
                  onChange={(e) => { setDraft(e.target.value); updateCursor(e.currentTarget); }}
                  onSelect={(e) => updateCursor(e.currentTarget)}
                  onKeyDown={(e) => {
                    const mod = e.metaKey || e.ctrlKey;
                    // Tab must indent, not escape the editor.
                    if (e.key === "Tab") {
                      e.preventDefault();
                      const el = e.currentTarget;
                      const { selectionStart: a, selectionEnd: b } = el;
                      const next = draft.slice(0, a) + "  " + draft.slice(b);
                      setDraft(next);
                      requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
                    } else if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
                    else if (mod && e.key.toLowerCase() === "f") { e.preventDefault(); openFind(); }
                    else if (mod && e.key.toLowerCase() === "h") { e.preventDefault(); openFind(); }
                    else if (mod && e.key.toLowerCase() === "g") { e.preventDefault(); goToLine(); }
                    else if (e.shiftKey && e.altKey && e.key.toLowerCase() === "f") { e.preventDefault(); format(); }
                    else if (mod && e.key === "Enter" && canRun) { e.preventDefault(); run(); }
                  }}
                  spellCheck={false}
                  className="min-h-0 flex-1 resize-none bg-transparent p-2.5 font-[family-name:var(--font-mono)] text-[12px] leading-[1.55] outline-none"
                  placeholder="// start typing"
                />
                <div className="shrink-0 border-t border-[var(--border)] p-2">
                  <div className="flex gap-1.5">
                    <input
                      value={instruction}
                      onChange={(e) => setInstruction(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && runAI()}
                      placeholder="Tell the model what to change…"
                      aria-label="Instruction for an AI edit"
                      className="os-input min-w-0 flex-1 !py-1 text-[12px]"
                    />
                    <button className="os-btn !py-1 text-[11px]" onClick={runAI} disabled={busy || !instruction.trim()}>
                      {busy ? "…" : "Apply"}
                    </button>
                  </div>
                  {busy && <div className="mt-1"><Spinner label={`Rewriting (${aiLog.length} chars)…`} /></div>}
                </div>
              </div>

              {pane === "preview" && (
                <div className="min-h-0 border-l border-[var(--border)]">
                  {isHtml ? (
                    <iframe
                      // srcDoc keeps the preview entirely local — no blob URL, no
                      // network, and the sandbox denies same-origin so the preview
                      // cannot reach the OS's stored keys.
                      srcDoc={draft}
                      sandbox="allow-scripts allow-forms allow-modals"
                      className="h-full w-full border-0 bg-white"
                      title="Preview"
                    />
                  ) : (
                    <div className="h-full overflow-y-auto p-3"><Markdown text={draft} /></div>
                  )}
                </div>
              )}

              {pane === "console" && (
                <div className="flex min-h-0 flex-col border-l border-[var(--border)]">
                  <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border)] px-2.5 py-1.5 text-[11px]">
                    <span className="font-medium">Console</span>
                    {running && <Spinner label="running" />}
                    {runMs !== null && !running && <span className="os-chip !py-0 !text-[10px] tabular-nums">{runMs} ms</span>}
                    <span className="text-[10px] tabular-nums text-[var(--muted)]">{runLog.length} line{runLog.length === 1 ? "" : "s"}</span>
                    <div className="flex-1" />
                    <button className="os-btn !px-2 !py-0.5 text-[10.5px]" onClick={() => setRunLog([])} disabled={!runLog.length}>Clear</button>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto p-2 font-[family-name:var(--font-mono)] text-[11px]">
                    {!canRun && <div className="text-[var(--muted)]">Run works on .js and .mjs files. The script runs in a Web Worker with a {RUN_TIMEOUT_MS / 1000}s limit: no DOM, but console, timers, fetch and top-level await.</div>}
                    {canRun && !runLog.length && !running && <div className="text-[var(--muted)]">Press Run (Ctrl+Enter). console.log, warn and error land here.</div>}
                    {runLog.map((l, i) => (
                      <div key={i} className="whitespace-pre-wrap break-words border-b border-[var(--border)]/40 py-0.5" style={{ color: l.level === "error" ? "var(--danger)" : l.level === "warn" ? "var(--warning, var(--accent2))" : undefined }}>
                        {l.text}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {pane === "chat" && (
                <div className="min-h-0 overflow-y-auto border-l border-[var(--border)] p-2.5">
                  <div className="os-label mb-1.5">Snapshots ({snapshots.filter((s) => s.path === active).length})</div>
                  {snapshots.length === 0 && <div className="text-[11.5px] text-[var(--muted)]">Snapshots are taken automatically before every AI edit, format and replace-all.</div>}
                  {snapshots.filter((s) => s.path === active).map((s) => (
                    <div key={s.id} className="os-card mb-1.5 !p-2">
                      <div className="flex items-center gap-1.5">
                        <span className="min-w-0 flex-1 truncate text-[11.5px]">{s.label}</span>
                        <span className="shrink-0 text-[10px] text-[var(--muted)]">{relTime(s.ts)}</span>
                        <button className="os-btn !px-2 !py-0 text-[10px]" onClick={() => { snapshot("before revert"); setDraft(s.content); }}>Revert</button>
                      </div>
                      <div className="mt-0.5 text-[10px] text-[var(--muted)]">{s.content.split("\n").length} lines</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Pull the largest fenced block, falling back to the whole response if the
 *  model ignored the fence instruction. */
// Moved to lib so it can be tested; re-exported because AIStudio and
// WidgetBuilder import it from here.
export { extractCode };
