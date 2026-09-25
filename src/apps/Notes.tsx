"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVFS } from "@/kernel/vfs";
import { bus } from "@/kernel/bus";
import { registerContextTarget, type TargetContext } from "@/kernel/ctxmenu";
import { extractLinks, backlinks, resolveLink, textStats, searchNotes, renderWikiLinks, noteFileName, noteTitle } from "@/lib/notelinks";
import { planTrash, planRename, uniquePath } from "@/lib/vfsops";
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
  const listRef = useRef<HTMLDivElement>(null);

  // Pinned notes (the VFS `starred` flag, so Files shows the star too) sort first.
  const notes = useMemo(
    () => Object.values(vfs.nodes)
      .filter((n) => n.path.startsWith("/notes/") && n.kind === "file")
      .sort((a, b) => Number(Boolean(b.starred)) - Number(Boolean(a.starred)) || b.updatedAt - a.updatedAt),
    [vfs.nodes],
  );
  // Full-text search: title hits first, then by number of matches, with a snippet.
  const hits = useMemo(() => searchNotes(notes, q), [notes, q]);
  const hitByPath = useMemo(() => new Map(hits.map((h) => [h.path, h])), [hits]);
  const filtered = q.trim() ? hits.map((h) => notes.find((n) => n.path === h.path)!).filter(Boolean) : notes;
  const current = path ? notes.find((n) => n.path === path) : undefined;
  const stats = useMemo(() => textStats(draft), [draft]);
  const outgoing = useMemo(() => extractLinks(draft), [draft]);
  const incoming = useMemo(() => (current ? backlinks({ ...current, content: draft }, notes) : []), [current, draft, notes]);
  const previewText = useMemo(() => renderWikiLinks(draft, (t) => Boolean(resolveLink(t, notes))), [draft, notes]);
  // Autosave state is derived, not tracked: the draft either matches what is stored or it does not.
  const saved = !path || vfs.nodes[path]?.content === draft;

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

  /** Write any pending edit now, so a rename or duplicate never loses the last keystrokes. */
  const flush = useCallback(() => {
    if (path && vfs.read(path)?.content !== draft) vfs.write(path, draft, { appId: "notes" });
  }, [path, draft, vfs]);

  const openLink = useCallback((title: string) => {
    const hit = resolveLink(title, notes);
    if (hit) { flush(); setPath(hit.path); return; }
    const p = uniquePath(new Set(Object.keys(vfs.nodes)), `/notes/${noteFileName(title)}`);
    flush();
    vfs.write(p, `# ${title}\n\n`, { appId: "notes" });
    setPath(p);
  }, [notes, vfs, flush]);

  const renameNote = useCallback((from: string) => {
    const name = window.prompt("Rename note", noteTitle(from.split("/").pop() ?? ""));
    if (!name?.trim()) return;
    if (from === path) flush();
    const plan = planRename(Object.keys(vfs.nodes), from, noteFileName(name));
    if (!plan.ok) { setError(plan.reason); return; }
    for (const [a, b] of plan.pairs) vfs.rename(a, b);
    if (from === path) setPath(plan.pairs[0][1]);
  }, [vfs, path, flush]);

  const duplicateNote = useCallback((from: string) => {
    if (from === path) flush();
    const n = vfs.read(from);
    if (!n) return;
    const p = uniquePath(new Set(Object.keys(vfs.nodes)), from);
    vfs.write(p, n.content, { appId: "notes" });
    setPath(p);
  }, [vfs, path, flush]);

  // Soft delete: into the trash, restorable from Files.
  const trashNote = useCallback((from: string) => {
    const plan = planTrash(Object.keys(vfs.nodes), from, Date.now());
    if (!plan.ok) { setError(plan.reason); return; }
    for (const [a, b] of plan.pairs) vfs.rename(a, b);
    if (from === path) setPath(null);
    bus.emit("notify", { title: "Note moved to the trash", body: "Restore it from Files > Trash.", kind: "info" });
  }, [vfs, path]);

  const summarize = useCallback((from: string) => {
    const n = vfs.read(from);
    if (!n) return;
    const text = from === path ? draft : n.content;
    bus.emit("aios-chat:ask", {
      prompt: `Summarize my note "${noteTitle(n.name)}" in a few bullet points, then list any open questions or to-dos it contains.`,
      context: { label: `the note ${n.path}`, text: text.slice(0, 20000) || "(the note is empty)" },
    });
  }, [vfs, path, draft]);

  useEffect(() => {
    const el = listRef.current?.parentElement;
    if (!el) return;
    return registerContextTarget(el, ({ target }: TargetContext) => {
      const host = target.closest("[data-note-path]") as HTMLElement | null;
      const p = host?.dataset.notePath ?? (target.closest("[data-note-editor]") ? path : null);
      if (!p) return { id: "notes-bg", entries: [{ id: "new", label: "New note", icon: "plus", run: create }] };
      const n = vfs.read(p);
      if (!n) return null;
      return {
        id: "notes-note",
        entries: [
          { id: "open", label: "Open", icon: "notes", disabled: p === path, run: () => { flush(); setPath(p); } },
          { id: "rename", label: "Rename...", icon: "wand", run: () => renameNote(p) },
          { id: "pin", label: n.starred ? "Unpin" : "Pin to top", icon: "pin", checked: Boolean(n.starred), run: () => vfs.star(p) },
          { id: "dup", label: "Duplicate", icon: "copy", run: () => duplicateNote(p) },
          { id: "export", label: "Export .md", icon: "download", run: () => download(n.name, p === path ? draft : n.content, "text/markdown") },
          { id: "ask", label: "Ask AI to summarize", icon: "spark", run: () => summarize(p) },
          { separator: true },
          { id: "trash", label: "Move to trash", icon: "trash", danger: true, run: () => trashNote(p) },
        ],
      };
    });
  }, [vfs, path, draft, create, flush, renameNote, duplicateNote, summarize, trashNote]);

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
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search all notes…" aria-label="Search the text of every note" className="os-input !py-1 text-[11px]" />
          {q.trim() && <div className="px-0.5 text-[10px] text-[var(--muted)]">{hits.length} note{hits.length === 1 ? "" : "s"} match</div>}
        </div>
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
          {filtered.map((n) => (
            <div
              key={n.path}
              data-note-path={n.path}
              onClick={() => { flush(); setPath(n.path); }}
              className={cn("group mb-1 cursor-pointer rounded-[calc(var(--radius)*0.6)] px-2 py-1.5",
                n.path === path ? "bg-[var(--accent)]/16 ring-1 ring-[var(--accent)]/40" : "hover:bg-white/6")}
            >
              <div className="flex items-center gap-1">
                {n.starred && <Icon name="pin" size={10} className="shrink-0 text-[var(--accent)]" />}
                <span className="min-w-0 flex-1 truncate text-[12px]">{n.name.replace(/\.md$/, "")}</span>
                <button
                  className="text-[10px] opacity-0 group-hover:opacity-60 hover:!opacity-100 focus:opacity-100"
                  aria-label={n.starred ? `Unpin ${noteTitle(n.name)}` : `Pin ${noteTitle(n.name)}`}
                  title={n.starred ? "Unpin" : "Pin to top"}
                  onClick={(e) => { e.stopPropagation(); vfs.star(n.path); }}
                ><Icon name="pin" size={11} /></button>
                <button
                  className="text-[10px] opacity-0 group-hover:opacity-60 hover:!opacity-100 focus:opacity-100"
                  aria-label={`Move ${noteTitle(n.name)} to the trash`}
                  title="Move to trash"
                  onClick={(e) => { e.stopPropagation(); trashNote(n.path); }}
                ><Icon name="close" size={11} /></button>
              </div>
              <div className="text-[10px] text-[var(--muted)]">{relTime(n.updatedAt)}{hitByPath.get(n.path)?.count ? ` · ${hitByPath.get(n.path)!.count} match${hitByPath.get(n.path)!.count === 1 ? "" : "es"}` : ""}</div>
              {hitByPath.get(n.path)?.snippet && <div className="mt-0.5 line-clamp-2 text-[10px] text-[var(--muted)]">{hitByPath.get(n.path)!.snippet}</div>}
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
              <span className="os-chip !text-[10px]" aria-live="polite" title={saved ? "Every change is saved to the OS filesystem" : "Saving shortly after you stop typing"}>
                <Icon name={saved ? "check" : "save"} size={10} /> {saved ? "Saved" : "Saving..."}
              </span>
              {busy && <Spinner label="Editing…" />}
              <button className="os-btn !py-1 text-[11px]" onClick={() => improve("Tighten this. Remove filler, keep every fact. Preserve structure.")} disabled={busy}>Tighten</button>
              <button className="os-btn !py-1 text-[11px]" onClick={() => improve("Expand this with the detail a reader would need. Do not invent facts — mark anything uncertain.")} disabled={busy}>Expand</button>
              <button className="os-btn !py-1 text-[11px]" onClick={() => download(path.split("/").pop()!, draft, "text/markdown")}>Export</button>
              <button className="os-btn !py-1 text-[11px]" onClick={() => summarize(path)} title="Send this note to AIOS Chat">Summarize</button>
            </div>
            <div className="min-h-0 flex-1 px-1">
              <ErrorNote error={error} onDismiss={() => setError(null)} />
              <div className={cn("h-full", mode === "split" && "grid grid-cols-1 md:grid-cols-2 gap-2")}>
                {mode !== "preview" && (
                  <textarea
                    data-note-editor
                    aria-label="Note text"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    className="h-full w-full resize-none bg-transparent p-2.5 font-[family-name:var(--font-mono)] text-[12.5px] leading-relaxed outline-none"
                    spellCheck={false}
                    placeholder="Write in markdown…"
                  />
                )}
                {mode !== "edit" && (
                  <div className="h-full overflow-y-auto p-2.5"><Markdown text={previewText} /></div>
                )}
              </div>
            </div>
            {/* Links out of this note, links into it, and live counts. */}
            <div className="flex shrink-0 flex-wrap items-center gap-1 border-t border-[var(--border)] px-2.5 py-1 text-[10.5px] text-[var(--muted)]">
              <span className="tabular-nums" data-testid="notes-wordcount">{stats.words} word{stats.words === 1 ? "" : "s"} · {stats.chars} chars{stats.readingMin ? ` · ${stats.readingMin} min read` : ""}</span>
              {outgoing.length > 0 && <span className="ml-2">Links:</span>}
              {outgoing.map((t) => {
                const exists = Boolean(resolveLink(t, notes));
                return (
                  <button key={t} className={cn("os-chip !py-0 !text-[10px]", !exists && "opacity-60")} onClick={() => openLink(t)} title={exists ? `Open ${t}` : `Create a note called ${t}`}>
                    {exists ? t : `+ ${t}`}
                  </button>
                );
              })}
              {incoming.length > 0 && <span className="ml-2">Linked from:</span>}
              {incoming.map((n) => (
                <button key={n.path} className="os-chip !py-0 !text-[10px]" onClick={() => { flush(); setPath(n.path); }}>{noteTitle(n.name)}</button>
              ))}
              {outgoing.length === 0 && incoming.length === 0 && <span className="ml-2 opacity-70">Link notes with [[Title]]</span>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
