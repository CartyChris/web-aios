"use client";

import { useEffect, useState } from "react";
import { useWM } from "@/kernel/wm";
import { bus } from "@/kernel/bus";
import { useJobs, goTo, isActive, type Job } from "@/kernel/jobs";
import type { Notification } from "@/kernel/types";
import { cn } from "@/lib/cn";
import { relTime } from "@/lib/format";
import { Icon } from "./icons";

/* Live notifications: what is running right now, and what just happened.

   Two sources, one stack. Jobs (kernel/jobs) are work in flight and stay on
   screen while they run, with a bar when they can measure progress and a
   spinner when they cannot. Notifications pop for a few seconds and then live
   on in the bell menu. Either one is a button: clicking it takes the user to
   the window the work belongs to. */

const TOAST_MS = 6000;

let recorderInstalled = false;

/** Span names whose caller already shows its own, richer job (AIOS Chat has
 *  step progress and approval buttons). Mirroring them too would put a second,
 *  vaguer row beside it, titled after whatever window happened to be focused. */
const SELF_TRACKED = new Set(["aios-chat"]);

/** Id prefix of the jobs this recorder creates, so it can tell its own
 *  generic rows from the ones an app made for itself. */
const MIRROR = "span-mirror-";

/** Every model call already emits a span (lib/useAI.ts). Mirroring those as
 *  jobs means every AI generation in every app gets a spinner for free,
 *  pointed at the window that was focused when it started. */
export function installJobRecorder(): () => void {
  if (recorderInstalled) return () => {};
  recorderInstalled = true;
  const spanJobs = new Map<string, string>();
  const off = bus.on("span", (p) => {
    const s = (p ?? {}) as { id?: string; kind?: string; name?: string; endedAt?: number; error?: string; tokensOut?: number };
    if (!s.id || s.kind !== "model" || (s.name && SELF_TRACKED.has(s.name))) return;
    const jobs = useJobs.getState();
    const known = spanJobs.get(s.id);
    if (!known && !s.endedAt) {
      const wm = useWM.getState();
      const win = wm.windows.find((w) => w.id === wm.focused);
      // An app that already shows its own job for this window (AI Studio's
      // build, Agent Loop, Asset Studio...) says more than "Generating in X"
      // can, so the generic mirror stays out of the way rather than doubling up.
      if (win && jobs.jobs.some((j) => !j.id.startsWith(MIRROR) && j.kind !== "load" && isActive(j) && j.target?.appId === win.appId)) return;
      const id = jobs.start({
        id: `${MIRROR}${s.id}`,
        kind: "ai",
        title: win ? `Generating in ${win.title}` : "AI generation",
        detail: s.name,
        target: win ? { appId: win.appId, windowId: win.id } : undefined,
      });
      spanJobs.set(s.id, id);
      return;
    }
    if (known && s.endedAt) {
      spanJobs.delete(s.id);
      if (s.error) jobs.finish(known, "error", s.error);
      else jobs.finish(known, "done", typeof s.tokensOut === "number" ? `${s.tokensOut} tokens` : undefined);
    }
  });
  return () => { recorderInstalled = false; off(); };
}

export function Spinner({ size = 12 }: { size?: number }) {
  return (
    <span
      role="progressbar"
      aria-label="Working"
      className="inline-block shrink-0 rounded-full border-2 border-[var(--accent)] border-t-transparent"
      style={{ width: size, height: size, animation: "os-spin 0.8s linear infinite" }}
    />
  );
}

export function ProgressBar({ value }: { value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Progress" className="mt-1 h-1 w-full overflow-hidden rounded-full bg-white/10">
      <div className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300" style={{ width: `${pct}%` }} />
    </div>
  );
}

const STATUS_ICON: Record<Job["status"], string> = { running: "refresh", blocked: "warning", done: "check", error: "close", timeout: "clock" };
const STATUS_COLOR: Record<Job["status"], string> = { running: "var(--accent)", blocked: "var(--warn)", done: "var(--ok)", error: "var(--danger)", timeout: "var(--warn)" };

