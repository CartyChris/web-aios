/** Each pet's life (lib/petlife.ts), kept per species id so switching pets
 *  does not reset the one you raised. Stored lives are re-validated on load. */
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { act, newLife, parseLife, react, tick, visit, type ActionResult, type OsEvent, type PetAction, type PetLife, type PetMood } from "@/lib/petlife";

interface PetLifeState {
  lives: Record<string, PetLife>;
  get: (pet: string) => PetLife;
  refresh: (pet: string) => { newDay: boolean; life: PetLife };
  act: (pet: string, action: PetAction) => ActionResult;
  react: (pet: string, ev: OsEvent) => { mood: PetMood; line: string };
  setAccessory: (pet: string, id: string | null) => void;
}

const tz = () => new Date().getTimezoneOffset();

export const usePetLife = create<PetLifeState>()(
  persist(
    (set, get) => ({
      lives: {},
      get: (pet) => get().lives[pet] ?? newLife(Date.now()),
      refresh: (pet) => {
        const now = Date.now();
        const v = visit(tick(get().get(pet), now), now, tz());
        set((s) => ({ lives: { ...s.lives, [pet]: v.life } }));
        return v;
      },
      act: (pet, action) => {
        const r = act(get().get(pet), action, Date.now());
        set((s) => ({ lives: { ...s.lives, [pet]: r.life } }));
        return r;
      },
      react: (pet, ev) => {
        const r = react(tick(get().get(pet), Date.now()), ev);
        set((s) => ({ lives: { ...s.lives, [pet]: r.life } }));
        return { mood: r.mood, line: r.line };
      },
      setAccessory: (pet, id) => set((s) => ({ lives: { ...s.lives, [pet]: { ...get().get(pet), accessory: id } } })),
    }),
    {
      name: "webaios.petlife.v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ lives: s.lives }),
      merge: (persisted, current) => {
        const raw = (persisted as { lives?: unknown } | undefined)?.lives;
        const lives: Record<string, PetLife> = {};
        if (raw && typeof raw === "object") for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (/^[\w-]{1,60}$/.test(k)) lives[k] = parseLife(v, Date.now());
        return { ...current, lives };
      },
    },
  ),
);
