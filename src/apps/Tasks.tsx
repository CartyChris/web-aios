"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { ask } from "@/lib/useAI";
import type { AppProps } from "@/kernel/types";
import { uid, download } from "@/lib/format";
import { ErrorNote, Spinner } from "./_ui";
import { cn } from "@/lib/cn";
import { Icon } from "@/shell/icons";
import { bus } from "@/kernel/bus";
import { registerContextTarget, type TargetContext } from "@/kernel/ctxmenu";
import {
  parseQuickAdd, dueBucket, matchesFilter, formatDue, tasksToIcs, toLocalIso, fromLocalIso, checklistProgress,
  type CheckItem, type TaskFilter, type QuickAdd,
} from "@/lib/quickadd";

/** Task Board — kanban with drag-and-drop, WIP limits and AI breakdown.
 *  Ported from DailyFlow-AI-Kanban and the WebOS task board. */
export interface Task {
  id: string;
  title: string;
  notes: string;
  column: string;
  priority: "low" | "med" | "high";
  createdAt: number;
  tags: string[];
  /** Epoch ms. Date-only dues are the end of that local day (see src/lib/quickadd.ts). */
  due?: number;
  dueHasTime?: boolean;
  checklist?: CheckItem[];
  /** Set when archived. Archived tasks leave the board but are never deleted. */
  archivedAt?: number;
}

export interface Column { id: string; name: string; wip: number }

interface TaskState {
  tasks: Task[];
  columns: Column[];
  add: (column: string, title: string) => void;
  patch: (id: string, p: Partial<Task>) => void;
  remove: (id: string) => void;
  move: (id: string, column: string, beforeId?: string) => void;
  addColumn: () => void;
  patchColumn: (id: string, p: Partial<Column>) => void;
  removeColumn: (id: string) => void;
  addMany: (column: string, titles: string[]) => void;
  addParsed: (column: string, q: QuickAdd) => void;
  archive: (id: string) => void;
  unarchive: (id: string) => void;
}

export const useTasks = create<TaskState>()(
  persist(
    (set) => ({
      tasks: [],
      columns: [
        { id: "todo", name: "To do", wip: 0 },
        { id: "doing", name: "In progress", wip: 3 },
        { id: "done", name: "Done", wip: 0 },
      ],
      add: (column, title) =>
        set((s) => ({ tasks: [...s.tasks, { id: uid("task"), title, notes: "", column, priority: "med", createdAt: Date.now(), tags: [] }] })),
      addMany: (column, titles) =>
        set((s) => ({
          tasks: [...s.tasks, ...titles.map((t) => ({ id: uid("task"), title: t, notes: "", column, priority: "med" as const, createdAt: Date.now(), tags: [] }))],
        })),
      addParsed: (column, q) =>
        set((s) => ({
          tasks: [...s.tasks, {
            id: uid("task"), title: q.title, notes: "", column, priority: q.priority ?? "med", createdAt: Date.now(), tags: [],
            ...(q.due != null ? { due: q.due, dueHasTime: q.hasTime } : {}),
          }],
        })),
      archive: (id) => set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, archivedAt: Date.now() } : t)) })),
      unarchive: (id) => set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, archivedAt: undefined } : t)) })),
      patch: (id, p) => set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...p } : t)) })),
      remove: (id) => set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) })),
      move: (id, column, beforeId) =>
        set((s) => {
          const task = s.tasks.find((t) => t.id === id);
          if (!task) return s;
          const rest = s.tasks.filter((t) => t.id !== id);
          const moved = { ...task, column };
          if (!beforeId) return { tasks: [...rest, moved] };
          const idx = rest.findIndex((t) => t.id === beforeId);
          if (idx === -1) return { tasks: [...rest, moved] };
          return { tasks: [...rest.slice(0, idx), moved, ...rest.slice(idx)] };
        }),
      addColumn: () => set((s) => ({ columns: [...s.columns, { id: uid("col"), name: `Column ${s.columns.length + 1}`, wip: 0 }] })),
      patchColumn: (id, p) => set((s) => ({ columns: s.columns.map((c) => (c.id === id ? { ...c, ...p } : c)) })),
      // Deleting a column must not delete the work in it.
      removeColumn: (id) =>
        set((s) => {
          const fallback = s.columns.find((c) => c.id !== id)?.id;
          if (!fallback) return s;
          return { columns: s.columns.filter((c) => c.id !== id), tasks: s.tasks.map((t) => (t.column === id ? { ...t, column: fallback } : t)) };
        }),
    }),
    { name: "webaios.tasks.v1", storage: createJSONStorage(() => localStorage) },
  ),
);

