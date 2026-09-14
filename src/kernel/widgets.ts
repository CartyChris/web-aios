"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

/* ────────────────────────────────────────────────────────────────────────────
   Custom widgets.

   A widget the user describes in a sentence and the model writes. It runs as a
   self-contained HTML document inside a sandboxed iframe — no same-origin
   access, so a generated widget can never read the OS's stored API keys, touch
   localStorage, or reach into the page that hosts it. That isolation is what
   makes "let a model write code and run it on my desktop" a reasonable thing
   to offer rather than a foot-gun.

   The host injects the live theme tokens on every render, so a widget written
   months ago still matches whatever palette is active today.
   ──────────────────────────────────────────────────────────────────────────── */

export interface CustomWidget {
  id: string;
  name: string;
  /** The prompt it was built from, kept so it can be re-generated or refined. */
  prompt: string;
  /** Body markup + styles + script. Wrapped by the host at render time. */
  html: string;
  icon: string;
  createdAt: number;
  updatedAt: number;
  /** Default size when first placed on the desktop. */
  w: number;
  h: number;
}

interface CustomWidgetState {
  widgets: CustomWidget[];
  add: (w: Omit<CustomWidget, "id" | "createdAt" | "updatedAt">) => string;
  update: (id: string, patch: Partial<CustomWidget>) => void;
  remove: (id: string) => void;
  get: (id: string) => CustomWidget | undefined;
  importOne: (json: string) => { ok: boolean; id?: string; error?: string };
}

export const useCustomWidgets = create<CustomWidgetState>()(
  persist(
    (set, get) => ({
      widgets: [],
      add: (w) => {
        const id = `cw_${Math.random().toString(36).slice(2, 9)}`;
        const now = Date.now();
        set((s) => ({ widgets: [{ ...w, id, createdAt: now, updatedAt: now }, ...s.widgets] }));
        return id;
      },
      update: (id, patch) =>
        set((s) => ({ widgets: s.widgets.map((x) => (x.id === id ? { ...x, ...patch, updatedAt: Date.now() } : x)) })),
      remove: (id) => set((s) => ({ widgets: s.widgets.filter((x) => x.id !== id) })),
      get: (id) => get().widgets.find((x) => x.id === id),
      importOne: (json) => {
        try {
          const parsed = JSON.parse(json);
          const w = parsed?.widget ?? parsed;
          if (!w || typeof w.html !== "string") return { ok: false, error: "Not a Web-AIOS widget file." };
          const id = get().add({
            name: String(w.name ?? "Imported widget"),
            prompt: String(w.prompt ?? ""),
            html: String(w.html),
            icon: String(w.icon ?? "widgets"),
            w: Number(w.w) || 260,
            h: Number(w.h) || 170,
          });
          return { ok: true, id };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : "Invalid JSON." };
        }
      },
    }),
    { name: "webaios.customwidgets.v1", storage: createJSONStorage(() => localStorage) },
  ),
);

/** The full document a widget runs inside.
 *
 *  Theme tokens are inlined rather than inherited, because the iframe is a
 *  separate document and cannot read the host's custom properties. */
export function widgetDocument(html: string, tokens: Record<string, string>): string {
  const vars = Object.entries(tokens)
    .map(([k, v]) => `${k}:${v};`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{${vars}}
*{box-sizing:border-box}
html,body{margin:0;height:100%;overflow:hidden;background:transparent;color:var(--text);
  font-family:var(--font-ui,ui-sans-serif,system-ui,sans-serif);font-size:13px;-webkit-font-smoothing:antialiased}
body{padding:2px}
a{color:var(--accent)}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--muted) 35%,transparent);border-radius:99px}
</style></head><body>
${html}
</body></html>`;
}

/** A standalone, themeable copy the user can open anywhere — the export form. */
export function widgetStandalone(w: CustomWidget, tokens: Record<string, string>): string {
  const doc = widgetDocument(w.html, tokens);
  return doc.replace(
    "<body>",
    `<body>\n<!-- ${w.name} — exported from Web-AIOS on ${new Date().toISOString()}\n     Built from the prompt: ${w.prompt.replace(/--+>/g, "->")}\n     This file is self-contained: open it in any browser, or embed it in a page. -->`,
  );
}
