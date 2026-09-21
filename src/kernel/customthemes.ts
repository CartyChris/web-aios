/** Themes that were not shipped with the OS.
 *
 *  Kept in their own store rather than appended to THEMES so that the built-in
 *  catalogue stays a constant: a theme a model invented must never be able to
 *  shadow or delete one of the fifty. `allThemes()` is the merge, and every
 *  place that listed THEMES now lists that instead, which is what makes a
 *  generated theme a first-class citizen in the palette, the Terminal and
 *  Personalize without any of them knowing where it came from.
 */
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { THEMES, type Theme } from "./themes";

interface CustomThemeState {
  themes: Theme[];
  add: (t: Theme) => void;
  remove: (id: string) => void;
}

export const useCustomThemes = create<CustomThemeState>()(
  persist(
    (set) => ({
      themes: [],
      add: (t) =>
        set((s) => ({
          // A built-in id can never be taken over, and re-adding the same
          // generated id replaces rather than duplicates.
          themes: THEMES.some((b) => b.id === t.id)
            ? s.themes
            : [t, ...s.themes.filter((x) => x.id !== t.id)].slice(0, 120),
        })),
      remove: (id) => set((s) => ({ themes: s.themes.filter((t) => t.id !== id) })),
    }),
    { name: "webaios.customthemes.v1", storage: createJSONStorage(() => localStorage) },
  ),
);

/** Built-ins first, then generated ones.
 *
 *  Called with no argument it reads the store directly, which is right for
 *  one-shot lookups (settings resolution, a Terminal command). A COMPONENT
 *  that must re-render when a theme is added should subscribe and pass the
 *  result in: `allThemes(useCustomThemes((s) => s.themes))`. Passing it makes
 *  the dependency real rather than something the React Compiler has to be
 *  told to ignore, and keeps this the only place the two lists are merged. */
export const allThemes = (generated?: Theme[]): Theme[] => [
  ...THEMES,
  ...(generated ?? useCustomThemes.getState().themes),
];

export const findTheme = (id: string): Theme | undefined => allThemes().find((t) => t.id === id);