export default function Tasks({}: AppProps) {
  const store = useTasks();
  const [drag, setDrag] = useState<string | null>(null);
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<TaskFilter | "archive">("all");
  const [quick, setQuick] = useState("");
  // The clock for overdue highlighting: read in an effect, never during render.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const nowDate = useMemo(() => new Date(now), [now]);
  const boardRef = useRef<HTMLDivElement>(null);

  const doneCol = store.columns.find((c) => c.id === "done")?.id ?? store.columns[store.columns.length - 1]?.id;
  const isDone = useCallback((t: Task) => t.column === doneCol, [doneCol]);
  const live = useMemo(() => store.tasks.filter((t) => !t.archivedAt), [store.tasks]);
  const archived = useMemo(() => store.tasks.filter((t) => t.archivedAt).sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)), [store.tasks]);
  const counts = useMemo(() => {
    const c: Record<TaskFilter, number> = { all: live.length, today: 0, upcoming: 0, overdue: 0, done: 0 };
    for (const t of live) for (const f of ["today", "upcoming", "overdue", "done"] as const) if (matchesFilter({ due: t.due, done: isDone(t) }, f, nowDate)) c[f]++;
    return c;
  }, [live, isDone, nowDate]);
  const parsed = useMemo(() => (quick.trim() ? parseQuickAdd(quick, nowDate) : null), [quick, nowDate]);

  const quickAdd = useCallback(() => {
    if (!quick.trim() || !store.columns[0]) return;
    // Parse against the real current time, not the render clock, which may be 30 s old.
    store.addParsed(store.columns[0].id, parseQuickAdd(quick, new Date()));
    setQuick("");
  }, [quick, store]);

  const setDone = useCallback((t: Task, done: boolean) => {
    if (done && doneCol) store.move(t.id, doneCol);
    else if (!done && store.columns[0]) store.move(t.id, store.columns[0].id);
  }, [store, doneCol]);

  const setDueIn = useCallback((id: string, days: number | null) => {
    if (days === null) { store.patch(id, { due: undefined, dueHasTime: undefined }); return; }
    const d = new Date();
    store.patch(id, { due: new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, 23, 59, 59, 999).getTime(), dueHasTime: false });
  }, [store]);

  const exportIcs = useCallback(() => {
    const d = new Date();
    const stamp = d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const r = tasksToIcs(live.filter((t) => !isDone(t)), stamp, `tasks-${d.getTime().toString(36)}`);
    if (!r.ok) { setError(r.reason); return; }
    download("tasks.ics", r.ics, "text/calendar");
    bus.emit("notify", { title: `Exported ${r.count} dated task${r.count === 1 ? "" : "s"} to tasks.ics`, body: r.skipped ? `${r.skipped} undated task${r.skipped === 1 ? " was" : "s were"} left out.` : undefined, kind: "success" });
  }, [live, isDone]);

  /* Right-click a card: done, priority, due date, archive. */
  useEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    return registerContextTarget(el, ({ target }: TargetContext) => {
      const id = (target.closest("[data-task-id]") as HTMLElement | null)?.dataset.taskId;
      const t = id ? useTasks.getState().tasks.find((x) => x.id === id) : undefined;
      if (!t) return null;
      const done = isDone(t);
      return {
        id: "tasks-card",
        entries: [
          { id: "done", label: done ? "Reopen" : "Mark done", icon: "check", run: () => setDone(t, !done) },
          { id: "open", label: "Edit details", icon: "tune", run: () => setSelected(t.id) },
          { id: "prio", label: "Priority", icon: "signals", submenu: (["high", "med", "low"] as const).map((p) => ({ id: p, label: p === "med" ? "Medium" : p === "high" ? "High" : "Low", checked: t.priority === p, run: () => store.patch(t.id, { priority: p }) })) },
          { id: "due", label: "Due date", icon: "calendar", submenu: [
            { id: "today", label: "Today", run: () => setDueIn(t.id, 0) },
            { id: "tomorrow", label: "Tomorrow", run: () => setDueIn(t.id, 1) },
            { id: "week", label: "In a week", run: () => setDueIn(t.id, 7) },
            { separator: true },
            { id: "clear", label: "No due date", disabled: t.due == null, run: () => setDueIn(t.id, null) },
          ] },
          { separator: true },
          { id: "archive", label: "Delete (to archive)", icon: "trash", danger: true, run: () => { store.archive(t.id); if (selected === t.id) setSelected(null); } },
        ],
      };
    });
  }, [store, isDone, setDone, setDueIn, selected]);

  const breakdown = useCallback(async () => {
    if (!goal.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      const res = await ask({
        messages: [{ role: "user", content: goal }],
        system: 'Break this goal into concrete, individually completable tasks. Return ONLY a JSON array of strings. Between 3 and 12 items. Each must be an action someone could start today, not a theme.',
        maxTokens: 900,
      });
      const start = res.text.indexOf("[");
      const end = res.text.lastIndexOf("]");
      const arr = JSON.parse(start !== -1 && end > start ? res.text.slice(start, end + 1) : res.text);
      if (!Array.isArray(arr)) throw new Error("Unexpected response shape.");
      store.addMany(store.columns[0].id, arr.map(String).filter(Boolean));
      setGoal("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Breakdown failed.");
    } finally { setBusy(false); }
  }, [goal, busy, store]);

  const task = store.tasks.find((t) => t.id === selected) ?? null;
  const exportMd = useMemo(
    () => store.columns.map((c) => `## ${c.name}\n\n${store.tasks.filter((t) => t.column === c.id).map((t) => `- [${c.id === "done" ? "x" : " "}] ${t.title}${t.notes ? `\n  ${t.notes}` : ""}`).join("\n") || "_(empty)_"}`).join("\n\n"),
    [store.columns, store.tasks],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border)] px-2.5 py-1.5">
        <input
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && breakdown()}
          placeholder="Describe a goal and let the model break it into tasks…"
          className="os-input min-w-40 flex-1 !py-1 text-[12px]"
        />
        <button className="os-btn !py-1 text-[11px]" onClick={breakdown} disabled={!goal.trim() || busy}>
          {busy ? "Working…" : "Break down"}
        </button>
        {busy && <Spinner />}
        <button className="os-btn !py-1 text-[11px]" onClick={store.addColumn}>+ Column</button>
        <button className="os-btn !py-1 text-[11px]" onClick={() => download("tasks.md", `# Task board\n\n${exportMd}`, "text/markdown")}>Export</button>
        <button className="os-btn !py-1 text-[11px]" onClick={exportIcs} title="Every open task with a due date, as a calendar file">Export .ics</button>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border)] px-2.5 py-1.5">
        <input
          value={quick}
          onChange={(e) => setQuick(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && quickAdd()}
          placeholder='Quick add: "tomorrow 3pm call Sam !high"'
          aria-label="Quick add a task in plain words"
          className="os-input min-w-40 flex-1 !py-1 text-[12px]"
        />
        {parsed && (
          <span className="os-chip !text-[10px]" data-testid="tasks-quick-preview">
            {parsed.title}
            {parsed.due != null && ` · ${formatDue(parsed.due, parsed.hasTime, nowDate)}`}
            {parsed.priority && ` · ${parsed.priority}`}
          </span>
        )}
        <button className="os-btn !py-1 text-[11px]" onClick={quickAdd} disabled={!quick.trim()}>Add</button>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1 px-2.5 pt-1.5" role="group" aria-label="Filter tasks">
        {(["all", "today", "upcoming", "overdue", "done"] as const).map((f) => (
          <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)} className={cn("os-btn !px-2 !py-0.5 text-[10.5px]", filter === f && "!border-[var(--accent)] !bg-[var(--accent)]/16", f === "overdue" && counts.overdue > 0 && "!text-[var(--danger)]")}>
            {f[0].toUpperCase() + f.slice(1)} <span className="tabular-nums opacity-70">{counts[f]}</span>
          </button>
        ))}
        <button aria-pressed={filter === "archive"} onClick={() => setFilter("archive")} className={cn("os-btn !px-2 !py-0.5 text-[10.5px]", filter === "archive" && "!border-[var(--accent)] !bg-[var(--accent)]/16")}>
          Archive <span className="tabular-nums opacity-70">{archived.length}</span>
        </button>
      </div>

      <div className="px-2.5 pt-2"><ErrorNote error={error} onDismiss={() => setError(null)} /></div>

      {filter === "archive" ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
          {archived.length === 0 ? (
            <div className="py-8 text-center text-[11px] text-[var(--muted)]">Nothing archived. Deleting a task moves it here, where it can be restored.</div>
          ) : archived.map((t) => (
            <div key={t.id} className="mb-1 flex items-center gap-2 rounded-[calc(var(--radius)*0.5)] border border-[var(--border)] px-2 py-1.5">
              <span className="min-w-0 flex-1 truncate text-[12px]">{t.title}</span>
              <span className="shrink-0 text-[10px] text-[var(--muted)]">{store.columns.find((c) => c.id === t.column)?.name ?? t.column}</span>
              <button className="os-btn !py-0.5 text-[11px]" onClick={() => store.unarchive(t.id)} aria-label={`Restore ${t.title}`}>Restore</button>
            </div>
          ))}
        </div>
      ) : (
      <div ref={boardRef} className="flex min-h-0 flex-1 gap-2.5 overflow-x-auto p-2.5">
        {store.columns.map((col) => {
          const colAll = live.filter((t) => t.column === col.id);
          const items = filter === "all" ? colAll : colAll.filter((t) => matchesFilter({ due: t.due, done: isDone(t) }, filter, nowDate));
          const overWip = col.wip > 0 && colAll.length > col.wip;
          return (
            <div
              key={col.id}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => { if (drag) store.move(drag, col.id); setDrag(null); }}
              className="flex w-64 shrink-0 flex-col rounded-[var(--radius)] border border-[var(--border)]"
              style={{ background: "color-mix(in srgb, var(--panel-solid) 40%, transparent)" }}
            >
              <div className="flex items-center gap-1.5 border-b border-[var(--border)] px-2 py-1.5">
                <input
                  value={col.name}
                  onChange={(e) => store.patchColumn(col.id, { name: e.target.value })}
                  className="min-w-0 flex-1 bg-transparent text-[12px] font-medium outline-none"
                />
                <span className={cn("os-chip !text-[10px]", overWip && "!border-[var(--danger)] !bg-[var(--danger)]/15")} title={col.wip ? `WIP limit ${col.wip}` : "No WIP limit"}>
                  {colAll.length}{col.wip ? `/${col.wip}` : ""}
                </span>
                <button className="text-[10px] opacity-50 hover:opacity-100" onClick={() => store.removeColumn(col.id)} title="Delete column"><Icon name="close" size={11} /></button>
              </div>

              <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-1.5">
                {items.map((t) => {
                  const bucket = isDone(t) ? "none" : dueBucket(t.due, nowDate);
                  const prog = checklistProgress(t.checklist);
                  return (
                  <div
                    key={t.id}
                    data-task-id={t.id}
                    draggable
                    onDragStart={() => setDrag(t.id)}
                    onDragEnd={() => setDrag(null)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => { e.stopPropagation(); if (drag && drag !== t.id) store.move(drag, col.id, t.id); setDrag(null); }}
                    onClick={() => setSelected(t.id === selected ? null : t.id)}
                    className={cn("os-card cursor-grab !p-2 active:cursor-grabbing", selected === t.id && "!border-[var(--accent)]", drag === t.id && "opacity-40", bucket === "overdue" && "!border-[var(--danger)]")}
                  >
                    <div className="flex items-start gap-1.5">
                      <span
                        className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ background: t.priority === "high" ? "var(--danger)" : t.priority === "low" ? "var(--muted)" : "var(--warn)" }}
                        title={`${t.priority} priority`}
                      />
                      <span className="min-w-0 flex-1 text-[12px] leading-snug">{t.title}</span>
                    </div>
                    {t.notes && <div className="mt-1 line-clamp-2 pl-3 text-[10.5px] text-[var(--muted)]">{t.notes}</div>}
                    {(t.due != null || prog.total > 0) && (
                      <div className="mt-1 flex flex-wrap items-center gap-1 pl-3 text-[10px]">
                        {t.due != null && (
                          <span
                            data-due-bucket={bucket}
                            className={cn("flex items-center gap-0.5 rounded px-1", bucket === "overdue" ? "bg-[var(--danger)]/18 text-[var(--danger)]" : bucket === "today" ? "bg-[var(--warn)]/18" : "text-[var(--muted)]")}
                          >
                            <Icon name="clock" size={9} />{bucket === "overdue" ? "Overdue · " : ""}{formatDue(t.due, Boolean(t.dueHasTime), nowDate)}
                          </span>
                        )}
                        {prog.total > 0 && <span className="flex items-center gap-0.5 text-[var(--muted)]"><Icon name="check" size={9} />{prog.done}/{prog.total}</span>}
                      </div>
                    )}
                  </div>
                  );
                })}
                <AddTask onAdd={(title) => store.add(col.id, title)} />
              </div>
            </div>
          );
        })}
      </div>
      )}

      {task && (
        <div className="shrink-0 border-t border-[var(--border)] p-2.5">
          <div className="mb-1.5 flex items-center gap-1.5">
            <input value={task.title} onChange={(e) => store.patch(task.id, { title: e.target.value })} className="os-input flex-1 !py-1 text-[12px] font-medium" />
            <select value={task.priority} onChange={(e) => store.patch(task.id, { priority: e.target.value as Task["priority"] })} className="os-input !w-auto !py-1 text-[11px]">
              <option value="low">low</option><option value="med">med</option><option value="high">high</option>
            </select>
            <button className="os-btn !py-1 text-[11px]" title="Archived tasks can be restored from the Archive filter" onClick={() => { store.archive(task.id); setSelected(null); }}>Archive</button>
            <button className="os-btn !py-1 text-[11px]" onClick={() => setSelected(null)}>Close</button>
          </div>
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
            <label className="flex items-center gap-1">
              <span className="text-[var(--muted)]">Due</span>
              <input
                type="datetime-local"
                aria-label="Due date and time"
                value={task.due != null ? toLocalIso(task.due) : ""}
                onChange={(e) => {
                  const ms = fromLocalIso(e.target.value);
                  store.patch(task.id, ms == null ? { due: undefined, dueHasTime: undefined } : { due: ms, dueHasTime: true });
                }}
                className="os-input !w-auto !py-0.5 text-[11px]"
              />
            </label>
            {task.due != null && <button className="os-btn !py-0.5 text-[10.5px]" onClick={() => setDueIn(task.id, null)}>Clear due</button>}
            <button className="os-btn !py-0.5 text-[10.5px]" onClick={() => setDone(task, !isDone(task))}>{isDone(task) ? "Reopen" : "Mark done"}</button>
          </div>
          <textarea value={task.notes} onChange={(e) => store.patch(task.id, { notes: e.target.value })} rows={2} placeholder="Notes…" className="os-input resize-none text-[12px]" />
          <Checklist
            items={task.checklist ?? []}
            onChange={(checklist) => store.patch(task.id, { checklist })}
          />
        </div>
      )}
    </div>
  );
}

