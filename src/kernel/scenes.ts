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
