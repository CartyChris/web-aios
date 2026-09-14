"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { bus } from "@/kernel/bus";
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
      endsAt: null, mode: "work", workMin: 25, breakMin: 5, completed: 0, paused: null,
      start: (mode) => set({ mode, endsAt: Date.now() + (mode === "work" ? get().workMin : get().breakMin) * 60_000, paused: null }),
      stop: () => set({ endsAt: null, paused: null }),
      pause: () => { const e = get().endsAt; if (e) set({ paused: e - Date.now(), endsAt: null }); },
      resume: () => { const p = get().paused; if (p) set({ endsAt: Date.now() + p, paused: null }); },
      setWork: (m) => set({ workMin: m }),
      setBreak: (m) => set({ breakMin: m }),
      complete: () => set((s) => ({ completed: s.completed + (s.mode === "work" ? 1 : 0), endsAt: null })),
    }),
    { name: "webaios.focus.v1", storage: createJSONStorage(() => localStorage) },
  ),
);

export default function Focus({}: AppProps) {
  const f = useFocus();
  const [now, setNow] = useState(() => Date.now());
  const fired = useRef(false);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  const remaining = f.endsAt ? Math.max(0, f.endsAt - now) : f.paused ?? 0;
  const total = (f.mode === "work" ? f.workMin : f.breakMin) * 60_000;
  const pct = total > 0 ? 1 - remaining / total : 0;

  useEffect(() => {
    if (f.endsAt && remaining === 0 && !fired.current) {
      fired.current = true;
      bus.emit("notify", {
        title: f.mode === "work" ? "Focus session finished" : "Break over",
        body: f.mode === "work" ? "Take a break." : "Back to it.",
        kind: "success",
      });
      f.complete();
      setTimeout(() => (fired.current = false), 1000);
    }
  }, [remaining, f]);

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

      <div className="os-chip">{f.completed} focus sessions completed</div>

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
