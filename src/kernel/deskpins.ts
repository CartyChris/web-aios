/** Panels pinned from AIOS Chat to the Desk.
 *
 *  A pin is a copy of a panel the agent produced, kept so the Desk can show it
 *  later. Stored panels are re-validated through parsePanel on load, exactly as
 *  a fresh model reply is, so storage edited by hand (or by a future version
 *  with a different shape) can never put anything on the Desk that the
 *  allowlist would refuse.
 */
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { parsePanel, type Panel } from "@/lib/aios-agent";

export const MAX_DESK_PINS = 8;

export interface DeskPin {
  id: string;
  /** The answer the panel came with, shortened, so the pin keeps its context. */
  caption: string;
  panel: Panel;
  pinnedAt: number;
}

interface DeskPinState {
  pins: DeskPin[];
  pin: (panel: Panel, caption: string) => DeskPin;
  unpin: (id: string) => void;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export const useDeskPins = create<DeskPinState>()(
  persist(
    (set, get) => ({
      pins: [],
      pin: (panel, caption) => {
        const existing = get().pins.find((p) => sameJson(p.panel, panel));
        if (existing) return existing;
        const pin: DeskPin = { id: `pin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, caption: caption.trim().slice(0, 160), panel, pinnedAt: Date.now() };
        // Newest first; the oldest falls off past the cap.
        set((s) => ({ pins: [pin, ...s.pins].slice(0, MAX_DESK_PINS) }));
        return pin;
      },
      unpin: (id) => set((s) => ({ pins: s.pins.filter((p) => p.id !== id) })),
    }),
    {
      name: "webaios.deskpins.v1",
      storage: createJSONStorage(() => localStorage),
      merge: (persisted, current) => {
        const raw = (persisted as { pins?: unknown } | undefined)?.pins;
        const pins: DeskPin[] = [];
        for (const p of Array.isArray(raw) ? raw : []) {
          if (!p || typeof p !== "object") continue;
          const r = parsePanel((p as { panel?: unknown }).panel);
          const q = p as { id?: unknown; caption?: unknown; pinnedAt?: unknown };
          if (r.ok && typeof q.id === "string") {
            pins.push({ id: q.id, caption: typeof q.caption === "string" ? q.caption.slice(0, 160) : "", panel: r.panel, pinnedAt: typeof q.pinnedAt === "number" ? q.pinnedAt : 0 });
          }
        }
        return { ...current, pins: pins.slice(0, MAX_DESK_PINS) };
      },
    },
  ),
);
