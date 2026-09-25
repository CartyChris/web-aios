"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVFS, type VNode } from "@/kernel/vfs";
import { useWM } from "@/kernel/wm";
import { bus } from "@/kernel/bus";
import { registerContextTarget, type TargetContext } from "@/kernel/ctxmenu";
import type { Entry, MenuSection } from "@/lib/ctxmenu";
import type { AppProps } from "@/kernel/types";
import { bytes, relTime, download } from "@/lib/format";
import { downloadZip } from "@/lib/zip";
import {
  TRASH, breadcrumbs, childrenOf, sortEntries, planMove, planRename, planTrash, planRestore, listTrash,
  uniquePath, previewKind, imageSrc, isTrashed, dirOf, joinPath, type DirEntry, type Plan, type SortKey,
} from "@/lib/vfsops";
import { Empty, ErrorNote, CopyButton, Markdown } from "./_ui";
import { cn } from "@/lib/cn";
import { Icon } from "@/shell/icons";

const DRAG_TYPE = "application/x-aios-paths";
const notify = (title: string, kind: "success" | "warn" | "info" = "success") => bus.emit("notify", { title, kind });
type View = "list" | "grid" | "groups";

/** Files — one view over everything every app has stored.
 *
 *  Browse by folder (breadcrumbs, list or grid, sort), select several, drag
 *  onto a folder to move, preview in place, and delete to a trash that can be
 *  restored from. Nothing here deletes permanently: "Move to trash" is a
 *  rename into /.trash, and Restore is the inverse rename (src/lib/vfsops.ts). */