function AddTask({ onAdd }: { onAdd: (title: string) => void }) {
  const [v, setV] = useState("");
  return (
    <input
      value={v}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter" && v.trim()) { onAdd(v.trim()); setV(""); } }}
      placeholder="+ Add task"
      className="w-full rounded-[calc(var(--radius)*0.5)] border border-dashed border-[var(--border)] bg-transparent px-2 py-1.5 text-[11.5px] outline-none focus:border-[var(--accent)]"
    />
  );
}

/** Subtasks as a checklist on the card. Items are edited in place. */
function Checklist({ items, onChange }: { items: CheckItem[]; onChange: (items: CheckItem[]) => void }) {
  const [v, setV] = useState("");
  const prog = checklistProgress(items);
  return (
    <div className="mt-1.5">
      <div className="mb-1 flex items-center gap-2 text-[10.5px] text-[var(--muted)]">
        <span>Checklist {prog.total > 0 && <span className="tabular-nums">{prog.done}/{prog.total}</span>}</span>
        {prog.total > 0 && (
          <div className="h-1 flex-1 overflow-hidden rounded bg-white/10" role="progressbar" aria-label="Checklist progress" aria-valuemin={0} aria-valuemax={prog.total} aria-valuenow={prog.done}>
            <div className="h-full bg-[var(--ok)]" style={{ width: `${(prog.done / prog.total) * 100}%` }} />
          </div>
        )}
      </div>
      <div className="max-h-32 space-y-0.5 overflow-y-auto">
        {items.map((it) => (
          <div key={it.id} className="flex items-center gap-1.5 text-[11.5px]">
            <input type="checkbox" checked={it.done} aria-label={`Done: ${it.text}`} onChange={() => onChange(items.map((x) => (x.id === it.id ? { ...x, done: !x.done } : x)))} />
            <span className={cn("min-w-0 flex-1 truncate", it.done && "text-[var(--muted)] line-through")}>{it.text}</span>
            <button className="opacity-50 hover:opacity-100" aria-label={`Remove ${it.text}`} onClick={() => onChange(items.filter((x) => x.id !== it.id))}><Icon name="close" size={10} /></button>
          </div>
        ))}
      </div>
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && v.trim()) { onChange([...items, { id: uid("chk"), text: v.trim(), done: false }]); setV(""); } }}
        placeholder="+ Add a subtask"
        aria-label="Add a subtask"
        className="mt-1 w-full rounded-[calc(var(--radius)*0.5)] border border-dashed border-[var(--border)] bg-transparent px-2 py-1 text-[11px] outline-none focus:border-[var(--accent)]"
      />
    </div>
  );
}
