"use client";

import { useMemo, useState } from "react";
import type { AppProps } from "@/kernel/types";
import { useJobs } from "@/kernel/jobs";
import { useVFS } from "@/kernel/vfs";
import { useWM } from "@/kernel/wm";
import { bus } from "@/kernel/bus";
import { useNow } from "@/lib/useNow";
import { focusStats } from "@/lib/focusstats";
import { buildBrief, briefText, type DeskAction, type DeskTask } from "@/lib/desk";
import { useFocus } from "./Focus";
import { Icon } from "@/shell/icons";

/* Desk: Claude Opus 5.5 at the front of the OS. It reads what is on this
   device (jobs, tasks, files, focus, notifications), tells you what needs you
   in order, and says out loud what it cannot see. The brief is computed by
   lib/desk.ts, not written by a model; "Plan my day" hands it to AIOS Chat as
   data when you want a conversation about it. */

function readTasks(): { tasks: DeskTask[]; done: string[] } {
  try {
    const st = (JSON.parse(localStorage.getItem("webaios.tasks.v1") || "{}") as { state?: { tasks?: DeskTask[]; columns?: Array<{ id: string; name: string }> } }).state;
    const done = (st?.columns ?? []).filter((c) => /done|complete|finished/i.test(c.name) || c.id === "done").map((c) => c.id);
    return { tasks: st?.tasks ?? [], done: done.length ? done : ["done"] };
  } catch {
    return { tasks: [], done: ["done"] };
  }
}

const TONE = ["var(--muted)", "var(--accent)", "var(--warn)", "var(--danger)"];

export default function Desk({}: AppProps) {
  const now = useNow(60_000);
  const jobs = useJobs((s) => s.jobs);
  const nodes = useVFS((s) => s.nodes);
  const unread = useWM((s) => s.notifications.filter((n) => !n.read).length);
  const log = useFocus((s) => s.log);
  const [epoch, setEpoch] = useState(0);

  const brief = useMemo(() => {
    void epoch;
    const { tasks, done } = readTasks();
    const d = new Date(now);
    const end = new Date(d); end.setHours(23, 59, 59, 999);
    const f = focusStats(log, d);
    return buildBrief({
      now, hour: d.getHours(), endOfDay: end.getTime(), tasks, doneColumns: done,
      jobs, files: Object.values(nodes).map((n) => ({ path: n.path, kind: n.kind, updatedAt: n.updatedAt, size: n.size })),
      unreadNotifications: unread, focusMinutesToday: f.todayMinutes, focusStreakDays: f.streakDays,
    });
  }, [now, jobs, nodes, unread, log, epoch]);

  const act = (a: DeskAction) => {
    if (a.kind === "open") bus.emit("app:open", { appId: a.appId, args: a.args });
    else bus.emit("aios-chat:ask", { prompt: a.prompt });
  };

  return (
    <div className="h-full overflow-y-auto p-4" data-desk>
      <div className="mb-1 text-[20px] font-semibold">{brief.greeting}.</div>
      <div className="mb-3 text-[13px] text-[var(--muted)]">{brief.headline}</div>

      <div className="mb-3 flex flex-wrap gap-1.5">
        <button className="os-btn" data-variant="primary" onClick={() => bus.emit("aios-chat:ask", { prompt: "Plan the rest of my day from this brief. Most important first, realistic about time, and say what you would skip.", context: { label: "the Desk brief", text: briefText(brief) } })}>
          <Icon name="sparkles" size={13} /> Plan my day
        </button>
        <button className="os-btn" onClick={() => setEpoch((e) => e + 1)} aria-label="Refresh the brief"><Icon name="refresh" size={13} /></button>
      </div>

      <div className="space-y-1.5">
        {brief.items.map((i) => (
          <div key={i.id} className="os-card flex items-start gap-2 !p-2.5" style={{ borderLeft: `3px solid ${TONE[i.urgency]}` }} data-desk-item={i.id}>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12.5px] font-medium">{i.title}</div>
              <div className="text-[11.5px] text-[var(--muted)]">{i.detail}</div>
            </div>
            {i.action && <button className="os-btn shrink-0 !py-1 text-[11px]" onClick={() => act(i.action!)}>{i.actionLabel ?? "Open"}</button>}
          </div>
        ))}
      </div>

      <details className="mt-4 text-[11px] text-[var(--muted)]">
        <summary className="cursor-pointer">What I cannot see</summary>
        <ul className="mt-1 list-disc pl-4">{brief.blindSpots.map((s) => <li key={s}>{s}</li>)}</ul>
      </details>
      <p className="mt-3 text-[10.5px] text-[var(--muted)]">
        Claude Opus 5.5 here. I read what is on this device and nothing else; every line above comes from a real record, and where I cannot see, I say so.
      </p>
    </div>
  );
}
