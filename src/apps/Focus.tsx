"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { bus } from "@/kernel/bus";
import { useJobs } from "@/kernel/jobs";
import { focusStats, clampMinutes, sessionProgress, type FocusSession } from "@/lib/focusstats";
import type { AppProps } from "@/kernel/types";
import { Slider } from "./_ui";
import { cn } from "@/lib/cn";

/** Focus — a Pomodoro timer that keeps running when its window is closed.
 *
 *  The state is a target timestamp, not a countdown integer. That is the whole
 *  trick: a tab that is backgrounded or a window that is closed cannot drift,
 *  because nothing is being decremented. */
interface FocusState {
  endsAt: number | null;
  mode: "work" | "break";
  workMin: number;
  breakMin: number;
  completed: number;
  paused: number | null;
  /** Finished sessions only — every stat on screen is computed from this. */
  log: FocusSession[];
  /** The length the running session was started with, so changing the
   *  slider mid-session cannot make the progress bar jump. */
  sessionMin: number | null;
  start: (mode: "work" | "break") => void;
  stop: () => void;
  pause: () => void;
  resume: () => void;
  setWork: (m: number) => void;
  setBreak: (m: number) => void;
  complete: () => void;
}

export const useFocus = create<FocusState>()(
  persist(
    (set, get) => ({
      endsAt: null, mode: "work", workMin: 25, breakMin: 5, completed: 0, paused: null, log: [], sessionMin: null,
      start: (mode) => {
        const min = mode === "work" ? get().workMin : get().breakMin;
        set({ mode, endsAt: Date.now() + min * 60_000, paused: null, sessionMin: min });
      },
      stop: () => set({ endsAt: null, paused: null, sessionMin: null }),
      pause: () => { const e = get().endsAt; if (e) set({ paused: e - Date.now(), endsAt: null }); },
      resume: () => { const p = get().paused; if (p) set({ endsAt: Date.now() + p, paused: null }); },
      setWork: (m) => set({ workMin: m }),
      setBreak: (m) => set({ breakMin: m }),
      complete: () => set((s) => ({
        completed: s.completed + (s.mode === "work" ? 1 : 0),
        endsAt: null,
        log: [...s.log, { endedAt: Date.now(), minutes: s.sessionMin ?? (s.mode === "work" ? s.workMin : s.breakMin), mode: s.mode }].slice(-1000),
        sessionMin: null,
      })),
    }),
    { name: "webaios.focus.v1", storage: createJSONStorage(() => localStorage) },
  ),
);

/* ── the session watcher ─────────────────────────────────────────────────────
   Lives at module level, not in the component, so the end-of-session
   notification fires with the Focus window CLOSED (it used to fire only while
   the window was mounted). It also mirrors the session into the jobs kernel,
   so the running timer shows as a live job with a real progress bar in the
   shell, and clicking it comes back here. */
const JOB_ID = "focus-session";
let watcher: ReturnType<typeof setInterval> | null = null;

function tick() {
  const f = useFocus.getState();
  const jobs = useJobs.getState();
  const has = jobs.jobs.some((j) => j.id === JOB_ID && (j.status === "running" || j.status === "blocked"));
  if (!f.endsAt) {
    // Paused or stopped: the job goes away rather than showing a frozen bar.
    if (has) jobs.remove(JOB_ID);
    if (!f.paused && watcher) { clearInterval(watcher); watcher = null; }
    return;
  }
  const totalMs = (f.sessionMin ?? (f.mode === "work" ? f.workMin : f.breakMin)) * 60_000;
  const now = Date.now();
  const progress = sessionProgress(f.endsAt, totalMs, now);
  const left = Math.max(0, Math.ceil((f.endsAt - now) / 60_000));
  const title = f.mode === "work" ? "Focus session" : "Break";
  if (now >= f.endsAt) {
    const mode = f.mode;
    f.complete();
    if (has) jobs.finish(JOB_ID, "done", mode === "work" ? "Session complete" : "Break over");
    bus.emit("notify", {
      title: mode === "work" ? "Focus session finished" : "Break over",
      body: mode === "work" ? "Take a break." : "Back to it.",
      kind: "success",
      appId: "focus",
      target: { appId: "focus" },
    });
    return;
  }
  if (!has) jobs.start({ id: JOB_ID, title, detail: `${left} min left`, kind: "task", progress, target: { appId: "focus" } });
  else jobs.update(JOB_ID, { title, progress, detail: `${left} min left` });
}

function ensureWatcher() {
  if (typeof window === "undefined" || watcher) return;
  watcher = setInterval(tick, 1000);
  tick();
}

// A session restored from storage after a reload resumes being watched.
if (typeof window !== "undefined") {
  const resume = () => { if (useFocus.getState().endsAt || useFocus.getState().paused) ensureWatcher(); };
  if (useFocus.persist.hasHydrated()) resume();
  else useFocus.persist.onFinishHydration(resume);
  useFocus.subscribe((st, prev) => { if (st.endsAt !== prev.endsAt) { ensureWatcher(); tick(); } });
}

