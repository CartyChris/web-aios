"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

/* ────────────────────────────────────────────────────────────────────────────
   Easter eggs.

   A registry rather than a scattering of `if (key === "k")` checks, for two
   reasons: the Arcade can list what exists without hard-coding it twice, and
   every egg can be switched off by one setting — an OS that plays a jingle at
   someone mid-demo because they typed the wrong thing is not charming.

   Nothing here is hidden from the code. It is hidden from the *interface*,
   which is the only place a secret is any fun.
   ──────────────────────────────────────────────────────────────────────────── */

export interface Egg {
  id: string;
  name: string;
  /** Shown once found. Before that the Arcade shows the hint instead. */
  reveal: string;
  hint: string;
}

export const EGGS: Egg[] = [
  { id: "konami", name: "The Code", reveal: "↑ ↑ ↓ ↓ ← → ← → B A, anywhere on the desktop.", hint: "Thirty lives, if you remember where." },
  { id: "matrix", name: "Follow the white rabbit", reveal: "Type “matrix” on the desktop.", hint: "Six letters. You already know them." },
  { id: "party", name: "Party mode", reveal: "Type “party” on the desktop — the accent hue cycles until you do it again.", hint: "Five letters, and the colours will tell you when it works." },
  { id: "gravity", name: "Gravity", reveal: "Type “drop” on the desktop and watch the icons.", hint: "Something is holding your icons up. Ask it not to." },
  { id: "pet", name: "Persistent", reveal: "Click your desktop pet ten times in a row.", hint: "Be annoying to something small." },
  { id: "clock", name: "Time served", reveal: "Click the clock in the top bar seven times.", hint: "The clock is also a button. It just does not say so." },
  { id: "arcade", name: "High roller", reveal: "Beat 2,048 in the sliding-tile game.", hint: "The game is named after it." },
  { id: "void", name: "The void", reveal: "Delete every icon on your desktop.", hint: "Take everything away and see what is left." },
];

interface EggState {
  found: string[];
  find: (id: string) => boolean;
  reset: () => void;
}

export const useEggs = create<EggState>()(
  persist(
    (set, get) => ({
      found: [],
      /** Returns true only the first time, so a caller can celebrate once
       *  rather than every time the trigger fires. */
      find: (id) => {
        if (get().found.includes(id)) return false;
        set((s) => ({ found: [...s.found, id] }));
        return true;
      },
      reset: () => set({ found: [] }),
    }),
    { name: "webaios.eggs.v1", storage: createJSONStorage(() => localStorage) },
  ),
);

const KONAMI = [
  "arrowup", "arrowup", "arrowdown", "arrowdown",
  "arrowleft", "arrowright", "arrowleft", "arrowright", "b", "a",
];

/** Watch the keyboard for every sequence-based egg.
 *
 *  One listener for all of them: a separate listener per egg would mean eight
 *  handlers racing on every keystroke of every text field in the OS. */
export function watchSequences(onEgg: (id: string) => void): () => void {
  let konami = 0;
  let typed = "";
  const WORDS: Record<string, string> = { matrix: "matrix", party: "party", drop: "gravity" };

  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    // Never fire while someone is writing. Typing "party" into a note should
    // produce the word "party".
    if (t && (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable)) return;

    const k = e.key.toLowerCase();
    konami = k === KONAMI[konami] ? konami + 1 : k === KONAMI[0] ? 1 : 0;
    if (konami === KONAMI.length) { konami = 0; onEgg("konami"); }

    if (/^[a-z]$/.test(k)) {
      typed = (typed + k).slice(-12);
      for (const [word, id] of Object.entries(WORDS)) {
        if (typed.endsWith(word)) { typed = ""; onEgg(id); }
      }
    }
  };

  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}
