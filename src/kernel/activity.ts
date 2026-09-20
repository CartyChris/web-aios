"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { bus } from "@/kernel/bus";
import { useVFS } from "@/kernel/vfs";
import { useUserApps } from "@/kernel/userapps";
import { useCustomWidgets } from "@/kernel/widgets";
import { useHarness } from "@/kernel/harness";
import type { InterestSignal, SignalSource } from "@/lib/interest-types";

/* What the user deliberately did, remembered in THIS browser only, so the
   model in the top bar can suggest things they would actually want. Nothing
   here leaves the device unless the user presses "Suggest", and even then only
   the extracted terms go — never these raw signals (see lib/interests.ts). */

const SOURCES = new Set<SignalSource>(["chat", "file", "app", "widget", "search", "harness", "service"]);
const LOG_CAP = 300;
const TOTAL_CAP = 600;
const TEXT_CAP = 200;

interface ActivityState {
  log: InterestSignal[];
  record: (s: InterestSignal) => void;
  clear: () => void;
}

export const useActivity = create<ActivityState>()(
  persist(
    (set) => ({
      log: [],
      // Newest first, capped at write time: a long session must not grow this
      // into a quota problem for every other store on the origin.
      record: (s) => set((st) => ({ log: [s, ...st.log].slice(0, LOG_CAP) })),
      clear: () => set({ log: [] }),
    }),
    { name: "webaios.activity.v1", storage: createJSONStorage(() => localStorage) },
  ),
);

let installed = false;

/** Idempotent: a StrictMode double-mount must not record every event twice. */
export function installActivityRecorder(): () => void {
  if (installed) return () => {};
  installed = true;
  const off = bus.on("activity", (p) => {
    const payload = (p ?? {}) as { source?: unknown; text?: unknown; weight?: unknown };
    const source = payload.source as SignalSource;
    const text = typeof payload.text === "string" ? payload.text.trim().slice(0, TEXT_CAP) : "";
    if (!SOURCES.has(source) || !text) return;
    const weight = typeof payload.weight === "number" && Number.isFinite(payload.weight) ? payload.weight : undefined;
    useActivity.getState().record({ source, text, at: Date.now(), ...(weight !== undefined ? { weight } : {}) });
  });
  return () => { installed = false; off(); };
}

export function clearActivity(): void {
  useActivity.getState().clear();
}

/** The chat store lives inside the Chat app; importing an app file from the
 *  kernel would invert the dependency, so its persisted copy is read instead. */
function chatSignals(): InterestSignal[] {
  try {
    const raw = localStorage.getItem("webaios.chat.v1");
    if (!raw) return [];
    const threads = (JSON.parse(raw) as { state?: { threads?: unknown } }).state?.threads;
    if (!Array.isArray(threads)) return [];
    const out: InterestSignal[] = [];
    for (const t of threads.slice(0, 60)) {
      const th = t as { title?: unknown; updatedAt?: unknown; turns?: unknown };
      const at = typeof th.updatedAt === "number" ? th.updatedAt : 0;
      if (typeof th.title === "string" && th.title.trim()) out.push({ source: "chat", text: th.title.slice(0, TEXT_CAP), at });
      // The person's own words only. The model's replies say what the model
      // knows, not what the user cares about.
      if (Array.isArray(th.turns)) {
        for (const u of th.turns) {
          const turn = u as { role?: unknown; content?: unknown; ts?: unknown };
          if (turn.role === "user" && typeof turn.content === "string" && turn.content.trim()) {
            out.push({ source: "chat", text: turn.content.slice(0, TEXT_CAP), at: typeof turn.ts === "number" ? turn.ts : at });
          }
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function gatherSignals(): InterestSignal[] {
  const out: InterestSignal[] = [...useActivity.getState().log];

  for (const n of Object.values(useVFS.getState().nodes)) {
    if (n.kind !== "file" || n.path.startsWith("/harness/")) continue; // machine receipts, not interests
    out.push({ source: "file", text: n.path, at: n.updatedAt, ...(n.path.startsWith("/opendata/") ? { weight: 0.5 } : {}) });
  }
  for (const a of useUserApps.getState().apps) {
    out.push({ source: "app", text: `${a.name} ${a.prompt ?? ""}`.trim(), at: a.updatedAt });
  }
  for (const w of useCustomWidgets.getState().widgets) {
    out.push({ source: "widget", text: `${w.name} ${w.prompt}`.trim(), at: w.updatedAt });
  }
  for (const r of useHarness.getState().runs) {
    out.push({ source: "harness", text: r.objective, at: r.startedAt });
  }
  out.push(...chatSignals());

  return out.sort((a, b) => b.at - a.at).slice(0, TOTAL_CAP);
}
