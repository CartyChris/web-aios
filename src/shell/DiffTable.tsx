"use client";

import { useMemo } from "react";
import { diffLines, sideBySide, collapse, rowIsSame, type SideRow } from "@/lib/textdiff";
import { cn } from "@/lib/cn";

/* Two texts side by side, old on the left and new on the right, with unchanged
   runs collapsed to three lines of context. Shared by Rewind's Compare and the
   AIOS Chat diff panel so both read the same way. The diff itself is
   lib/textdiff.ts, which is pure and tested. */

export const DIFF_TOO_BIG = 400_000;

export function DiffTable({ before, after, leftLabel, rightLabel, identical = "The text is identical.", className, ...data }: {
  before: string;
  after: string;
  leftLabel: string;
  rightLabel: string;
  /** What to say when nothing differs. */
  identical?: string;
  className?: string;
} & Record<`data-${string}`, string>) {
  const result = useMemo(() => (before.length + after.length > DIFF_TOO_BIG ? null : diffLines(before, after)), [before, after]);
  if (!result) {
    return <p className="mb-2 text-[11px] text-[var(--muted)]">This is too large to compare here ({Math.round((before.length + after.length) / 1024)} KB).</p>;
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
    <div className={cn("overflow-hidden rounded border border-[var(--border)]", className)} {...data}>
      <div className="grid grid-cols-2 border-b border-[var(--border)] text-[10.5px] text-[var(--muted)]">
        <div className="px-2 py-1">{leftLabel}</div>
        <div className="border-l border-[var(--border)] px-2 py-1">{rightLabel}</div>
      </div>
      {result.truncated && <p className="px-2 py-1 text-[10.5px] text-[var(--warn)]">These versions are too different to line up, so every line is shown as changed.</p>}
      {result.added + result.removed === 0 ? (
        <p className="px-2 py-1.5 text-[11px] text-[var(--muted)]">{identical}</p>
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
