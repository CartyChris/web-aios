"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVFS } from "@/kernel/vfs";
import { useSettings } from "@/kernel/settings";
import { bus } from "@/kernel/bus";
import { ask } from "@/lib/useAI";
import { makeZip, type ZipEntry } from "@/lib/zip";
import { loadCompressor } from "@/lib/deflate";
import { readZip } from "@/lib/office/zipread";
import { NATIVE_EXT, FOLDER, newName, extOf, type OfficeApp } from "@/lib/office/files";
import { relTime } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Icon } from "@/shell/icons";

/* The impure half every office app shares: the file it is editing (JSON in
   the OS filesystem, autosaved), importing a file the person picks (zip
   packages opened with the browser's own DecompressionStream), exporting a
   real package, and one AI call path that uses whatever model the person
   chose in Settings -- their API key, a local CLI through Bridge, or the
   on-device model. */

/* ── the document being edited ───────────────────────────────────────────── */

export function useOfficeFile<T>(app: OfficeApp, args: Record<string, unknown> | undefined, parse: (v: unknown) => T, blank: () => T) {
  const vfs = useVFS();
  const initial = typeof args?.path === "string" && extOf(args.path) === NATIVE_EXT[app] ? (args.path as string) : null;
  const [path, setPath] = useState<string | null>(initial);
  const [data, setData] = useState<T>(() => {
    if (!initial) return blank();
    try { return parse(JSON.parse(useVFS.getState().read(initial)?.content ?? "null")); } catch { return blank(); }
  });
  const [loadedFor, setLoadedFor] = useState<string | null>(initial);
  if (path !== loadedFor) {
    // Adjusting state during render when the file changes, as Notes does.
    setLoadedFor(path);
    try { setData(path ? parse(JSON.parse(vfs.read(path)?.content ?? "null")) : blank()); } catch { setData(blank()); }
  }
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const dirty = useRef(false);

  const update = useCallback((next: T | ((d: T) => T)) => {
    dirty.current = true;
    setData((d) => (typeof next === "function" ? (next as (d: T) => T)(d) : next));
  }, []);

  // Autosave, debounced. A document never needs a Save button.
  useEffect(() => {
    if (!dirty.current) return;
    const t = setTimeout(() => {
      let p = path;
      if (!p) {
        p = newName(app, new Set(Object.keys(useVFS.getState().nodes)));
        useVFS.getState().mkdir(FOLDER[app]);
        setPath(p);
        setLoadedFor(p);
      }
      useVFS.getState().write(p, JSON.stringify(data), { appId: app });
      dirty.current = false;
      setSavedAt(Date.now());
    }, 500);
    return () => clearTimeout(t);
  }, [data, path, app]);

  const files = useMemo(
    () => Object.values(vfs.nodes).filter((n) => n.kind === "file" && extOf(n.path) === NATIVE_EXT[app]).sort((a, b) => b.updatedAt - a.updatedAt),
    [vfs.nodes, app],
  );

  const open = useCallback((p: string | null) => { setPath(p); setSavedAt(null); dirty.current = false; }, []);
  const createNew = useCallback((value?: T, baseName?: string) => {
    const p = newName(app, new Set(Object.keys(useVFS.getState().nodes)), baseName?.replace(/[/\\]/g, "-").trim() || undefined);
    useVFS.getState().mkdir(FOLDER[app]);
    useVFS.getState().write(p, JSON.stringify(value ?? blank()), { appId: app });
    setPath(p);
    return p;
  }, [app, blank]);
  const rename = useCallback((name: string) => {
    if (!path) return;
    const clean = name.replace(/[/\\]/g, "-").trim();
    if (!clean) return;
    const to = `${path.slice(0, path.lastIndexOf("/"))}/${clean}.${NATIVE_EXT[app]}`;
    if (to !== path && useVFS.getState().rename(path, to)) { setPath(to); setLoadedFor(to); }
  }, [path, app]);

  const name = path ? path.slice(path.lastIndexOf("/") + 1).replace(new RegExp(`\\.${NATIVE_EXT[app]}$`), "") : "Untitled";
  return { path, data, update, files, open, createNew, rename, name, savedAt };
}

/* ── import ──────────────────────────────────────────────────────────────── */

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