/** One job row, shared by the toast stack and the bell menu. */
export function JobRow({ job, onNavigate }: { job: Job; onNavigate?: () => void }) {
  const remove = useJobs((s) => s.remove);
  const go = () => { goTo(job.target); onNavigate?.(); };
  return (
    <div className="os-card !p-2" data-job={job.id} data-status={job.status}>
      <div className="flex items-start gap-2">
        <span className="mt-0.5">
          {job.status === "running" && job.progress === undefined ? <Spinner /> : <Icon name={STATUS_ICON[job.status]} size={13} style={{ color: STATUS_COLOR[job.status] }} />}
        </span>
        <button className="min-w-0 flex-1 text-left" onClick={go} disabled={!job.target} aria-label={`${job.title}${job.target ? " — open" : ""}`}>
          <div className="truncate text-[12px] font-medium">{job.title}</div>
          {job.detail && <div className="truncate text-[11px] text-[var(--muted)]">{job.detail}</div>}
          {job.status === "blocked" && <div className="text-[11px] text-[var(--warn)]">Waiting for you</div>}
          {job.status === "timeout" && <div className="text-[11px] text-[var(--warn)]">Timed out waiting for you</div>}
          {job.status === "running" && job.progress !== undefined && <ProgressBar value={job.progress} />}
        </button>
        {!isActive(job) && (
          <button className="text-[var(--muted)] hover:text-[var(--text)]" onClick={() => remove(job.id)} aria-label="Dismiss"><Icon name="close" size={11} /></button>
        )}
      </div>
      {job.actions && job.actions.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5 pl-5">
          {job.actions.map((a) => (
            <button key={a.id} className="os-btn !px-2 !py-0.5 text-[11px]" onClick={() => a.run()}>{a.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

const KIND_ICON: Record<Notification["kind"], string> = { error: "close", warn: "warning", success: "check", info: "info" };
const KIND_COLOR: Record<Notification["kind"], string> = { error: "var(--danger)", warn: "var(--warn)", success: "var(--ok)", info: "var(--muted)" };

/** Where a notification leads: its own target, or the job it is about. */
export function notificationTarget(n: Notification) {
  if (n.target) return n.target;
  if (n.jobId) return useJobs.getState().jobs.find((j) => j.id === n.jobId)?.target;
  if (n.appId) return { appId: n.appId };
  return undefined;
}

export function NotificationRow({ n, onNavigate, onDismiss }: { n: Notification; onNavigate?: () => void; onDismiss: () => void }) {
  const job = useJobs((s) => (n.jobId ? s.jobs.find((j) => j.id === n.jobId) : undefined));
  const target = notificationTarget(n);
  return (
    <div className="os-card !p-2" data-notification={n.id}>
      <div className="flex items-start gap-2">
        <Icon name={KIND_ICON[n.kind]} size={13} style={{ marginTop: 2, color: KIND_COLOR[n.kind] }} />
        <button className="min-w-0 flex-1 text-left" onClick={() => { goTo(target); onNavigate?.(); }} disabled={!target} aria-label={`${n.title}${target ? " — open" : ""}`}>
          <div className="truncate text-[12px] font-medium">{n.title}</div>
          {n.body && <div className="text-[11px] text-[var(--muted)]">{n.body}</div>}
          <div className="mt-0.5 text-[10px] text-[var(--muted)]">{relTime(n.ts)}</div>
        </button>
        <button className="text-[var(--muted)] hover:text-[var(--text)]" onClick={onDismiss} aria-label="Dismiss"><Icon name="close" size={11} /></button>
      </div>
      {job?.actions && job.actions.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5 pl-5">
          {job.actions.map((a) => (
            <button key={a.id} className="os-btn !px-2 !py-0.5 text-[11px]" onClick={() => a.run()}>{a.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The on-screen stack. `compact` is the phone layout: top of the screen,
 *  full width, under the status bar. */
export function LiveToasts({ compact }: { compact?: boolean }) {
  const jobs = useJobs((s) => s.jobs);
  const notifications = useWM((s) => s.notifications);
  const dismiss = useWM((s) => s.dismiss);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  // Only notifications that arrive after this mounted pop up; the backlog
  // belongs in the bell menu, not in the user's face on every load.
  const [since] = useState(() => Date.now());

  useEffect(() => installJobRecorder(), []);

  const fresh = notifications.filter((n) => n.ts >= since && !hidden.has(n.id)).slice(0, 3);
  const freshKey = fresh.map((n) => n.id).join(",");

  useEffect(() => {
    if (!freshKey) return;
    const ids = freshKey.split(",");
    const t = setTimeout(() => setHidden((h) => new Set([...h, ...ids])), TOAST_MS);
    return () => clearTimeout(t);
  }, [freshKey]);

  // Blocked and timed-out jobs must stay visible: they need an answer.
  const live = jobs.filter((j) => j.status !== "done" || (j.endedAt ?? 0) > since).slice(0, 4);
  if (live.length === 0 && fresh.length === 0) return null;

  const hide = (id: string) => setHidden((h) => new Set([...h, id]));

  return (
    <div
      aria-live="polite"
      className={cn(
        "pointer-events-none fixed z-[9800] flex flex-col gap-1.5",
        compact ? "left-2 right-2" : "bottom-20 right-3 w-[320px] max-w-[calc(100vw-24px)]",
      )}
      style={compact ? { top: "calc(env(safe-area-inset-top) + 34px)" } : undefined}
      data-live-toasts
    >
      {live.map((j) => (
        <div key={j.id} className="glass pointer-events-auto rounded-xl" style={{ animation: "os-fade-up 0.18s ease-out" }}>
          <JobRow job={j} />
        </div>
      ))}
      {fresh.map((n) => (
        <div key={n.id} className="glass pointer-events-auto rounded-xl" style={{ animation: "os-fade-up 0.18s ease-out" }}>
          <NotificationRow n={n} onNavigate={() => hide(n.id)} onDismiss={() => { hide(n.id); dismiss(n.id); }} />
        </div>
      ))}
    </div>
  );
}
