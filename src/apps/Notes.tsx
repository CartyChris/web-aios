"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useVFS } from "@/kernel/vfs";
import { ask } from "@/lib/useAI";
import type { AppProps } from "@/kernel/types";
import { download, relTime } from "@/lib/format";
import { Markdown, ErrorNote, Empty, Spinner } from "./_ui";
import { cn } from "@/lib/cn";
import { Icon } from "@/shell/icons";

/** Notes — markdown editor over the OS filesystem, so anything written here is
 *  immediately visible to Files, the Terminal and the command palette. */
export default function Notes({ args }: AppProps) {
  const vfs = useVFS();
  const [path, setPath] = useState<string | null>((args?.path as string) ?? null);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<"edit" | "split" | "preview">("split");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const notes = useMemo(
    () => Object.values(vfs.nodes).filter((n) => n.path.startsWith("/notes/") && n.kind === "file").sort((a, b) => b.updatedAt - a.updatedAt),
    [vfs.nodes],
  );
  const filtered = q.trim() ? notes.filter((n) => (n.name + n.content).toLowerCase().includes(q.toLowerCase())) : notes;

  // Adjusting state during render is React's documented way to reset state
  // when an input changes — cheaper and less error-prone than an effect,
  // which would paint the previous note's text for one frame first.
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  if (path !== loadedPath) {
    setLoadedPath(path);
    setDraft(path ? vfs.read(path)?.content ?? "" : "");
  }

  // Debounced autosave: typing should never require a save button, but writing
  // on every keystroke thrashes localStorage.
  useEffect(() => {
    if (!path) return;
    const t = setTimeout(() => vfs.write(path, draft, { appId: "notes" }), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, path]);

  const create = useCallback(() => {
    const name = `note-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.md`;
    const p = `/notes/${name}`;
    vfs.write(p, "# New note\n\n", { appId: "notes" });
    setPath(p);
    setDraft("# New note\n\n");
  }, [vfs]);

  const improve = useCallback(async (instruction: string) => {
    if (!draft.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      const res = await ask({
        messages: [{ role: "user", content: `${instruction}\n\n---\n\n${draft}` }],
        system: "You edit markdown documents. Return ONLY the complete revised markdown, with no preamble and no code fence around the whole document.",
        maxTokens: 3000,
      });
      setDraft(res.text.replace(/^```(?:markdown|md)?\n?/, "").replace(/\n?```$/, ""));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed.");
    } finally { setBusy(false); }
  }, [draft, busy]);

  return (
    <div className="app-split flex h-full">
      <div className="app-sidebar flex w-48 shrink-0 flex-col overflow-y-auto border-r border-[var(--border)]">
        <div className="space-y-1.5 p-2">
          <button className="os-btn w-full !py-1 text-[11px]" data-variant="primary" onClick={create}>+ New note</button>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="os-input !py-1 text-[11px]" />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
          {filtered.map((n) => (
            <div
              key={n.path}
              onClick={() => setPath(n.path)}
              className={cn("group mb-1 cursor-pointer rounded-[calc(var(--radius)*0.6)] px-2 py-1.5",
                n.path === path ? "bg-[var(--accent)]/16 ring-1 ring-[var(--accent)]/40" : "hover:bg-white/6")}
            >
              <div className="flex items-center gap-1">
                <span className="min-w-0 flex-1 truncate text-[12px]">{n.name.replace(/\.md$/, "")}</span>
                <button
                  className="text-[10px] opacity-0 group-hover:opacity-60 hover:!opacity-100"
                  onClick={(e) => { e.stopPropagation(); vfs.remove(n.path); if (n.path === path) setPath(null); }}
                ><Icon name="close" size={11} /></button>
              </div>
              <div className="text-[10px] text-[var(--muted)]">{relTime(n.updatedAt)}</div>
            </div>
          ))}
          {filtered.length === 0 && <div className="px-2 py-6 text-center text-[11px] text-[var(--muted)]">No notes</div>}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {!path ? (
          <Empty icon="notes" title="No note open" body="Create one on the left. Notes are stored in the OS filesystem at /notes and are searchable from the command palette." />
        ) : (
          <>
            <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border)] px-2.5 py-1.5">
              {(["edit", "split", "preview"] as const).map((m) => (
                <button key={m} onClick={() => setMode(m)} className={cn("os-btn !py-1 text-[11px]", mode === m && "!border-[var(--accent)] !bg-[var(--accent)]/16")}>{m}</button>
              ))}
              <div className="flex-1" />
              {busy && <Spinner label="Editing…" />}
              <button className="os-btn !py-1 text-[11px]" onClick={() => improve("Tighten this. Remove filler, keep every fact. Preserve structure.")} disabled={busy}>Tighten</button>
              <button className="os-btn !py-1 text-[11px]" onClick={() => improve("Expand this with the detail a reader would need. Do not invent facts — mark anything uncertain.")} disabled={busy}>Expand</button>
              <button className="os-btn !py-1 text-[11px]" onClick={() => download(path.split("/").pop()!, draft, "text/markdown")}>Export</button>
            </div>
            <div className="min-h-0 flex-1 px-1">
              <ErrorNote error={error} onDismiss={() => setError(null)} />
              <div className={cn("h-full", mode === "split" && "grid grid-cols-1 md:grid-cols-2 gap-2")}>
                {mode !== "preview" && (
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    className="h-full w-full resize-none bg-transparent p-2.5 font-[family-name:var(--font-mono)] text-[12.5px] leading-relaxed outline-none"
                    spellCheck={false}
                    placeholder="Write in markdown…"
                  />
                )}
                {mode !== "edit" && (
                  <div className="h-full overflow-y-auto p-2.5"><Markdown text={draft} /></div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