export async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([bytes.slice().buffer as ArrayBuffer]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** An office package (.docx, .odt, ...) as path -> text for XML parts, bytes for the rest. */
export async function unzipPackage(file: File): Promise<Map<string, string | Uint8Array>> {
  if (file.size > 60 * 1024 * 1024) throw new Error(`${file.name} is ${Math.round(file.size / 1048576)} MB; the limit is 60 MB.`);
  const raw = await readZip(new Uint8Array(await file.arrayBuffer()), inflateRaw);
  const out = new Map<string, string | Uint8Array>();
  const dec = new TextDecoder();
  for (const [p, b] of raw) out.set(p, /\.(xml|rels)$/i.test(p) || p === "mimetype" ? dec.decode(b) : b);
  return out;
}

/* ── export ──────────────────────────────────────────────────────────────── */

export async function downloadPackage(filename: string, entries: ZipEntry[], mime: string) {
  const c = await loadCompressor();
  // ODF requires the "mimetype" entry stored, first and uncompressed.
  const bytes = makeZip(entries, { deflate: c ? (b) => (b.length < 120 && /^application\/vnd\./.test(new TextDecoder().decode(b)) ? null : c.deflate(b)) : undefined });
  downloadBytes(filename, bytes, mime);
}

export function downloadBytes(filename: string, bytes: Uint8Array | string, mime: string) {
  const blob = new Blob([typeof bytes === "string" ? bytes : (bytes.slice().buffer as ArrayBuffer)], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const MIME = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  odg: "application/vnd.oasis.opendocument.graphics",
} as const;

/** Print an HTML document through a hidden frame: the browser's print dialog is also its "Save as PDF". */
export function printHtml(html: string) {
  const f = document.createElement("iframe");
  f.style.cssText = "position:fixed;width:0;height:0;border:0;left:-9999px";
  f.setAttribute("sandbox", "allow-modals allow-same-origin");
  document.body.appendChild(f);
  const d = f.contentDocument;
  if (!d) { f.remove(); return; }
  d.open();
  d.write(html);
  d.close();
  setTimeout(() => { try { f.contentWindow?.focus(); f.contentWindow?.print(); } finally { setTimeout(() => f.remove(), 1500); } }, 250);
}

/* ── AI ──────────────────────────────────────────────────────────────────── */

export function useAiCall() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [partial, setPartial] = useState("");
  const ctl = useRef<AbortController | null>(null);
  const provider = useSettings((s) => s.ai.provider);
  const model = useSettings((s) => s.ai.model);

  const run = useCallback(async (system: string, prompt: string, opts: { maxTokens?: number; name?: string } = {}): Promise<string | null> => {
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    setBusy(true);
    setError(null);
    setPartial("");
    try {
      const r = await ask({
        system,
        persona: false,
        messages: [{ role: "user", content: prompt }],
        maxTokens: opts.maxTokens ?? 4000,
        signal: c.signal,
        onDelta: (_d, full) => setPartial(full),
        trace: { role: "office", name: opts.name ?? "office" },
      });
      if (c.signal.aborted) return null;
      if (!r.text.trim()) { setError("The model returned nothing. Try again, or pick another model in Settings."); return null; }
      return r.text;
    } catch (e) {
      if (!c.signal.aborted) setError((e as Error).message || String(e));
      return null;
    } finally {
      if (ctl.current === c) { setBusy(false); ctl.current = null; }
    }
  }, []);

  const stop = useCallback(() => { ctl.current?.abort(); setBusy(false); }, []);
  return { run, stop, busy, error, setError, partial, provider, model };
}

/** Which model the AI buttons will use, with a way to change it. */
export function ModelChip({ provider, model }: { provider: string; model: string }) {
  return (
    <button
      className="os-chip max-w-[180px] truncate !text-[10px]"
      title="AI actions use the provider and model chosen in Settings"
      onClick={() => bus.emit("app:open", { appId: "settings" })}
      aria-label={`AI model: ${provider} ${model}. Open Settings to change it.`}
    >
      <Icon name="sparkles" size={10} /> {provider} / {model}
    </button>
  );
}

/* ── the shared file bar ─────────────────────────────────────────────────── */

export interface MenuItem { id: string; label: string; run: () => void | Promise<void>; disabled?: boolean }

export function FileBar({ icon, name, savedAt, onRename, files, current, onOpen, onNew, imports, exports, extra }: {
  icon: string;
  name: string;
  savedAt: number | null;
  onRename: (name: string) => void;
  files: Array<{ path: string; updatedAt: number }>;
  current: string | null;
  onOpen: (path: string) => void;
  onNew: () => void;
  imports?: MenuItem[];
  exports: MenuItem[];
  extra?: React.ReactNode;
}) {
  const [menu, setMenu] = useState<null | "open" | "import" | "export">(null);
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const runItem = async (m: MenuItem) => {
    setMenu(null);
    setErr(null);
    try { await m.run(); } catch (e) { setErr((e as Error).message || String(e)); }
  };
  const pop = (items: MenuItem[]) => (
    <div className="absolute left-0 top-full z-30 mt-1 min-w-[190px] overflow-hidden rounded-lg border border-[var(--border)] p-1 shadow-xl" style={{ background: "var(--panel-solid)" }} role="menu">
      {items.map((m) => (
        <button key={m.id} role="menuitem" disabled={m.disabled} className="block w-full rounded px-2 py-1.5 text-left text-[12px] hover:bg-[var(--hover)] disabled:opacity-40" onClick={() => void runItem(m)}>{m.label}</button>
      ))}
    </div>
  );
  return (
    <div className="relative flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border)] px-2 py-1.5" data-office-filebar>
      <Icon name={icon} size={15} />
      {editing ? (
        <input
          className="os-input !w-44 !py-0.5 text-[12.5px]"
          autoFocus
          defaultValue={name}
          aria-label="Document name"
          onBlur={(e) => { onRename(e.target.value); setEditing(false); }}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditing(false); }}
        />
      ) : (
        <button className="max-w-[40vw] truncate rounded px-1 text-[12.5px] font-medium hover:bg-[var(--hover)]" onClick={() => setEditing(true)} aria-label={`Rename ${name}`} title="Rename">{name}</button>
      )}
      <span className="text-[10px] text-[var(--muted)]" aria-live="polite">{savedAt ? `Saved ${relTime(savedAt)}` : current ? "Saved" : "Not saved yet"}</span>
      <div className="ml-auto flex flex-wrap items-center gap-1">
        {extra}
        <button className="os-btn !py-0.5 text-[11px]" onClick={onNew} aria-label="New document"><Icon name="plus" size={11} /> New</button>
        <div className="relative">
          <button className="os-btn !py-0.5 text-[11px]" onClick={() => setMenu(menu === "open" ? null : "open")} aria-expanded={menu === "open"} aria-label="Open a document"><Icon name="folder" size={11} /> Open</button>
          {menu === "open" && pop(files.length ? files.slice(0, 30).map((f) => ({ id: f.path, label: `${f.path.slice(f.path.lastIndexOf("/") + 1)}${f.path === current ? "  (open)" : ""}`, run: () => onOpen(f.path) })) : [{ id: "none", label: "No documents yet", run: () => undefined, disabled: true }])}
        </div>
        {imports?.length ? (
          <div className="relative">
            <button className="os-btn !py-0.5 text-[11px]" onClick={() => setMenu(menu === "import" ? null : "import")} aria-expanded={menu === "import"} aria-label="Import a file">Import</button>
            {menu === "import" && pop(imports)}
          </div>
        ) : null}
        <div className="relative">
          <button className="os-btn !py-0.5 text-[11px]" data-variant="primary" onClick={() => setMenu(menu === "export" ? null : "export")} aria-expanded={menu === "export"} aria-label="Export or download"><Icon name="download" size={11} /> Export</button>
          {menu === "export" && <div className="absolute right-0 top-full z-30">{pop(exports)}</div>}
        </div>
      </div>
      {err && <div className="basis-full text-[11px] text-[var(--danger)]" role="alert">{err}</div>}
    </div>
  );
}

