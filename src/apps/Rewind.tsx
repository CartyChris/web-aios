"use client";

import { useEffect, useState } from "react";
import type { AppProps } from "@/kernel/types";
import { listSnapshots, loadSnapshot, takeSnapshot, restoreSnapshot, setPinned, currentData, type SnapshotInfo } from "@/kernel/rewind";
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
  const [undoId, setUndoId] = useState<string | null>(null);
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
      setDiff({ files: diffFiles(then.vfs, now.vfs), settings: diffKeys(then.settings, now.settings as Record<string, unknown>) });
    });
    return () => { live = false; };
  }, [sel]);

  const refresh = () => setEpoch((e) => e + 1);
  const snapNow = async () => { setBusy(true); await takeSnapshot("Manual", { force: true }); setBusy(false); refresh(); };
  const restore = async (id: string) => { setBusy(true); const before = await restoreSnapshot(id); setUndoId(before); setBusy(false); setSel(null); setDiff(null); refresh(); };

  const chosen = snaps?.find((s) => s.id === sel) ?? null;

  return (
    <div className="app-split flex h-full">
      <div className="app-sidebar flex w-64 shrink-0 flex-col border-r border-[var(--border)]">
        <div className="flex gap-1.5 p-2">
          <button className="os-btn flex-1 !py-1 text-[11px]" data-variant="primary" onClick={() => void snapNow()} disabled={busy}><Icon name="save" size={12} className="mr-1" />Snapshot now</button>
          {undoId && <button className="os-btn !py-1 text-[11px]" onClick={() => void restore(undoId)} disabled={busy}>Undo restore</button>}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {snaps === null ? <Spinner label="Reading snapshots" /> : snaps.length === 0 ? <p className="p-2 text-[11px] text-[var(--muted)]">No snapshots yet. One is taken when the OS starts and every ten minutes after, only when something changed.</p> : snaps.map((s) => (
            <div key={s.id} className={cn("mb-1 flex items-center gap-1 rounded px-2 py-1.5", sel === s.id ? "bg-[var(--accent)]/16" : "hover:bg-[var(--hover)]")}>
              <button className="min-w-0 flex-1 text-left" onClick={() => setSel(s.id)} data-snap={s.id}>
                <div className="truncate text-[12px] font-medium">{s.label}</div>
                <div className="text-[10.5px] text-[var(--muted)]">{relTime(s.at)} · {s.files} files · {formatBytes(s.bytes)}</div>
              </button>
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
            {([["Comes back", diff.files.added.map((f) => f.path)], ["Would be removed", diff.files.removed.map((f) => f.path)], ["Changes", diff.files.changed.map((f) => `${f.path} (${formatBytes(f.from)} to ${formatBytes(f.to)})`)], ["Settings", diff.settings]] as const).map(([title, rows]) => rows.length > 0 && (
              <div key={title} className="mb-2">
                <div className="os-label mb-0.5">{title} ({rows.length})</div>
                {rows.slice(0, 20).map((r) => <div key={r} className="truncate font-mono text-[11px]">{r}</div>)}
                {rows.length > 20 && <div className="text-[10.5px] text-[var(--muted)]">and {rows.length - 20} more</div>}
              </div>
            ))}
            <button className="os-btn mt-2" data-variant="primary" onClick={() => void restore(chosen.id)} disabled={busy}>Restore this snapshot</button>
            <p className="mt-1 text-[10.5px] text-[var(--muted)]">The current state is snapshotted and pinned first, so you can undo.</p>
          </div>
        )}
      </div>
    </div>
  );
}
