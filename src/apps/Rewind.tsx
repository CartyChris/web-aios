"use client";

import { useEffect, useMemo, useState } from "react";
import type { AppProps } from "@/kernel/types";
import { listSnapshots, loadSnapshot, takeSnapshot, restoreSnapshot, restoreFile, renameSnapshot, setPinned, currentData, type SnapshotInfo, type SnapshotData } from "@/kernel/rewind";
import { useVFS } from "@/kernel/vfs";
import { diffLines, sideBySide, collapse, rowIsSame, type SideRow } from "@/lib/textdiff";
import { diffFiles, diffKeys, formatBytes, type FileDiff } from "@/lib/rewind";
import { relTime } from "@/lib/format";
import { Empty, Spinner } from "./_ui";
import { cn } from "@/lib/cn";
import { Icon } from "@/shell/icons";

/* Rewind: the whole OS, as it was. Pick a snapshot, see exactly what a
   restore would change, and restore it; the state you leave is snapshotted
   first and pinned, so a restore can be undone. */

export default function Rewind({}: AppProps) {
  const [snaps, setSnaps] = useState<SnapshotInfo[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ files: FileDiff; settings: string[] } | null>(null);
  /* The snapshot's own files, kept so one file can be compared and restored
     without reading the snapshot again. */
  const [thenVfs, setThenVfs] = useState<SnapshotData["vfs"] | null>(null);
  const [comparing, setComparing] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  /* What Undo puts back. `path` is set when the last action restored ONE file:
     undoing that must put back only that file, not rewind the whole OS to the
     pre-restore snapshot and silently revert anything changed since. */
  const [undo, setUndo] = useState<{ id: string; path?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    let live = true;
    void listSnapshots().then((s) => { if (live) setSnaps(s); }).catch(() => { if (live) setSnaps([]); });
    return () => { live = false; };
  }, [epoch]);

  useEffect(() => {
    if (!sel) return;
    let live = true;
    void loadSnapshot(sel).then((then) => {
      if (!live || !then) return;
      const now = currentData();
      setThenVfs(then.vfs);
      setDiff({ files: diffFiles(then.vfs, now.vfs), settings: diffKeys(then.settings, now.settings as Record<string, unknown>) });
    });
    return () => { live = false; };
  }, [sel]);

  const refresh = () => setEpoch((e) => e + 1);
  const snapNow = async () => { setBusy(true); await takeSnapshot("Manual", { force: true }); setBusy(false); refresh(); };
  const restoreOneFile = async (path: string) => {
    if (!sel) return;
    setBusy(true);
    const r = await restoreFile(sel, path);
    if (r.undoId) setUndo({ id: r.undoId, path });
    setBusy(false);
    setComparing(null);
    // Re-read so the list reflects the file that just moved.
    const keep = sel;
    setSel(null); setDiff(null);
    queueMicrotask(() => setSel(keep));
    refresh();
  };
  const saveName = async (id: string) => {
    await renameSnapshot(id, draft);
    setRenaming(null);
    refresh();
  };
  const restore = async (id: string) => { setBusy(true); const before = await restoreSnapshot(id); setUndo(before ? { id: before } : null); setBusy(false); setSel(null); setDiff(null); refresh(); };
  const undoLast = async () => {
    if (!undo) return;
    if (!undo.path) return restore(undo.id);
    setBusy(true);
    const r = await restoreFile(undo.id, undo.path);
    // Undoing a file restore is itself undoable, one file at a time.
    setUndo(r.undoId ? { id: r.undoId, path: undo.path } : null);
    setBusy(false);
    setSel(null); setDiff(null);
    refresh();
  };

  const chosen = snaps?.find((s) => s.id === sel) ?? null;

  return (
    <div className="app-split flex h-full">
      <div className="app-sidebar flex w-64 shrink-0 flex-col border-r border-[var(--border)]">
        <div className="flex gap-1.5 p-2">
          <button className="os-btn flex-1 !py-1 text-[11px]" data-variant="primary" onClick={() => void snapNow()} disabled={busy}><Icon name="save" size={12} className="mr-1" />Snapshot now</button>
          {undo && <button className="os-btn !py-1 text-[11px]" onClick={() => void undoLast()} disabled={busy} title={undo.path ? `Put ${undo.path} back as it was` : "Put the whole OS back as it was"}>Undo restore</button>}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {snaps === null ? <Spinner label="Reading snapshots" /> : snaps.length === 0 ? <p className="p-2 text-[11px] text-[var(--muted)]">No snapshots yet. One is taken when the OS starts and every ten minutes after, only when something changed.</p> : snaps.map((s) => (
            <div key={s.id} className={cn("mb-1 flex items-center gap-1 rounded px-2 py-1.5", sel === s.id ? "bg-[var(--accent)]/16" : "hover:bg-[var(--hover)]")}>
              {renaming === s.id ? (
                <input
                  autoFocus
                  className="os-input min-w-0 flex-1 !py-0.5 text-[12px]"
                  value={draft}
                  aria-label="Snapshot name"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void saveName(s.id); if (e.key === "Escape") setRenaming(null); }}
                  onBlur={() => void saveName(s.id)}
                />
              ) : (
                <button className="min-w-0 flex-1 text-left" onClick={() => { setSel(s.id); setComparing(null); }} data-snap={s.id}>
                  <div className="truncate text-[12px] font-medium">{s.label}</div>
                  <div className="text-[10.5px] text-[var(--muted)]">{relTime(s.at)} · {s.files} files · {formatBytes(s.bytes)}</div>
                </button>
              )}
              <button className="text-[10px] opacity-40 hover:opacity-100" onClick={() => { setRenaming(s.id); setDraft(s.label); }} aria-label={`Name ${s.label} (naming pins it)`} title="Name it (naming pins it)"><Icon name="sticky" size={11} /></button>
              <button className={cn("text-[10px]", s.pinned ? "opacity-100" : "opacity-40 hover:opacity-100")} onClick={() => void setPinned(s.id, !s.pinned).then(refresh)} aria-label={s.pinned ? `Unpin ${s.label}` : `Pin ${s.label} so it is never pruned`} aria-pressed={!!s.pinned}><Icon name="pin" size={11} /></button>
            </div>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {!chosen ? (
          <Empty icon="backup" title="Pick a snapshot" body="See exactly what restoring it would change, then restore. Your files, settings, scenes and custom themes are covered. Snapshots stay in this browser." />
        ) : !diff ? <Spinner label="Comparing with now" /> : (
          <div data-rewind-diff>
            <div className="mb-1 text-[14px] font-semibold">{chosen.label}, {relTime(chosen.at)}</div>
            <p className="mb-3 text-[11.5px] text-[var(--muted)]">
              Restoring brings back {diff.files.added.length} file{diff.files.added.length === 1 ? "" : "s"}, removes {diff.files.removed.length}, changes {diff.files.changed.length}
              {diff.settings.length ? `, and resets ${diff.settings.length} setting${diff.settings.length === 1 ? "" : "s"}` : ""} ({formatBytes(diff.files.bytesDelta)} net).
            </p>
            <FileRows
              title="Comes back" paths={diff.files.added.map((f) => f.path)} busy={busy}
              action="Restore this file" onAction={restoreOneFile}
            />
            <FileRows
              title="Would be removed" paths={diff.files.removed.map((f) => f.path)} busy={busy}
              action="Remove, as in the snapshot" danger onAction={restoreOneFile}
            />
            <FileRows
              title="Changes" busy={busy}
              paths={diff.files.changed.map((f) => f.path)}
              notes={Object.fromEntries(diff.files.changed.map((f) => [f.path, `${formatBytes(f.from)} to ${formatBytes(f.to)}`]))}
              action="Restore this file" onAction={restoreOneFile}
              compare={comparing} onCompare={(p) => setComparing(comparing === p ? null : p)}
            />
            {comparing && thenVfs && <FileCompare path={comparing} then={thenVfs[comparing]?.content ?? ""} />}
            {diff.settings.length > 0 && (
              <div className="mb-2">
                <div className="os-label mb-0.5">Settings ({diff.settings.length})</div>
                {diff.settings.slice(0, 20).map((r) => <div key={r} className="truncate font-mono text-[11px]">{r}</div>)}
                {diff.settings.length > 20 && <div className="text-[10.5px] text-[var(--muted)]">and {diff.settings.length - 20} more</div>}
              </div>
            )}
            <button className="os-btn mt-2" data-variant="primary" onClick={() => void restore(chosen.id)} disabled={busy}>Restore this snapshot</button>
            <p className="mt-1 text-[10.5px] text-[var(--muted)]">The current state is snapshotted and pinned first, so you can undo.</p>
          </div>
        )}
      </div>
    </div>
  );
}