export default function Files({}: AppProps) {
  const vfs = useVFS();
  const wm = useWM();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [cwd, setCwd] = useState("/");
  const [view, setView] = useState<View>("list");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const allNodes = useMemo(() => Object.values(vfs.nodes), [vfs.nodes]);
  const allPaths = useMemo(() => allNodes.map((n) => n.path), [allNodes]);
  // Trashed files are out of every normal view, the usage chip included.
  const all = useMemo(() => allNodes.filter((n) => n.kind === "file" && !isTrashed(n.path)), [allNodes]);
  const trash = useMemo(() => listTrash(allPaths), [allPaths]);
  const inTrash = cwd === TRASH || cwd.startsWith(TRASH + "/");

  const folders = useMemo(() => {
    const map = new Map<string, VNode[]>();
    for (const n of all) {
      const dir = n.path.split("/").slice(0, -1).join("/") || "/";
      if (!map.has(dir)) map.set(dir, []);
      map.get(dir)!.push(n);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [all]);

  const entries = useMemo(
    () => sortEntries(childrenOf(allNodes, cwd), sortKey, sortDir),
    [allNodes, cwd, sortKey, sortDir],
  );

  const filtered = q.trim()
    ? all.filter((n) => (n.path + n.content).toLowerCase().includes(q.toLowerCase())).sort((a, b) => b.updatedAt - a.updatedAt)
    : null;

  const bytesUsed = all.reduce((a, n) => a + n.size, 0);
  const node = sel ? vfs.read(sel) : undefined;

  /** Apply a planned set of renames, or surface why it was refused. */
  const apply = useCallback((plan: Plan): boolean => {
    if (!plan.ok) { setError(plan.reason); return false; }
    for (const [from, to] of plan.pairs) vfs.rename(from, to);
    return true;
  }, [vfs]);

  const importFiles = useCallback(
    async (files: FileList | null) => {
      if (!files?.length) return;
      let n = 0;
      const target = inTrash ? "/imported" : cwd === "/" ? "/imported" : cwd;
      for (const f of Array.from(files)) {
        if (f.size > 2 * 1024 * 1024) { setError(`${f.name} is over the 2 MB per-file limit for browser storage.`); continue; }
        try {
          // Images are kept as data URLs so the preview can show them; text is kept as text.
          if (f.type.startsWith("image/")) {
            const url = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(f); });
            vfs.write(joinPath(target, f.name), url, { appId: "files", mime: f.type });
            n++;
            continue;
          }
          const text = await f.text();
          // A previously exported backup is restored rather than stored as one blob.
          if (f.name.endsWith(".json") && text.includes("__webaios")) {
            const parsed = JSON.parse(text);
            if (parsed.vfs?.nodes || parsed.nodes) { n += vfs.importAll(JSON.stringify(parsed.vfs ?? parsed)); continue; }
          }
          vfs.write(joinPath(target, f.name), text, { appId: "files" });
          n++;
        } catch { setError(`${f.name} could not be read.`); }
      }
      if (n) notify(`Imported ${n} file${n === 1 ? "" : "s"}`);
    },
    [vfs, cwd, inTrash],
  );

  const openIn = useCallback((path: string, appId?: string) => {
    const app = appId ?? (path.endsWith(".md") || path.endsWith(".txt") ? "notes" : "ide");
    wm.open(app, { title: path.split("/").pop(), icon: app, args: { path } });
  }, [wm]);

  const openEntry = useCallback((e: { path: string; kind: "file" | "dir" }) => {
    if (e.kind === "dir") { setCwd(e.path); setPicked([]); setSel(null); }
    else openIn(e.path);
  }, [openIn]);

  const trashPaths = useCallback((paths: string[]) => {
    let n = 0;
    const stamp = Date.now();
    for (const [i, p] of paths.entries()) {
      // Each entry gets its own stamp so two trashed things never collide.
      const plan = planTrash(Object.keys(useVFS.getState().nodes), p, stamp + i);
      if (apply(plan)) n++;
    }
    if (n) notify(`Moved ${n} item${n === 1 ? "" : "s"} to the trash`, "info");
    setPicked([]);
    if (sel && paths.some((p) => sel === p || sel.startsWith(p + "/"))) setSel(null);
  }, [apply, sel]);

  const restore = useCallback((trashPath: string) => {
    const plan = planRestore(Object.keys(useVFS.getState().nodes), trashPath);
    if (apply(plan) && plan.ok) notify(`Restored to ${plan.pairs[0][1].split("/").slice(0, -1).join("/") || "/"}`);
  }, [apply]);

  const moveInto = useCallback((paths: string[], dir: string) => {
    let n = 0;
    for (const p of paths) {
      if (p === dir) continue;
      if (apply(planMove(Object.keys(useVFS.getState().nodes), p, dir))) n++;
    }
    if (n) notify(`Moved ${n} item${n === 1 ? "" : "s"} to ${dir}`);
    setPicked([]);
  }, [apply]);

  const promptMove = useCallback((paths: string[]) => {
    const dir = window.prompt("Move to which folder?", cwd === "/" ? "/" : cwd);
    if (dir) moveInto(paths, dir.startsWith("/") ? dir : `/${dir}`);
  }, [cwd, moveInto]);

  const duplicate = useCallback((path: string) => {
    const st = useVFS.getState();
    const existing = new Set(Object.keys(st.nodes));
    const dest = uniquePath(existing, path);
    const subtree = Object.values(st.nodes).filter((n) => n.path === path || n.path.startsWith(path + "/"));
    for (const n of subtree) {
      if (n.kind === "dir") st.mkdir(dest + n.path.slice(path.length));
      else st.write(dest + n.path.slice(path.length), n.content, { mime: n.mime, appId: n.appId, tags: n.tags });
    }
    notify(`Duplicated as ${dest.split("/").pop()}`);
  }, []);

  const copyText = useCallback(async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); notify(`${what} copied`); }
    catch { setError("The browser refused clipboard access."); }
  }, []);

  const downloadEntry = useCallback((path: string) => {
    const st = useVFS.getState();
    const n = st.nodes[path];
    if (n && n.kind === "file") { download(n.name, n.content, n.mime); return; }
    const files = Object.values(st.nodes).filter((x) => x.kind === "file" && x.path.startsWith(path + "/"));
    downloadZip(path.split("/").pop() || "folder", files.map((x) => ({ path: x.path.slice(path.length + 1), content: x.content })));
  }, []);

  const commitRename = useCallback((from: string, name: string) => {
    setRenaming(null);
    if (!name.trim() || name === from.split("/").pop()) return;
    const plan = planRename(Object.keys(useVFS.getState().nodes), from, name);
    if (apply(plan) && plan.ok) {
      const to = joinPath(dirOf(from), name.trim());
      if (sel === from) setSel(to);
    }
  }, [apply, sel]);

  /** Click semantics: plain = select one and preview; Cmd/Ctrl = toggle; Shift = range. */
  const clickEntry = useCallback((e: React.MouseEvent, entry: { path: string; kind: "file" | "dir" }, order: string[]) => {
    if (e.metaKey || e.ctrlKey) {
      setPicked((p) => (p.includes(entry.path) ? p.filter((x) => x !== entry.path) : [...p, entry.path]));
      setAnchor(entry.path);
      return;
    }
    if (e.shiftKey && anchor) {
      const a = order.indexOf(anchor), b = order.indexOf(entry.path);
      if (a !== -1 && b !== -1) { setPicked(order.slice(Math.min(a, b), Math.max(a, b) + 1)); return; }
    }
    setPicked([entry.path]);
    setAnchor(entry.path);
    if (entry.kind === "file") setSel(entry.path);
  }, [anchor]);

  const onDragStartEntry = (e: React.DragEvent, path: string) => {
    const paths = picked.includes(path) ? picked : [path];
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(paths));
    e.dataTransfer.effectAllowed = "move";
  };
  const dropProps = (dir: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.stopPropagation();
      setDropTarget(dir);
    },
    onDragLeave: () => setDropTarget((d) => (d === dir ? null : d)),
    onDrop: (e: React.DragEvent) => {
      const raw = e.dataTransfer.getData(DRAG_TYPE);
      setDropTarget(null);
      if (!raw) return;
      e.preventDefault();
      e.stopPropagation();
      try { moveInto(JSON.parse(raw) as string[], dir); } catch { /* not ours */ }
    },
  });

  /* Right-click: the entry under the pointer (or the whole selection when the
     pointer is on a selected entry), else the folder background. */
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    return registerContextTarget(el, ({ target }: TargetContext): MenuSection | null => {
      const host = target.closest("[data-vfs-path]") as HTMLElement | null;
      const path = host?.dataset.vfsPath;
      const kind = (host?.dataset.vfsKind as "file" | "dir" | undefined) ?? "file";
      const trashEntry = host?.dataset.trashEntry;
      if (trashEntry) {
        return { id: "files-trash", entries: [
          { id: "restore", label: "Restore", icon: "backup", run: () => restore(trashEntry) },
          { id: "dl", label: "Download", icon: "download", run: () => downloadEntry(trashEntry) },
        ] };
      }
      if (!path) {
        if (inTrash) return null;
        return { id: "files-bg", entries: [
          { id: "newfolder", label: "New folder", icon: "folder", run: () => {
            const name = window.prompt("Folder name");
            if (name?.trim()) vfs.mkdir(uniquePath(new Set(Object.keys(useVFS.getState().nodes)), joinPath(cwd, name.trim())));
          } },
          { id: "newfile", label: "New text file", icon: "file", run: () => {
            const p = uniquePath(new Set(Object.keys(useVFS.getState().nodes)), joinPath(cwd === "/" ? "/notes" : cwd, "untitled.md"));
            vfs.write(p, "", { appId: "files" });
            setSel(p);
          } },
          { id: "import", label: "Import files...", icon: "download", run: () => fileInput.current?.click() },
          { id: "trash", label: `Show trash (${trash.length})`, icon: "trash", run: () => setCwd(TRASH) },
        ] };
      }
      const many = picked.includes(path) && picked.length > 1 ? picked : null;
      if (many) {
        return { id: "files-many", entries: [
          { id: "move", label: `Move ${many.length} items...`, icon: "folder", run: () => promptMove(many) },
          { id: "zip", label: `Download ${many.length} as .zip`, icon: "download", run: () => {
            const st = useVFS.getState();
            const files = Object.values(st.nodes).filter((x) => x.kind === "file" && many.some((p) => x.path === p || x.path.startsWith(p + "/")));
            downloadZip("selection", files.map((x) => ({ path: x.path.replace(/^\//, ""), content: x.content })));
          } },
          { id: "trash", label: `Move ${many.length} items to trash`, icon: "trash", danger: true, run: () => trashPaths(many) },
        ] };
      }
      const openWith: Entry[] = [
        { id: "notes", label: "Notes", icon: "notes", run: () => openIn(path, "notes") },
        { id: "ide", label: "IDE", icon: "ide", run: () => openIn(path, "ide") },
        { id: "chat", label: "AIOS Chat (summarize)", icon: "chat", run: () => {
          const n = useVFS.getState().read(path);
          if (n) bus.emit("aios-chat:ask", { prompt: `Summarize the file ${n.name}.`, context: { label: n.path, text: n.content.slice(0, 20000) } });
        } },
      ];
      return { id: "files-entry", entries: [
        { id: "open", label: kind === "dir" ? "Open folder" : "Open", icon: kind === "dir" ? "folder" : "external", run: () => openEntry({ path, kind }) },
        ...(kind === "file" ? [{ id: "openwith", label: "Open with", icon: "app", submenu: openWith } as Entry] : []),
        { separator: true },
        { id: "rename", label: "Rename", icon: "wand", run: () => setRenaming(path) },
        { id: "move", label: "Move to...", icon: "folder", run: () => promptMove([path]) },
        { id: "dup", label: "Duplicate", icon: "copy", run: () => duplicate(path) },
        { id: "copypath", label: "Copy path", icon: "link", run: () => copyText(path, "Path") },
        { id: "dl", label: kind === "dir" ? "Download as .zip" : "Download", icon: "download", run: () => downloadEntry(path) },
        { separator: true },
        { id: "trash", label: "Move to trash", icon: "trash", danger: true, run: () => trashPaths([path]) },
      ] };
    });
  }, [vfs, cwd, inTrash, picked, trash.length, openIn, openEntry, promptMove, duplicate, copyText, downloadEntry, trashPaths, restore]);

  const crumbs = breadcrumbs(cwd);
  const order = entries.map((e) => e.path);

  return (
    <div ref={rootRef} className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border)] px-2.5 py-1.5">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search names and contents…" className="os-input min-w-32 flex-1 !py-1 text-[12px]" />
        <button className="os-btn !py-1 text-[11px]" onClick={() => fileInput.current?.click()}>Import</button>
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => { importFiles(e.target.files); e.target.value = ""; }} />
        <button
          className="os-btn !py-1 text-[11px]"
          title="Every file, as a real folder tree you can open"
          onClick={() =>
            downloadZip(`web-aios-files-${new Date().toISOString().slice(0, 10)}`, [
              ...all.map((n) => ({ path: n.path.replace(/^\//, ""), content: n.content })),
              {
                path: "README.md",
                content: `# Web-AIOS files\n\n${all.length} file(s), exported ${new Date().toISOString()}.\n\nThis is the OS filesystem as a plain folder tree — everything your apps wrote:\nchats, research briefs, plans, notes, code and generated projects.\n\nTo bring it back, use Files -> Import with backup.json.\n`,
              },
              { path: "backup.json", content: vfs.exportAll() },
            ])
          }
        >
          Export all (.zip)
        </button>
        <button className="os-btn !py-1 text-[11px]" onClick={() => download(`web-aios-files-${Date.now()}.json`, vfs.exportAll(), "application/json")}>.json</button>
        <span className="os-chip" data-testid="files-usage">{all.length} files · {bytes(bytesUsed)}</span>
      </div>

      {/* Location bar: breadcrumbs (each a drop target), view, sort, trash. */}
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--border)] px-2.5 py-1">
        <nav aria-label="Folder path" className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5 text-[11.5px]">
          {crumbs.map((c, i) => (
            <span key={c.path} className="flex items-center">
              {i > 0 && <Icon name="chevronRight" size={10} className="text-[var(--muted)]" />}
              <button
                className={cn("rounded px-1.5 py-0.5 hover:bg-white/8", i === crumbs.length - 1 && "font-medium", dropTarget === c.path && "ring-1 ring-[var(--accent)]")}
                onClick={() => { setCwd(c.path); setPicked([]); }}
                aria-label={`Go to ${c.path}`}
                {...dropProps(c.path)}
              >
                {c.path === TRASH ? "Trash" : c.label}
              </button>
            </span>
          ))}
        </nav>
        {!inTrash && (
          <>
            <select aria-label="Sort by" value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)} className="os-input !w-auto !py-0.5 text-[11px]">
              <option value="name">Name</option><option value="modified">Modified</option><option value="size">Size</option>
            </select>
            <button className="os-btn !px-2 !py-0.5 text-[11px]" aria-label={sortDir === "asc" ? "Sort descending" : "Sort ascending"} onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}>
              <Icon name={sortDir === "asc" ? "arrowUp" : "arrowDown"} size={11} />
            </button>
            <div className="flex overflow-hidden rounded-[calc(var(--radius)*0.5)] border border-[var(--border)]" role="group" aria-label="View">
              {(["list", "grid", "groups"] as const).map((v) => (
                <button key={v} aria-label={`${v} view`} aria-pressed={view === v} onClick={() => setView(v)} className={cn("px-2 py-0.5 text-[11px]", view === v ? "bg-[var(--accent)]/20" : "hover:bg-white/6")}>
                  <Icon name={v === "list" ? "menu" : v === "grid" ? "grid" : "layers"} size={11} />
                </button>
              ))}
            </div>
          </>
        )}
        <button className={cn("os-btn !py-0.5 text-[11px]", inTrash && "!border-[var(--accent)]")} onClick={() => { setCwd(inTrash ? "/" : TRASH); setPicked([]); setSel(null); }} aria-label={inTrash ? "Leave trash" : "Open trash"}>
          <Icon name="trash" size={11} /> {inTrash ? "Back" : `Trash${trash.length ? ` (${trash.length})` : ""}`}
        </button>
      </div>

      {picked.length > 1 && !inTrash && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border)] bg-[var(--accent)]/8 px-2.5 py-1 text-[11px]">
          <span>{picked.length} selected</span>
          <div className="flex-1" />
          <button className="os-btn !py-0.5 text-[11px]" onClick={() => promptMove(picked)}>Move to...</button>
          <button className="os-btn !py-0.5 text-[11px]" onClick={() => trashPaths(picked)}>Move to trash</button>
          <button className="os-btn !py-0.5 text-[11px]" onClick={() => setPicked([])}>Clear</button>
        </div>
      )}

      <div className="px-2.5 pt-2"><ErrorNote error={error} onDismiss={() => setError(null)} /></div>

      <div className="app-split flex min-h-0 flex-1">
        <div
          className="min-w-0 flex-1 overflow-y-auto p-2.5"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); if (!e.dataTransfer.types.includes(DRAG_TYPE)) importFiles(e.dataTransfer.files); }}
          onClick={(e) => { if (e.target === e.currentTarget) setPicked([]); }}
        >
          {inTrash ? (
            trash.length === 0 ? (
              <Empty icon="trash" title="The trash is empty" body="Anything you move to the trash from Files or Notes lands here, and can be restored to where it came from." />
            ) : (
              <div className="space-y-0.5">
                <div className="mb-1.5 text-[10.5px] text-[var(--muted)]">Items stay here until you restore them. Nothing in the trash is ever deleted automatically.</div>
                {trash.map((t) => (
                  <div key={t.path} data-vfs-path={t.path} data-trash-entry={t.path} className="flex items-center gap-2 rounded-[calc(var(--radius)*0.5)] px-2 py-1.5 hover:bg-white/6">
                    <Icon name="trash" size={13} className="text-[var(--muted)]" />
                    <span className="min-w-0 flex-1 truncate text-[12px]" title={t.original}>{t.original}</span>
                    <span className="hidden shrink-0 text-[10px] text-[var(--muted)] sm:inline">{relTime(t.trashedAt)}</span>
                    <button className="os-btn !py-0.5 text-[11px]" onClick={() => restore(t.path)} aria-label={`Restore ${t.original}`}>Restore</button>
                  </div>
                ))}
              </div>
            )
          ) : all.length === 0 && entries.length === 0 ? (
            <Empty icon="files" title="No files yet" body="Apps write here as you use them — chats, research briefs, plans, notes and code. You can also drag files in from your computer." />
          ) : filtered ? (
            <FileList nodes={filtered} sel={sel} onSelect={setSel} onOpen={openIn} />
          ) : view === "groups" ? (
            folders.map(([dir, nodes]) => (
              <div key={dir} className="mb-3">
                <div className="os-label mb-1">{dir === "/" ? "/ (root)" : dir}</div>
                <FileList nodes={nodes.sort((a, b) => b.updatedAt - a.updatedAt)} sel={sel} onSelect={setSel} onOpen={openIn} />
              </div>
            ))
          ) : entries.length === 0 ? (
            <div className="py-8 text-center text-[11px] text-[var(--muted)]">This folder is empty.</div>
          ) : (
            <div className={cn(view === "grid" ? "grid gap-1.5" : "space-y-0.5")} style={view === "grid" ? { gridTemplateColumns: "repeat(auto-fill, minmax(92px, 1fr))" } : undefined}>
              {entries.map((e) => (
                <EntryRow
                  key={e.path}
                  entry={e}
                  grid={view === "grid"}
                  picked={picked.includes(e.path)}
                  active={sel === e.path}
                  renaming={renaming === e.path}
                  dropping={dropTarget === e.path}
                  onClick={(ev) => clickEntry(ev, e, order)}
                  onOpen={() => openEntry(e)}
                  onRename={(name) => commitRename(e.path, name)}
                  onCancelRename={() => setRenaming(null)}
                  onDragStart={(ev) => onDragStartEntry(ev, e.path)}
                  drop={e.kind === "dir" ? dropProps(e.path) : undefined}
                />
              ))}
            </div>
          )}
        </div>

        {node && !inTrash && (
          <div className="app-aside flex w-80 shrink-0 flex-col overflow-hidden border-l border-[var(--border)]">
            <div className="flex items-center gap-1.5 border-b border-[var(--border)] p-2">
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{node.name}</span>
              <button className="os-btn !px-2 !py-0.5 text-[11px]" aria-label="Close preview" onClick={() => setSel(null)}><Icon name="close" size={11} /></button>
            </div>
            <div className="space-y-1 border-b border-[var(--border)] p-2 text-[11px] text-[var(--muted)]">
              <div className="break-all">{node.path}</div>
              <div>{node.mime} · {bytes(node.size)}</div>
              <div>Modified {relTime(node.updatedAt)}{node.appId ? ` by ${node.appId}` : ""}</div>
            </div>
            <div className="flex flex-wrap gap-1.5 border-b border-[var(--border)] p-2">
              <button className="os-btn !py-1 text-[11px]" onClick={() => openIn(node.path)}>Open</button>
              <CopyButton text={node.content} />
              <button className="os-btn !py-1 text-[11px]" onClick={() => download(node.name, node.content, node.mime)}>Download</button>
              <button className="os-btn !py-1 text-[11px]" title="This file and everything beside it in its folder" onClick={() => {
                const dir = node.path.split("/").slice(0, -1).join("/") || "/";
                const siblings = all.filter((n) => (n.path.split("/").slice(0, -1).join("/") || "/") === dir);
                downloadZip((dir.split("/").pop() || "folder"), siblings.map((n) => ({ path: n.name, content: n.content })));
              }}>Folder .zip</button>
              <button className="os-btn !py-1 text-[11px]" title="Soft delete — restore it from the trash" onClick={() => trashPaths([node.path])}>Move to trash</button>
            </div>
            <Preview key={node.path} node={node} />
          </div>
        )}
      </div>
    </div>
  );
}

