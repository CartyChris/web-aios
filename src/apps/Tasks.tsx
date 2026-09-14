"use client";

import { useCallback, useMemo, useState } from "react";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { ask } from "@/lib/useAI";
import type { AppProps } from "@/kernel/types";
import { uid, download } from "@/lib/format";
import { ErrorNote, Spinner } from "./_ui";
import { cn } from "@/lib/cn";
import { Icon } from "@/shell/icons";

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
      </div>

      <div className="px-2.5 pt-2"><ErrorNote error={error} onDismiss={() => setError(null)} /></div>

      <div className="flex min-h-0 flex-1 gap-2.5 overflow-x-auto p-2.5">
        {store.columns.map((col) => {
          const items = store.tasks.filter((t) => t.column === col.id);
          const overWip = col.wip > 0 && items.length > col.wip;
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
                  {items.length}{col.wip ? `/${col.wip}` : ""}
                </span>
                <button className="text-[10px] opacity-50 hover:opacity-100" onClick={() => store.removeColumn(col.id)} title="Delete column"><Icon name="close" size={11} /></button>
              </div>

              <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-1.5">
                {items.map((t) => (
                  <div
                    key={t.id}
                    draggable
                    onDragStart={() => setDrag(t.id)}
                    onDragEnd={() => setDrag(null)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => { e.stopPropagation(); if (drag && drag !== t.id) store.move(drag, col.id, t.id); setDrag(null); }}
                    onClick={() => setSelected(t.id === selected ? null : t.id)}
                    className={cn("os-card cursor-grab !p-2 active:cursor-grabbing", selected === t.id && "!border-[var(--accent)]", drag === t.id && "opacity-40")}
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
                  </div>
                ))}
                <AddTask onAdd={(title) => store.add(col.id, title)} />
              </div>
            </div>
          );
        })}
      </div>

      {task && (
        <div className="shrink-0 border-t border-[var(--border)] p-2.5">
          <div className="mb-1.5 flex items-center gap-1.5">
            <input value={task.title} onChange={(e) => store.patch(task.id, { title: e.target.value })} className="os-input flex-1 !py-1 text-[12px] font-medium" />
            <select value={task.priority} onChange={(e) => store.patch(task.id, { priority: e.target.value as Task["priority"] })} className="os-input !w-auto !py-1 text-[11px]">
              <option value="low">low</option><option value="med">med</option><option value="high">high</option>
            </select>
            <button className="os-btn !py-1 text-[11px]" onClick={() => { store.remove(task.id); setSelected(null); }}>Delete</button>
            <button className="os-btn !py-1 text-[11px]" onClick={() => setSelected(null)}>Close</button>
          </div>
          <textarea value={task.notes} onChange={(e) => store.patch(task.id, { notes: e.target.value })} rows={2} placeholder="Notes…" className="os-input resize-none text-[12px]" />
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