/* One list of paths with a per-file action. A restore of one file leaves the
   rest of the OS alone, and is undoable like a full restore. */
function FileRows({ title, paths, notes, action, danger, busy, onAction, compare, onCompare }: {
  title: string;
  paths: string[];
  notes?: Record<string, string>;
  action: string;
  danger?: boolean;
  busy: boolean;
  onAction: (path: string) => void;
  compare?: string | null;
  onCompare?: (path: string) => void;
}) {
  if (!paths.length) return null;
  return (
    <div className="mb-2" data-rewind-list={title}>
      <div className="os-label mb-0.5">{title} ({paths.length})</div>
      {paths.slice(0, 40).map((p) => (
        <div key={p} className={cn("group flex items-center gap-1.5 rounded px-1 py-0.5", compare === p && "bg-[var(--accent)]/12")}>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{p}{notes?.[p] ? <span className="text-[var(--muted)]"> ({notes[p]})</span> : null}</span>
          {onCompare && (
            <button className="os-chip !py-0 !text-[10px]" onClick={() => onCompare(p)} aria-pressed={compare === p} data-compare={p}>
              {compare === p ? "Hide" : "Compare"}
            </button>
          )}
          <button
            className={cn("os-chip !py-0 !text-[10px]", danger && "!text-[var(--danger)]")}
            disabled={busy} onClick={() => onAction(p)} data-restore-file={p}
          >{action}</button>
        </div>
      ))}
      {paths.length > 40 && <div className="text-[10.5px] text-[var(--muted)]">and {paths.length - 40} more</div>}
    </div>
  );
}