/** Markdown rendered, HTML in a sandbox with scripts but WITHOUT
 *  allow-same-origin (so it cannot read this origin's storage, where the keys
 *  live), images from data URLs only, everything else as text. */
function Preview({ node }: { node: VNode }) {
  const kind = previewKind(node.path, node.mime, node.content);
  const [raw, setRaw] = useState(false);
  const src = kind === "image" ? imageSrc(node.path, node.content) : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {kind !== "text" && (
        <div className="flex shrink-0 items-center gap-1 px-2 pt-1.5 text-[10.5px] text-[var(--muted)]">
          <span className="flex-1">Preview: {kind}</span>
          <button className="os-btn !px-1.5 !py-0 text-[10.5px]" aria-pressed={raw} onClick={() => setRaw((r) => !r)}>{raw ? "Rendered" : "Source"}</button>
        </div>
      )}
      {kind === "markdown" && !raw ? (
        <div className="min-h-0 flex-1 overflow-auto p-2"><Markdown text={node.content.slice(0, 50000)} /></div>
      ) : kind === "html" && !raw ? (
        <iframe title={`Preview of ${node.name}`} sandbox="allow-scripts" srcDoc={node.content} className="min-h-0 w-full flex-1 border-0 bg-white" />
      ) : kind === "image" && !raw && src ? (
        <div className="grid min-h-0 flex-1 place-items-center overflow-auto p-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={node.name} className="max-h-full max-w-full object-contain" />
        </div>
      ) : (
        <pre className="min-h-0 flex-1 overflow-auto p-2 font-[family-name:var(--font-mono)] text-[11px] leading-relaxed whitespace-pre-wrap break-words">
          {node.content.slice(0, 20000)}
          {node.content.length > 20000 && "\n\n… truncated in preview"}
        </pre>
      )}
    </div>
  );
}

