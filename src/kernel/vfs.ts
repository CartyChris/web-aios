"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

/** A single flat, path-addressed store that every app shares. Notes, the IDE,
 *  snippet vault, exported artifacts and agent transcripts all land here, which
 *  is what makes cross-app workflows (write in Chat → open in IDE) possible. */
export interface VNode {
  path: string;
  name: string;
  kind: "file" | "dir";
  mime: string;
  content: string;
  size: number;
  createdAt: number;
  updatedAt: number;
  appId?: string;
  tags?: string[];
  starred?: boolean;
}

export interface VFSState {
  nodes: Record<string, VNode>;
  write: (path: string, content: string, meta?: Partial<VNode>) => VNode;
  read: (path: string) => VNode | undefined;
  remove: (path: string) => void;
  rename: (from: string, to: string) => boolean;
  list: (dir?: string) => VNode[];
  search: (q: string) => VNode[];
  mkdir: (path: string) => void;
  star: (path: string) => void;
  usage: () => { count: number; bytes: number };
  exportAll: () => string;
  importAll: (json: string) => number;
  clear: () => void;
}

const norm = (p: string) => "/" + p.replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
const base = (p: string) => norm(p).split("/").pop() || "/";
const dirOf = (p: string) => {
  const parts = norm(p).split("/");
  parts.pop();
  return parts.join("/") || "/";
};

function guessMime(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    md: "text/markdown", txt: "text/plain", json: "application/json",
    html: "text/html", css: "text/css", js: "text/javascript", ts: "text/typescript",
    tsx: "text/typescript", jsx: "text/javascript", py: "text/x-python", sh: "text/x-sh",
    csv: "text/csv", svg: "image/svg+xml", yml: "text/yaml", yaml: "text/yaml",
  };
  return map[ext] ?? "text/plain";
}

export const useVFS = create<VFSState>()(
  persist(
    (set, get) => ({
      nodes: {},

      write: (path, content, meta = {}) => {
        const p = norm(path);
        const now = Date.now();
        const prev = get().nodes[p];
        const node: VNode = {
          path: p,
          name: base(p),
          kind: "file",
          mime: meta.mime ?? guessMime(base(p)),
          content,
          size: new Blob([content]).size,
          createdAt: prev?.createdAt ?? now,
          updatedAt: now,
          ...meta,
        };
        set((s) => ({ nodes: { ...s.nodes, [p]: node } }));
        return node;
      },

      read: (path) => get().nodes[norm(path)],

      remove: (path) =>
        set((s) => {
          const p = norm(path);
          const next = { ...s.nodes };
          // Removing a directory takes its whole subtree with it.
          for (const k of Object.keys(next)) if (k === p || k.startsWith(p + "/")) delete next[k];
          return { nodes: next };
        }),

      rename: (from, to) => {
        const f = norm(from), t = norm(to);
        const s = get();
        if (!s.nodes[f] || s.nodes[t]) return false;
        const node = { ...s.nodes[f], path: t, name: base(t), updatedAt: Date.now() };
        const next = { ...s.nodes };
        delete next[f];
        next[t] = node;
        set({ nodes: next });
        return true;
      },

      list: (dir = "/") => {
        const d = norm(dir);
        return Object.values(get().nodes)
          .filter((n) => dirOf(n.path) === d)
          .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
      },

      search: (q) => {
        const needle = q.trim().toLowerCase();
        if (!needle) return [];
        return Object.values(get().nodes)
          .filter((n) => n.name.toLowerCase().includes(needle) || n.content.toLowerCase().includes(needle))
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, 100);
      },

      mkdir: (path) => {
        const p = norm(path);
        if (get().nodes[p]) return;
        const now = Date.now();
        set((s) => ({
          nodes: { ...s.nodes, [p]: { path: p, name: base(p), kind: "dir", mime: "inode/directory", content: "", size: 0, createdAt: now, updatedAt: now } },
        }));
      },

      star: (path) =>
        set((s) => {
          const p = norm(path);
          const n = s.nodes[p];
          return n ? { nodes: { ...s.nodes, [p]: { ...n, starred: !n.starred } } } : s;
        }),

      usage: () => {
        const nodes = Object.values(get().nodes);
        return { count: nodes.length, bytes: nodes.reduce((a, n) => a + n.size, 0) };
      },

      exportAll: () => JSON.stringify({ __webaios_vfs: 1, nodes: get().nodes }, null, 2),

      importAll: (json) => {
        try {
          const parsed = JSON.parse(json);
          const incoming: Record<string, VNode> = parsed?.nodes ?? parsed;
          if (!incoming || typeof incoming !== "object") return 0;
          const valid = Object.entries(incoming).filter(([, v]) => v && typeof v === "object" && "content" in v);
          set((s) => ({ nodes: { ...s.nodes, ...Object.fromEntries(valid) } }));
          return valid.length;
        } catch {
          return 0;
        }
      },

      clear: () => set({ nodes: {} }),
    }),
    { name: "webaios.vfs.v1", storage: createJSONStorage(() => localStorage) },
  ),
);
