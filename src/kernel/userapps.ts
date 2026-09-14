"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { ProjectFile } from "@/lib/scaffold";
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
  install: (name: string, html: string, icon: string, extra?: Partial<UserApp>) => string;
  installProject: (name: string, files: ProjectFile[], html: string, target: string, icon?: string, prompt?: string) => string;
  update: (id: string, patch: Partial<UserApp>) => void;
  rename: (id: string, name: string, icon: string) => void;
  remove: (id: string) => void;
  get: (id: string) => UserApp | undefined;
}

export const useUserApps = create<UserAppState>()(
  persist(
    (set, get) => ({
      apps: [],
      install: (name, html, icon, extra) => {
        const id = uid("uapp");
        const now = Date.now();
        set((s) => ({ apps: [{ id, name, html, icon, kind: "html", createdAt: now, updatedAt: now, ...extra }, ...s.apps] }));
        return id;
      },
      installProject: (name, files, html, target, icon = "layers", prompt) => {
        const id = uid("uapp");
        const now = Date.now();
        set((s) => ({ apps: [{ id, name, html, icon, kind: "project", files, target, prompt, createdAt: now, updatedAt: now }, ...s.apps] }));
        return id;
      },
      update: (id, patch) => set((s) => ({ apps: s.apps.map((a) => (a.id === id ? { ...a, ...patch, updatedAt: Date.now() } : a)) })),
      rename: (id, name, icon) => set((s) => ({ apps: s.apps.map((a) => (a.id === id ? { ...a, name, icon, updatedAt: Date.now() } : a)) })),
      remove: (id) => set((s) => ({ apps: s.apps.filter((a) => a.id !== id) })),
      get: (id) => get().apps.find((a) => a.id === id),
    }),
    {
      // Same storage key the old HTML Studio used, so nothing anyone already
      // built disappears when the app is replaced.
      name: "webaios.studio.v1",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