function EntryRow({ entry: e, grid, picked, active, renaming, dropping, onClick, onOpen, onRename, onCancelRename, onDragStart, drop }: {
  entry: DirEntry; grid: boolean; picked: boolean; active: boolean; renaming: boolean; dropping: boolean;
  onClick: (e: React.MouseEvent) => void; onOpen: () => void; onRename: (name: string) => void; onCancelRename: () => void;
  onDragStart: (e: React.DragEvent) => void;
  drop?: { onDragOver: (e: React.DragEvent) => void; onDragLeave: () => void; onDrop: (e: React.DragEvent) => void };
}) {
  const icon = e.kind === "dir" ? "folder" : iconForName(e.name);
  const name = renaming ? (
    <input
      autoFocus
      defaultValue={e.name}
      aria-label={`New name for ${e.name}`}
      className="os-input min-w-0 flex-1 !py-0 text-[12px]"
      onClick={(ev) => ev.stopPropagation()}
      onKeyDown={(ev) => { if (ev.key === "Enter") onRename((ev.target as HTMLInputElement).value); if (ev.key === "Escape") onCancelRename(); }}
      onBlur={(ev) => onRename(ev.target.value)}
    />
  ) : <span className={cn("min-w-0 truncate text-[12px]", grid ? "w-full text-center" : "flex-1")}>{e.name}</span>;
  return (
    <div
      data-vfs-path={e.path}
      data-vfs-kind={e.kind}
      role="button"
      tabIndex={0}
      aria-label={`${e.kind === "dir" ? "Folder" : "File"} ${e.name}`}
      aria-pressed={picked}
      draggable={!renaming}
      onDragStart={onDragStart}
      onClick={onClick}
      onDoubleClick={onOpen}
      onKeyDown={(ev) => { if (ev.key === "Enter" && !renaming) onOpen(); }}
      {...drop}
      className={cn(
        "cursor-pointer rounded-[calc(var(--radius)*0.5)]",
        grid ? "flex flex-col items-center gap-1 px-1.5 py-2" : "flex items-center gap-2 px-2 py-1.5",
        picked || active ? "bg-[var(--accent)]/16 ring-1 ring-[var(--accent)]/40" : "hover:bg-white/6",
        dropping && "!ring-2 !ring-[var(--accent)]",
      )}
    >
      <Icon name={icon} size={grid ? 26 : 14} className={e.kind === "dir" ? "text-[var(--accent)]" : "text-[var(--muted)]"} />
      {name}
      {!grid && <span className="shrink-0 text-[10px] text-[var(--muted)]">{e.kind === "dir" ? `${e.count} file${e.count === 1 ? "" : "s"}` : bytes(e.size)}</span>}
      {!grid && <span className="hidden shrink-0 text-[10px] text-[var(--muted)] sm:inline">{e.updatedAt ? relTime(e.updatedAt) : ""}</span>}
    </div>
  );
}