/* Now on the left, the snapshot on the right: what restoring this file would
   do. Unchanged runs collapse, keeping three lines of context either side. */
function FileCompare({ path, then }: { path: string; then: string }) {
  const now = useVFS((s) => s.nodes[path]?.content ?? "");
  const TOO_BIG = 400_000;
  const result = useMemo(() => (now.length + then.length > TOO_BIG ? null : diffLines(now, then)), [now, then]);
  if (!result) {
    return <p className="mb-2 text-[11px] text-[var(--muted)]">This file is too large to compare here ({Math.round((now.length + then.length) / 1024)} KB).</p>;
  }
  const items = collapse(sideBySide(result.ops), rowIsSame, 3);
  const cell = (c: SideRow["left"], side: "left" | "right") => (
    <div
      className={cn("flex min-w-0 font-mono text-[11px] leading-[1.45]", c?.kind === "del" && "bg-[var(--danger)]/14", c?.kind === "add" && "bg-[var(--ok)]/14")}
      data-side={side} data-kind={c?.kind ?? "empty"}
    >
      <span className="w-9 shrink-0 select-none pr-1.5 text-right text-[var(--muted)]">{c?.n ?? ""}</span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-all">{c?.text ?? ""}</span>
    </div>
  );
  return (
    <div className="mb-3 overflow-hidden rounded border border-[var(--border)]" data-rewind-compare={path}>
      <div className="grid grid-cols-2 border-b border-[var(--border)] text-[10.5px] text-[var(--muted)]">
        <div className="px-2 py-1">Now</div>
        <div className="border-l border-[var(--border)] px-2 py-1">In the snapshot</div>
      </div>
      {result.truncated && <p className="px-2 py-1 text-[10.5px] text-[var(--warn)]">These versions are too different to line up, so every line is shown as changed.</p>}
      {result.added + result.removed === 0 ? (
        <p className="px-2 py-1.5 text-[11px] text-[var(--muted)]">The text is identical; only the file&apos;s metadata differs.</p>
      ) : items.map((it, i) =>
        it.kind === "skip" ? (
          <div key={`s${i}`} className="bg-[var(--bg2)] px-2 py-0.5 text-center text-[10px] text-[var(--muted)]">{it.count} unchanged line{it.count === 1 ? "" : "s"}</div>
        ) : (
          <div key={i} className="grid grid-cols-2">
            {cell(it.row.left, "left")}
            <div className="border-l border-[var(--border)]">{cell(it.row.right, "right")}</div>
          </div>
        ),
      )}
    </div>
  );
}