/** A small AI side panel: preset actions plus a free-form request. */
export function AiPanel({ title, actions, placeholder, onFree, busy, error, partial, provider, model, onStop, children }: {
  title: string;
  actions: Array<{ id: string; label: string; run: () => void; disabled?: boolean }>;
  placeholder: string;
  onFree: (text: string) => void;
  busy: boolean;
  error: string | null;
  partial: string;
  provider: string;
  model: string;
  onStop: () => void;
  children?: React.ReactNode;
}) {
  const [text, setText] = useState("");
  return (
    <aside className="flex max-h-[42%] w-full shrink-0 flex-col gap-2 overflow-y-auto border-t border-[var(--border)] p-2.5 sm:max-h-none sm:w-[250px] sm:border-l sm:border-t-0" data-office-ai aria-label={`${title} AI`}>
      <div className="flex items-center gap-1.5">
        <Icon name="sparkles" size={13} />
        <span className="text-[12px] font-medium">{title}</span>
      </div>
      <ModelChip provider={provider} model={model} />
      <div className="flex flex-wrap gap-1">
        {actions.map((a) => <button key={a.id} className="os-btn !py-0.5 text-[11px]" disabled={busy || a.disabled} onClick={a.run}>{a.label}</button>)}
      </div>
      <form className="flex flex-col gap-1" onSubmit={(e) => { e.preventDefault(); if (text.trim()) { onFree(text.trim()); } }}>
        <textarea className="os-input min-h-[64px] text-[12px]" value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} aria-label={placeholder} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (text.trim()) onFree(text.trim()); } }} />
        <div className="flex gap-1">
          <button type="submit" className="os-btn !py-0.5 text-[11px]" data-variant="primary" disabled={busy || !text.trim()}>{busy ? "Working..." : "Ask"}</button>
          {busy && <button type="button" className="os-btn !py-0.5 text-[11px]" onClick={onStop}>Stop</button>}
        </div>
      </form>
      {busy && partial && <div className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-white/5 p-1.5 text-[11px] text-[var(--muted)]" aria-live="polite">{partial.slice(-1500)}</div>}
      {error && <div className="text-[11px] text-[var(--danger)]" role="alert">{error}</div>}
      {children}
    </aside>
  );
}

/** Tool button used by every office toolbar. */
export function TB({ label, icon, text, active, onClick, disabled, className }: { label: string; icon?: string; text?: string; active?: boolean; onClick: () => void; disabled?: boolean; className?: string }) {
  return (
    <button
      type="button"
      className={cn("os-btn !min-w-[26px] !px-1.5 !py-0.5 text-[11.5px]", active && "!border-[var(--accent)] !bg-[var(--accent)]/15", className)}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      title={label}
    >
      {icon ? <Icon name={icon} size={12} /> : null}
      {text ? <span className={icon ? "ml-0.5" : ""}>{text}</span> : null}
    </button>
  );
}