function FileList({ nodes, sel, onSelect, onOpen }: { nodes: VNode[]; sel: string | null; onSelect: (p: string) => void; onOpen: (p: string) => void }) {
  return (
    <div className="space-y-0.5">
      {nodes.map((n) => (
        <div
          key={n.path}
          data-vfs-path={n.path}
          data-vfs-kind="file"
          onClick={() => onSelect(n.path)}
          onDoubleClick={() => onOpen(n.path)}
          className={cn("flex cursor-pointer items-center gap-2 rounded-[calc(var(--radius)*0.5)] px-2 py-1.5",
            sel === n.path ? "bg-[var(--accent)]/16 ring-1 ring-[var(--accent)]/40" : "hover:bg-white/6")}
        >
          <Icon name={iconFor(n)} size={14} className="text-[var(--muted)]" />
          <span className="min-w-0 flex-1 truncate text-[12px]">{n.name}</span>
          {n.starred && <Icon name="star" size={10} className="text-[var(--accent)]" />}
          <span className="shrink-0 text-[10px] text-[var(--muted)]">{bytes(n.size)}</span>
          <span className="hidden shrink-0 text-[10px] text-[var(--muted)] sm:inline">{relTime(n.updatedAt)}</span>
        </div>
      ))}
    </div>
  );
}

function iconFor(n: VNode): string {
  if (n.mime.includes("markdown")) return "report";
  if (n.mime.includes("json")) return "tokens";
  if (n.mime.includes("html")) return "browser";
  if (n.mime.includes("typescript") || n.mime.includes("javascript")) return "ide";
  if (n.mime.includes("csv")) return "layout";
  if (n.mime.startsWith("image/")) return "image";
  return "file";
}

function iconForName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "md") return "report";
  if (ext === "json") return "tokens";
  if (ext === "html" || ext === "htm") return "browser";
  if (["ts", "tsx", "js", "jsx", "py", "sh", "css"].includes(ext)) return "ide";
  if (ext === "csv") return "layout";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "image";
  return "file";
}
