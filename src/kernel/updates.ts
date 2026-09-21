/** The system update ledger.
 *
 *  Every apply writes a version recording the previous value of everything it
 *  touched, so revert is a replay rather than a reset. That distinction
 *  matters: "restore defaults" would also throw away the user's own changes
 *  that the update never went near.
 *
 *  All the decisions live in src/lib/sysupdate.ts, which is pure and tested.
 *  This file is only the part that cannot be: reading and writing the stores.
 */
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { useSettings } from "./settings";
import { useCustomWidgets } from "./widgets";
import { useCustomThemes } from "./customthemes";
import { bus } from "./bus";
import {
  TUNABLE, planApply, planRevert, describe,
  type UpdateProposal, type SystemVersion, type ProposedTuning,
} from "@/lib/sysupdate";

/** The live value of every tunable key, which is what a plan is computed
 *  against and what a revert is checked against. */
export function currentTuning(): Record<string, number | boolean | string> {
  const s = useSettings.getState() as unknown as Record<string, unknown>;
  const out: Record<string, number | boolean | string> = {};
  for (const t of TUNABLE) {
    const v = s[t.key];
    if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") out[t.key] = v;
  }
  return out;
}

const writeTuning = (rows: ProposedTuning[]) => {
  const set = useSettings.getState().set as (k: string, v: unknown) => void;
  for (const r of rows) set(r.key, r.value);
};

interface UpdateState {
  versions: SystemVersion[];
  apply: (p: UpdateProposal, include?: { themes?: boolean[]; widgets?: boolean[]; tuning?: boolean[] }) => SystemVersion | null;
  revert: (versionId: string) => { ok: boolean; skipped: string[] };
  forget: (versionId: string) => void;
}

export const useUpdates = create<UpdateState>()(
  persist(
    (set, get) => ({
      versions: [],

      apply: (proposal, include) => {
        const before = currentTuning();
        const plan = planApply(proposal, before, include);
        if (!plan.changes.length) return null;

        const settings = useSettings.getState();
        // Snapshot the two things a theme switch destroys, BEFORE touching
        // either: applyTheme clears customVars on purpose, so without this the
        // user's hand-tuned tokens would not survive a revert.
        const version: SystemVersion = {
          id: `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
          at: Date.now(),
          title: proposal.title,
          summary: proposal.summary,
          changes: plan.changes,
          prevThemeId: settings.themeId,
          prevVars: { ...settings.customVars },
        };

        for (const t of plan.addThemes) useCustomThemes.getState().add(t);
        plan.addWidgets.forEach((w, i) => {
          const id = useCustomWidgets.getState().add({
            name: w.name, prompt: `System update: ${proposal.title}`,
            html: w.html, icon: "widgets", w: w.w, h: w.h,
          });
          // Record the real id so revert removes exactly this widget. Addressed
          // by INDEX, not by matching the label: planApply emits themes, then
          // widgets, then tuning, in order, so widget i is always at this slot.
          // Matching on the name would be ambiguous for two widgets called the
          // same thing, and an update may propose several.
          const rec = version.changes[plan.addThemes.length + i];
          if (rec && rec.kind === "widget") rec.ref = id;
          useSettings.getState().addWidget("custom", { customId: id, w: w.w, h: w.h });
        });
        writeTuning(plan.setTuning);
        if (plan.selectThemeId) useSettings.getState().applyTheme(plan.selectThemeId);

        set((s) => ({ versions: [version, ...s.versions].slice(0, 60) }));
        bus.emit("notify", { title: `Applied "${proposal.title}"`, body: describe(proposal), kind: "success" });
        return version;
      },

      revert: (versionId) => {
        const version = get().versions.find((v) => v.id === versionId);
        if (!version) return { ok: false, skipped: [] };
        const { restoreTuning, removeThemeIds, skipped } = planRevert(version, currentTuning());

        writeTuning(restoreTuning);
        for (const c of version.changes) {
          if (c.kind === "widget" && c.ref) {
            useCustomWidgets.getState().remove(c.ref);
            // And take it off the desktop, or a dead tile is left behind.
            const s = useSettings.getState();
            for (const w of s.widgets) {
              // customId sits at the TOP level of a widget item, not inside
              // config -- reading it from config matched nothing and left the
              // dead tile on the desktop.
              if (w.kind === "custom" && w.customId === c.ref) s.removeWidget(w.id);
            }
          }
        }
        // Theme last: applyTheme clears customVars, so restoring the tokens has
        // to happen after it, not before.
        useSettings.getState().applyTheme(version.prevThemeId);
        const setVar = useSettings.getState().setVar;
        for (const [k, v] of Object.entries(version.prevVars)) setVar(k, v);
        for (const id of removeThemeIds) useCustomThemes.getState().remove(id);

        set((s) => ({ versions: s.versions.map((v) => (v.id === versionId ? { ...v, revertedAt: Date.now() } : v)) }));
        bus.emit("notify", {
          title: `Reverted "${version.title}"`,
          body: skipped.length ? `${skipped.length} setting(s) left alone — you changed them since.` : undefined,
          kind: "info",
        });
        return { ok: true, skipped };
      },

      forget: (versionId) => set((s) => ({ versions: s.versions.filter((v) => v.id !== versionId) })),
    }),
    { name: "webaios.updates.v1", storage: createJSONStorage(() => localStorage) },
  ),
);
