"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useVFS, type VNode } from "@/kernel/vfs";
import { useWM } from "@/kernel/wm";
import { bus } from "@/kernel/bus";
import type { AppProps } from "@/kernel/types";
import { bytes, relTime, download } from "@/lib/format";
import { downloadZip } from "@/lib/zip";
import { Empty, ErrorNote, CopyButton } from "./_ui";
import { cn } from "@/lib/cn";
import { Icon } from "@/shell/icons";

/** Files — one view over everything every app has stored. */
export default function Files({}: AppProps) {
  const vfs = useVFS();
  const wm = useWM();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const all = useMemo(() => Object.values(vfs.nodes).filter((n) => n.kind === "file"), [vfs.nodes]);
  const folders = useMemo(() => {
    const map = new Map<string, VNode[]>();
    for (const n of all) {
      const dir = n.path.split("/").slice(0, -1).join("/") || "/";
      if (!map.has(dir)) map.set(dir, []);
      map.get(dir)!.push(n);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [all]);

  const filtered = q.trim()
    ? all.filter((n) => (n.path + n.content).toLowerCase().includes(q.toLowerCase())).sort((a, b) => b.updatedAt - a.updatedAt)
    : null;

  const usage = vfs.usage();
  const node = sel ? vfs.read(sel) : undefined;

  const importFiles = useCallback(
    async (files: FileList | null) => {
      if (!files?.length) return;
      let n = 0;
      for (const f of Array.from(files)) {
        if (f.size > 2 * 1024 * 1024) { setError(`${f.name} is over the 2 MB per-file limit for browser storage.`); continue; }
        try {
          const text = await f.text();
          // A previously exported backup is restored rather than stored as one blob.
          if (f.name.endsWith(".json") && text.includes("__webaios")) {
            const parsed = JSON.parse(text);
            if (parsed.vfs?.nodes || parsed.nodes) { n += vfs.importAll(JSON.stringify(parsed.vfs ?? parsed)); continue; }
          }
          vfs.write(`/imported/${f.name}`, text, { appId: "files" });
          n++;
        } catch { setError(`${f.name} could not be read as text.`); }
      }
      if (n) bus.emit("notify", { title: `Imported ${n} file${n === 1 ? "" : "s"}`, kind: "success" });
    },
    [vfs],
  );

  const openIn = useCallback((path: string) => {
    const app = path.endsWith(".md") || path.endsWith(".txt") ? "notes" : "ide";
    wm.open(app, { title: path.split("/").pop(), icon: app === "notes" ? "notes" : "ide", args: { path } });
  }, [wm]);

  return (
    <div className="flex h-full flex-col">
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
        <span className="os-chip">{usage.count} files · {bytes(usage.bytes)}</span>
      </div>

      <div className="px-2.5 pt-2"><ErrorNote error={error} onDismiss={() => setError(null)} /></div>

      <div className="app-split flex min-h-0 flex-1">
        <div
          className="min-w-0 flex-1 overflow-y-auto p-2.5"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); importFiles(e.dataTransfer.files); }}
        >
          {all.length === 0 ? (
            <Empty icon="files" title="No files yet" body="Apps write here as you use them — chats, research briefs, plans, notes and code. You can also drag files in from your computer." />
          ) : filtered ? (
            <FileList nodes={filtered} sel={sel} onSelect={setSel} onOpen={openIn} />
          ) : (
            folders.map(([dir, nodes]) => (
              <div key={dir} className="mb-3">
                <div className="os-label mb-1">{dir === "/" ? "/ (root)" : dir}</div>
                <FileList nodes={nodes.sort((a, b) => b.updatedAt - a.updatedAt)} sel={sel} onSelect={setSel} onOpen={openIn} />
              </div>
            ))
          )}
        </div>

        {node && (
          <div className="app-aside flex w-80 shrink-0 flex-col overflow-hidden border-l border-[var(--border)]">
            <div className="flex items-center gap-1.5 border-b border-[var(--border)] p-2">
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{node.name}</span>
              <button className="os-btn !px-2 !py-0.5 text-[11px]" onClick={() => setSel(null)}><Icon name="close" size={11} /></button>
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
              <button className="os-btn !py-1 text-[11px]" onClick={() => { vfs.remove(node.path); setSel(null); }}>Delete</button>
            </div>
            <pre className="min-h-0 flex-1 overflow-auto p-2 font-[family-name:var(--font-mono)] text-[11px] leading-relaxed whitespace-pre-wrap break-words">
              {node.content.slice(0, 20000)}
              {node.content.length > 20000 && "\n\n… truncated in preview"}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

function FileList({ nodes, sel, onSelect, onOpen }: { nodes: VNode[]; sel: string | null; onSelect: (p: string) => void; onOpen: (p: string) => void }) {
  return (
    <div className="space-y-0.5">
      {nodes.map((n) => (
        <div
          key={n.path}
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
  return "file";
}
