"use client";

import { create } from "zustand";
import { useWM } from "@/kernel/wm";
import { bus } from "@/kernel/bus";

/* Live work the user should be able to see and reach: model generations,
   automated tasks, apps still loading, an agent waiting on a permission.

   Deliberately not persisted. A job describes a promise that is in flight in
   THIS tab; after a reload the promise is gone, so a restored "running" row
   would be a spinner that never stops. Finished jobs linger briefly so a
   result can be clicked, then fall off.

   `target` is where a click takes the user: the app to open (or focus), with
   the args it was opened with. `progress` is 0..1 when the work can measure
   itself and undefined when it cannot, which the UI draws as a spinner rather
   than a bar that pretends to know. */

export type JobStatus = "running" | "blocked" | "done" | "error" | "timeout";

export interface JobTarget {
  appId: string;
  args?: Record<string, unknown>;
  /** Focus this exact window if it still exists, instead of opening another. */
  windowId?: string;
}

export interface JobAction {
  id: string;
  label: string;
  run: () => void;
}

export interface Job {
  id: string;
  title: string;
  detail?: string;
  kind: "ai" | "task" | "load" | "agent";
  status: JobStatus;
  progress?: number;
  target?: JobTarget;
  /** Buttons shown on the job: Approve / Deny while blocked, Redo after a timeout. */
  actions?: JobAction[];
  startedAt: number;
  endedAt?: number;
}

interface JobsState {
  jobs: Job[];
  start: (j: Omit<Job, "id" | "status" | "startedAt"> & { id?: string; status?: JobStatus }) => string;
  update: (id: string, patch: Partial<Omit<Job, "id" | "startedAt">>) => void;
  finish: (id: string, status?: "done" | "error" | "timeout", detail?: string) => void;
  remove: (id: string) => void;
  clearFinished: () => void;
}

const CAP = 40;
let seq = 0;

export const useJobs = create<JobsState>()((set, get) => ({
  jobs: [],
  start: (j) => {
    const id = j.id ?? `job-${Date.now().toString(36)}-${(seq++).toString(36)}`;
    const job: Job = { ...j, id, status: j.status ?? "running", startedAt: Date.now() };
    set((s) => ({ jobs: [job, ...s.jobs.filter((x) => x.id !== id)].slice(0, CAP) }));
    return id;
  },
  update: (id, patch) => set((s) => ({ jobs: s.jobs.map((x) => (x.id === id ? { ...x, ...patch } : x)) })),
  finish: (id, status = "done", detail) => {
    if (!get().jobs.some((x) => x.id === id)) return;
    set((s) => ({
      jobs: s.jobs.map((x) =>
        x.id === id ? { ...x, status, progress: status === "done" ? 1 : x.progress, endedAt: Date.now(), actions: status === "timeout" ? x.actions : undefined, ...(detail !== undefined ? { detail } : {}) } : x,
      ),
    }));
    // Successful work clears itself; failures stay until the user looks.
    if (status === "done") setTimeout(() => get().remove(id), 8000);
  },
  remove: (id) => set((s) => ({ jobs: s.jobs.filter((x) => x.id !== id) })),
  clearFinished: () => set((s) => ({ jobs: s.jobs.filter((x) => x.status === "running" || x.status === "blocked") })),
}));

export const isActive = (j: Job) => j.status === "running" || j.status === "blocked";

/** Run `work` as a visible job. The job ends with the promise either way. */
export async function trackJob<T>(
  init: Omit<Job, "id" | "status" | "startedAt">,
  work: (report: (progress: number | undefined, detail?: string) => void) => Promise<T>,
): Promise<T> {
  const jobs = useJobs.getState();
  const id = jobs.start(init);
  try {
    const out = await work((progress, detail) => useJobs.getState().update(id, { progress, ...(detail ? { detail } : {}) }));
    useJobs.getState().finish(id, "done");
    return out;
  } catch (e) {
    useJobs.getState().finish(id, "error", e instanceof Error ? e.message : String(e));
    throw e;
  }
}

/** Take the user to a job's or notification's target: focus the exact window
 *  if it still exists, otherwise open the app. Emits `shell:show-app` so the
 *  phone shell leaves its home screen for the app view. */
export function goTo(target: JobTarget | undefined): void {
  if (!target) return;
  const wm = useWM.getState();
  const win = target.windowId ? wm.windows.find((w) => w.id === target.windowId) : undefined;
  if (win) wm.restore(win.id);
  else bus.emit("app:open", { appId: target.appId, args: target.args });
  bus.emit("shell:show-app", { appId: target.appId });
}