export default function Focus({}: AppProps) {
  const f = useFocus();
  const [now, setNow] = useState(() => Date.now());
  const [custom, setCustom] = useState("");

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  const remaining = f.endsAt ? Math.max(0, f.endsAt - now) : f.paused ?? 0;
  const total = (f.endsAt || f.paused ? f.sessionMin ?? (f.mode === "work" ? f.workMin : f.breakMin) : f.mode === "work" ? f.workMin : f.breakMin) * 60_000;
  const pct = total > 0 ? Math.min(1, Math.max(0, 1 - remaining / total)) : 0;
  const stats = useMemo(() => focusStats(f.log ?? [], new Date(now)), [f.log, now]);
  const maxDay = Math.max(1, ...stats.last7);

  const mmss = useCallback((ms: number) => {
    const s = Math.ceil(ms / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }, []);

  const running = f.endsAt !== null;
  const R = 86;
  const C = 2 * Math.PI * R;

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-5">
      <div className="flex gap-1.5">
        {(["work", "break"] as const).map((m) => (
          <button
            key={m}
            onClick={() => f.start(m)}
            className={cn("os-btn !py-1 text-[11px]", f.mode === m && "!border-[var(--accent)] !bg-[var(--accent)]/16")}
          >
            {m === "work" ? `Focus ${f.workMin}m` : `Break ${f.breakMin}m`}
          </button>
        ))}
      </div>

      <div className="relative grid place-items-center">
        <svg width={200} height={200} className="-rotate-90">
          <circle cx={100} cy={100} r={R} fill="none" stroke="var(--border)" strokeWidth={10} />
          <circle
            cx={100} cy={100} r={R} fill="none"
            stroke={f.mode === "work" ? "var(--accent)" : "var(--ok)"}
            strokeWidth={10} strokeLinecap="round"
            strokeDasharray={C} strokeDashoffset={C * (1 - pct)}
            style={{ transition: "stroke-dashoffset 250ms linear" }}
          />
        </svg>
        <div className="absolute text-center">
          <div className="tabular-nums text-4xl font-light">{mmss(remaining || total)}</div>
          <div className="text-[11px] text-[var(--muted)]">{running ? f.mode : f.paused ? "paused" : "ready"}</div>
        </div>
      </div>

      <div className="flex gap-1.5">
        {running ? (
          <button className="os-btn" onClick={f.pause}>Pause</button>
        ) : f.paused ? (
          <button className="os-btn" data-variant="primary" onClick={f.resume}>Resume</button>
        ) : (
          <button className="os-btn" data-variant="primary" onClick={() => f.start(f.mode)}>Start</button>
        )}
        <button className="os-btn" onClick={f.stop} disabled={!running && !f.paused}>Reset</button>
      </div>

      {(running || f.paused) && (
        <div className="w-full max-w-64" role="progressbar" aria-label="Session progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct * 100)}>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full" style={{ width: `${pct * 100}%`, background: f.mode === "work" ? "var(--accent)" : "var(--ok)", transition: "width 250ms linear" }} />
          </div>
          <div className="mt-0.5 text-center text-[10px] tabular-nums text-[var(--muted)]">{Math.round(pct * 100)}% · also shown in the jobs tray</div>
        </div>
      )}

      <div className="os-chip">{f.completed} focus sessions completed</div>

      <div className="grid w-full max-w-72 grid-cols-3 gap-1.5 text-center" data-testid="focus-stats">
        {[
          ["Today", `${stats.todaySessions}`, `${stats.todayMinutes} min`],
          ["7 days", `${stats.weekMinutes}`, "minutes"],
          ["Streak", `${stats.streakDays}`, stats.streakDays === 1 ? "day" : "days"],
        ].map(([label, big, small]) => (
          <div key={label} className="os-card !p-1.5">
            <div className="text-[10px] text-[var(--muted)]">{label}</div>
            <div className="text-[18px] font-light tabular-nums">{big}</div>
            <div className="text-[10px] text-[var(--muted)]">{small}</div>
          </div>
        ))}
      </div>
      <div className="flex h-10 w-full max-w-72 items-end gap-1" aria-label="Focus minutes per day, last 7 days">
        {stats.last7.map((m, i) => (
          <div key={i} className="flex flex-1 flex-col items-center gap-0.5" title={`${m} min`}>
            <div className="w-full rounded-sm bg-[var(--accent)]" style={{ height: `${Math.max(2, (m / maxDay) * 32)}px`, opacity: m ? 1 : 0.25 }} />
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-center gap-1">
        {[15, 25, 50, 90].map((m) => (
          <button key={m} className={cn("os-btn !px-2 !py-0.5 text-[10.5px]", f.workMin === m && "!border-[var(--accent)]")} onClick={() => f.setWork(m)} aria-label={`Set focus length to ${m} minutes`}>{m}m</button>
        ))}
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value.replace(/[^0-9]/g, ""))}
          onKeyDown={(e) => { if (e.key === "Enter" && custom) { f.setWork(clampMinutes(Number(custom))); setCustom(""); } }}
          inputMode="numeric"
          placeholder="custom"
          aria-label="Custom focus length in minutes, press Enter"
          className="os-input !w-20 !py-0.5 text-center text-[11px]"
        />
      </div>

      <div className="w-full max-w-56">
        <Slider label="Focus length" value={f.workMin} min={5} max={90} step={5} onChange={f.setWork} format={(v) => `${v} min`} />
        <Slider label="Break length" value={f.breakMin} min={1} max={30} onChange={f.setBreak} format={(v) => `${v} min`} />
      </div>

      <div className="max-w-64 text-center text-[10.5px] text-[var(--muted)]">
        The timer runs off a target time, so it keeps counting correctly with this window closed or the tab in the background.
      </div>
    </div>
  );
}
