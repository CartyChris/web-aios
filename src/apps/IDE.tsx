"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVFS } from "@/kernel/vfs";
import { bus } from "@/kernel/bus";
import { ask } from "@/lib/useAI";
import type { AppProps } from "@/kernel/types";
import { download, relTime, uid } from "@/lib/format";
import { ErrorNote, Empty, Spinner, CopyButton, Markdown } from "./_ui";
import { cn } from "@/lib/cn";
import { Icon } from "@/shell/icons";

/* ────────────────────────────────────────────────────────────────────────────
   Code Studio — ported from MyTermz (AI Super IDE).

   Kept from the original: tabs over the shared filesystem, a live preview that
   renders the document you are editing, AI edits applied to the whole file, and
   snapshots so an AI edit is never a one-way door. Dropped: the local bridge
   and terminal, which live in the Bridge app now that they need a companion
   daemon rather than being assumed.
   ──────────────────────────────────────────────────────────────────────────── */

interface Snapshot { id: string; path: string; content: string; label: string; ts: number }

export default function IDE({ args }: AppProps) {
  const vfs = useVFS();
  const [open, setOpen] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pane, setPane] = useState<"preview" | "chat" | "none">("none");
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [instruction, setInstruction] = useState("");
  const [aiLog, setAiLog] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  const files = useMemo(
    () => Object.values(vfs.nodes).filter((n) => n.kind === "file").sort((a, b) => b.updatedAt - a.updatedAt),
    [vfs.nodes],
  );

  const openFile = useCallback((path: string) => {
    setOpen((o) => (o.includes(path) ? o : [...o, path]));
    setActive(path);
    setDraft(vfs.read(path)?.content ?? "");
  }, [vfs]);

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

  const isHtml = active?.endsWith(".html") ?? false;
  const lineCount = draft.split("\n").length;

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
          <div className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-[var(--border)] px-1.5 pt-1.5">
            {open.map((p) => (
              <div
                key={p}
                className={cn("flex shrink-0 items-center gap-1 rounded-t px-2 py-1 text-[11.5px]", active === p ? "bg-[var(--accent)]/16" : "hover:bg-white/6")}
              >
                <button onClick={() => { setActive(p); setDraft(vfs.read(p)?.content ?? ""); }}>{p.split("/").pop()}</button>
                <button
                  className="opacity-50 hover:opacity-100"
                  onClick={() => { setOpen((o) => o.filter((x) => x !== p)); if (active === p) { const next = open.filter((x) => x !== p)[0] ?? null; setActive(next); setDraft(next ? vfs.read(next)?.content ?? "" : ""); } }}
                ><Icon name="close" size={11} /></button>
              </div>
            ))}
          </div>
        )}

        {!active ? (
          <Empty icon="app" title="No file open" body="Pick a file on the left, or create one. Everything written here lands in the OS filesystem and is visible to Files, Notes and the Terminal." />
        ) : (
          <>
            <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border)] px-2.5 py-1.5">
              <span className="truncate text-[11px] text-[var(--muted)]">{active}</span>
              <span className="os-chip !text-[10px]">{lineCount} lines</span>
              <div className="flex-1" />
              {(["none", "preview", "chat"] as const).map((p) => (
                <button key={p} onClick={() => setPane(p)} className={cn("os-btn !py-1 text-[11px]", pane === p && "!border-[var(--accent)] !bg-[var(--accent)]/16")}>
                  {p === "none" ? "editor" : p}
                </button>
              ))}
              <button className="os-btn !py-1 text-[11px]" onClick={() => snapshot("manual")}>Snapshot</button>
              <CopyButton text={draft} />
              <button className="os-btn !py-1 text-[11px]" onClick={() => download(active.split("/").pop()!, draft)}>Download</button>
            </div>

            <div className="px-2.5 pt-2"><ErrorNote error={error} onDismiss={() => setError(null)} /></div>

            <div className={cn("min-h-0 flex-1", pane !== "none" && "grid grid-cols-1 lg:grid-cols-2")}>
              <div className="flex min-h-0 flex-col">
                <textarea
                  ref={taRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    // Tab must indent, not escape the editor.
                    if (e.key === "Tab") {
                      e.preventDefault();
                      const el = e.currentTarget;
                      const { selectionStart: a, selectionEnd: b } = el;
                      const next = draft.slice(0, a) + "  " + draft.slice(b);
                      setDraft(next);
                      requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
                    }
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
                      className="os-input flex-1 !py-1 text-[12px]"
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

              {pane === "chat" && (
                <div className="min-h-0 overflow-y-auto border-l border-[var(--border)] p-2.5">
                  <div className="os-label mb-1.5">Snapshots ({snapshots.length})</div>
                  {snapshots.length === 0 && <div className="text-[11.5px] text-[var(--muted)]">Snapshots are taken automatically before every AI edit.</div>}
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
export function extractCode(text: string): string | null {
  const blocks = [...text.matchAll(/```[\w-]*\n?([\s\S]*?)```/g)].map((m) => m[1]);
  if (blocks.length) return blocks.sort((a, b) => b.length - a.length)[0].replace(/\n$/, "");
  const t = text.trim();
  return t.startsWith("<") || t.startsWith("import") || t.startsWith("function") ? t : null;
}
