"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { ProjectFile } from "@/lib/scaffold";
import { makeVersion, appendVersion, revertTo, type AppVersion, type VersionSource } from "@/lib/appversions";
import { uid } from "@/lib/format";

/* ────────────────────────────────────────────────────────────────────────────
   Apps you built.

   This lives in the kernel rather than inside AI Studio because three other
   surfaces need it — the desktop resolves a pinned icon through it, the pin
   picker lists from it, and the launcher shows it — and none of them should
   have to import a whole app module to read a list.

   An app is one of two things. An "html" app is a single self-contained
   document: it runs by being handed to an iframe, and that is the whole story.
   A "project" app is real source — React, TypeScript, three.js — that would
   normally need a build step, so it carries both its files (editable,
   exportable, still a real project) and a compiled preview document (what
   actually runs when you open it). Keeping both is the point: you get a thing
   that runs from your desktop AND a thing you can open in an editor.
   ──────────────────────────────────────────────────────────────────────────── */

export interface UserApp {
  id: string;
  name: string;
  /** The runnable document. For a project this is the linked preview. */
  html: string;
  icon: string;
  createdAt: number;
  updatedAt: number;
  kind?: "html" | "project";
  /** Present for projects: the real source, for export and further editing. */
  files?: ProjectFile[];
  /** Which scaffold target it was built as. */
  target?: string;
  /** The prompt it came from, so it can be refined later. */
  prompt?: string;
}

interface UserAppState {
  apps: UserApp[];
  /** Version history per app id. See lib/appversions.ts for the rules —
   *  reverting appends, and the first version is never pruned away. */
  versions: Record<string, AppVersion[]>;
  install: (name: string, html: string, icon: string, extra?: Partial<UserApp>) => string;
  installProject: (name: string, files: ProjectFile[], html: string, target: string, icon?: string, prompt?: string) => string;
  update: (id: string, patch: Partial<UserApp>) => void;
  rename: (id: string, name: string, icon: string) => void;
  remove: (id: string) => void;
  get: (id: string) => UserApp | undefined;

  /** Replace an app's content AND record it as a version. Every AI rewrite
   *  goes through here, which is what makes one undoable. */
  commit: (id: string, next: { html: string; files?: ProjectFile[] }, meta: { source: VersionSource; prompt?: string; label?: string }) =>
    { ok: true; versionId: string } | { ok: false; reason: string };
  /** Restore an earlier version by appending a copy of it. */
  revertApp: (id: string, versionId: string) => { ok: true } | { ok: false; reason: string };
  historyFor: (id: string) => AppVersion[];
}

export const useUserApps = create<UserAppState>()(
  persist(
    (set, get) => ({
      apps: [],
      versions: {},
      install: (name, html, icon, extra) => {
        const id = uid("uapp");
        const now = Date.now();
        const first = makeVersion({ id: uid("ver"), at: now, source: "install", html, files: extra?.files });
        set((s) => ({
          apps: [{ id, name, html, icon, kind: "html", createdAt: now, updatedAt: now, ...extra }, ...s.apps],
          versions: { ...s.versions, [id]: [first] },
        }));
        return id;
      },
      installProject: (name, files, html, target, icon = "layers", prompt) => {
        const id = uid("uapp");
        const now = Date.now();
        const first = makeVersion({ id: uid("ver"), at: now, source: "install", html, files, prompt });
        set((s) => ({
          apps: [{ id, name, html, icon, kind: "project", files, target, prompt, createdAt: now, updatedAt: now }, ...s.apps],
          versions: { ...s.versions, [id]: [first] },
        }));
        return id;
      },
      update: (id, patch) => set((s) => ({ apps: s.apps.map((a) => (a.id === id ? { ...a, ...patch, updatedAt: Date.now() } : a)) })),
      rename: (id, name, icon) => set((s) => ({ apps: s.apps.map((a) => (a.id === id ? { ...a, name, icon, updatedAt: Date.now() } : a)) })),
      // Removing an app takes its history with it. Orphaned version arrays are
      // invisible and each one holds whole documents — that is how a quota
      // fills up with data nothing can reach.
      remove: (id) => set((s) => {
        const versions = { ...s.versions };
        delete versions[id];
        return { apps: s.apps.filter((a) => a.id !== id), versions };
      }),
      get: (id) => get().apps.find((a) => a.id === id),

      // Compute first, commit after. A zustand updater must stay pure, so the
      // append is decided out here and `set` only writes the result.
      commit: (id, next, meta) => {
        const state = get();
        const app = state.apps.find((a) => a.id === id);
        if (!app) return { ok: false, reason: `There is no app with id ${id}.` };

        const history = state.versions[id] ?? [];
        const version = makeVersion({
          id: uid("ver"),
          at: Date.now(),
          source: meta.source,
          html: next.html,
          files: next.files,
          prompt: meta.prompt,
          label: meta.label,
          parentId: history[history.length - 1]?.id ?? null,
        });
        const appended = appendVersion(history, version);
        if (!appended.ok) return { ok: false, reason: appended.reason };

        set((s) => ({
          apps: s.apps.map((a) =>
            a.id === id ? { ...a, html: next.html, ...(next.files ? { files: next.files } : {}), updatedAt: version.at } : a,
          ),
          versions: { ...s.versions, [id]: appended.history },
        }));
        return { ok: true, versionId: version.id };
      },

      revertApp: (id, versionId) => {
        const state = get();
        if (!state.apps.some((a) => a.id === id)) return { ok: false, reason: `There is no app with id ${id}.` };
        const history = state.versions[id] ?? [];
        const reverted = revertTo(history, versionId, uid("ver"), Date.now());
        if (!reverted.ok) return { ok: false, reason: reverted.reason };

        const appended = appendVersion(history, reverted.version);
        if (!appended.ok) return { ok: false, reason: appended.reason };

        const v = reverted.version;
        set((s) => ({
          apps: s.apps.map((a) =>
            a.id === id ? { ...a, html: v.html, ...(v.files ? { files: v.files } : {}), updatedAt: v.at } : a,
          ),
          versions: { ...s.versions, [id]: appended.history },
        }));
        return { ok: true };
      },

      historyFor: (id) => get().versions[id] ?? [],
    }),
    {
      // Same storage key the old HTML Studio used, so nothing anyone already
      // built disappears when the app is replaced.
      name: "webaios.studio.v1",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
