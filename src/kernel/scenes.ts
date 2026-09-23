/** Saved desktop arrangements.
 *
 *  All the geometry and validation is in src/lib/scenes.ts, which is pure and
 *  tested. This is the part that cannot be: reading the live windows and
 *  putting them back.
 */
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { useWM, workArea } from "./wm";
import { getApp } from "./registry";
import { bus } from "./bus";
import { captureScene, planRestore, parseScene, type Scene } from "@/lib/scenes";
import { encodeHandoff, decodeHandoff } from "@/lib/handoff";
import { useJobs } from "./jobs";

interface SceneState {
  scenes: Scene[];
  /** Capture every window on every workspace, under `name`. */
  save: (name: string) => Scene;
  /** Put a scene back. `replace` closes what is open first. */
  restore: (id: string, opts?: { replace?: boolean }) => { ok: boolean; opened: number; missing: string[] };
  remove: (id: string) => void;
  rename: (id: string, name: string) => void;
  importJson: (json: string) => { ok: boolean; error?: string };
}

export const useScenes = create<SceneState>()(
  persist(
    (set, get) => ({
      scenes: [],

      save: (name) => {
        const wm = useWM.getState();
        const scene = captureScene(
          name,
          // Minimized windows are part of the arrangement: you minimized them
          // on purpose, and a scene that silently drops them is lossy.
          wm.windows.map((w) => ({
            appId: w.appId, title: w.title, x: w.x, y: w.y, w: w.w, h: w.h,
            state: w.state, workspace: w.workspace, pinned: w.pinned, args: w.args,
          })),
          wm.activeWorkspace,
          workArea(),
          Date.now(),
        );
        set((s) => ({ scenes: [scene, ...s.scenes.filter((x) => x.id !== scene.id)].slice(0, 40) }));
        bus.emit("notify", { title: `Saved "${scene.name}"`, body: `${scene.windows.length} window(s)`, kind: "success" });
        return scene;
      },

      restore: (id, opts) => {
        const scene = get().scenes.find((s) => s.id === id);
        if (!scene) return { ok: false, opened: 0, missing: [] };
        const wm = useWM.getState();
        const plan = planRestore(scene, workArea(), (appId) => !!getApp(appId));

        if (opts?.replace) {
          // Close everything first so a restore is a restore, not a merge.
          for (const w of [...wm.windows]) useWM.getState().close(w.id);
        }

        for (const p of plan.open) {
          const app = getApp(p.appId);
          if (!app) continue;
          const winId = useWM.getState().open(p.appId, {
            title: app.name, icon: app.icon, size: { w: p.w, h: p.h },
            // A scene places windows itself, so never let resolveOpen focus an
            // existing one: that would silently drop a window from the scene.
            forceNew: true,
            workspace: p.workspace,
            args: p.args,
            at: { x: p.x, y: p.y },
          });
          const s = useWM.getState();
          s.move(winId, p.x, p.y);
          s.resize(winId, p.w, p.h);
          if (p.pinned) s.togglePin(winId);
          if (p.state === "maximized") s.toggleMaximize(winId);
          else if (p.state === "minimized") s.minimize(winId);
        }
        useWM.getState().setWorkspace(plan.activeWorkspace);

        bus.emit("notify", {
          title: `Restored "${scene.name}"`,
          body: plan.missing.length ? `${plan.missing.length} app(s) no longer exist: ${plan.missing.join(", ")}` : `${plan.open.length} window(s)`,
          kind: plan.missing.length ? "warn" : "success",
        });
        return { ok: true, opened: plan.open.length, missing: plan.missing };
      },

      remove: (id) => set((s) => ({ scenes: s.scenes.filter((x) => x.id !== id) })),
      rename: (id, name) =>
        set((s) => ({ scenes: s.scenes.map((x) => (x.id === id ? { ...x, name: name.trim().slice(0, 60) || x.name } : x)) })),

      importJson: (json) => {
        const r = parseScene(json, Date.now());
        if (!r.ok) return { ok: false, error: r.reason };
        set((s) => ({ scenes: [r.scene, ...s.scenes.filter((x) => x.id !== r.scene.id)].slice(0, 40) }));
        return { ok: true };
      },
    }),
    { name: "webaios.scenes.v1", storage: createJSONStorage(() => localStorage) },
  ),
);

/* ── Handoff: this desktop, on another device ────────────────────────────── */

/** Everything open right now, as a scene, without saving it. */
export function currentScene(name: string): Scene {
  const wm = useWM.getState();
  return captureScene(
    name,
    wm.windows.map((w) => ({
      appId: w.appId, title: w.title, x: w.x, y: w.y, w: w.w, h: w.h,
      state: w.state, workspace: w.workspace, pinned: w.pinned, args: w.args,
    })),
    wm.activeWorkspace,
    workArea(),
    Date.now(),
  );
}

/** A link that reopens what is open now on whatever device follows it. */
export function handoffUrl(): { url: string; windows: number; dropped: number } {
  const scene = currentScene(`Handed off ${new Date().toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`);
  const { code, dropped } = encodeHandoff(scene);
  return { url: `${location.origin}${location.pathname}#handoff=${code}`, windows: scene.windows.length - dropped, dropped };
}

/** If this page was opened from a handoff link, offer to open what it
 *  carries. Asks first: anyone can craft a link, and a page that opens forty
 *  windows because a URL said so is not one to trust. The fragment is cleared
 *  either way so a reload does not ask again. */
export function receiveHandoff(): void {
  if (typeof location === "undefined" || !/[#&]handoff=/.test(location.hash)) return;
  const r = decodeHandoff(location.hash, Date.now());
  history.replaceState(null, "", location.pathname + location.search);
  if (!r.ok) {
    bus.emit("notify", { title: "That handoff link could not be opened", body: r.reason, kind: "warn" });
    return;
  }
  const scene = r.scene;
  const apps = [...new Set(scene.windows.map((w) => getApp(w.appId)?.name).filter(Boolean))];
  const jobs = useJobs.getState();
  const id = jobs.start({
    kind: "task", status: "blocked",
    title: `Open a handed-off desktop? ${scene.windows.length} window${scene.windows.length === 1 ? "" : "s"}`,
    detail: apps.slice(0, 6).join(", ") + (apps.length > 6 ? ` and ${apps.length - 6} more` : ""),
    actions: [
      {
        id: "open", label: "Open them", run: () => {
          useScenes.setState((s) => ({ scenes: [scene, ...s.scenes.filter((x) => x.id !== scene.id)].slice(0, 40) }));
          useScenes.getState().restore(scene.id);
          useJobs.getState().finish(id, "done", "Opened; also saved under Scenes.");
        },
      },
      { id: "dismiss", label: "Not now", run: () => useJobs.getState().remove(id) },
    ],
  });
  bus.emit("notify", { title: "A desktop was handed to this device", body: "Open it from the live notification, or dismiss it.", kind: "info", jobId: id });
}
