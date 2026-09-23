"use client";

/** Refreshed model lists, one per provider, persisted.
 *
 *  The static catalogue in providers.ts goes stale the week a provider ships.
 *  A refresh asks the provider for its live list (through /api/ai/models, or
 *  straight from the browser for local providers) and keeps the merged result
 *  here, so every picker uses it afterwards — and the static list is what shows
 *  until the first refresh, or whenever one fails.
 *
 *  All the rules (merge, dedupe, ordering, wording) live in src/lib/model-lists.ts,
 *  which is pure and tested. This file is only the part that cannot be. */
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { useSettings } from "./settings";
import { getProvider } from "@/lib/providers";
import {
  mergeModelLists, normaliseEntries, parseOpenAIModels,
  type ModelEntry, type RefreshRecord, type ListSource,
} from "@/lib/model-lists";

export interface ProviderList extends RefreshRecord {
  models: ModelEntry[];
}

interface ModelCatalogState {
  lists: Record<string, ProviderList>;
  /** Providers with a refresh in flight. Not persisted. */
  busy: Record<string, boolean>;
  refresh: (providerId: string) => Promise<ProviderList | null>;
}

/** Local providers answer on the user's own machine, so only the browser can
 *  reach them. Nothing running there is a normal state, not an error. */
async function listLocal(baseUrl: string): Promise<ModelEntry[]> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return [];
    return parseOpenAIModels(await res.json());
  } catch {
    return [];
  }
}

export const useModelCatalog = create<ModelCatalogState>()(
  persist(
    (set, get) => ({
      lists: {},
      busy: {},
      refresh: async (providerId) => {
        const provider = getProvider(providerId);
        if (!provider) return null;
        if (get().busy[providerId]) return get().lists[providerId] ?? null;
        set((s) => ({ busy: { ...s.busy, [providerId]: true } }));

        const { keys, baseUrls } = useSettings.getState().ai;
        const key = keys[providerId] ?? "";
        const base = baseUrls[providerId] || provider.baseUrl;
        let live: ModelEntry[] = [];
        let source: ListSource = "catalog";
        let reason: string | undefined;

        if (provider.local) {
          live = base ? await listLocal(base) : [];
          if (live.length) source = "live";
          else reason = `nothing answered at ${base || "(no base URL)"} — is ${provider.name.replace(/ \(local\)$/, "")} running?`;
        } else {
          try {
            const res = await fetch(
              `/api/ai/models?provider=${encodeURIComponent(providerId)}${baseUrls[providerId] ? `&baseUrl=${encodeURIComponent(baseUrls[providerId])}` : ""}`,
              { headers: key ? { "x-api-key": key } : {} },
            );
            const data = (await res.json()) as { models?: Array<ModelEntry | string>; source?: ListSource; reason?: string; error?: string };
            if (data.source === "live") {
              live = normaliseEntries(data.models ?? []);
              source = live.length ? "live" : "catalog";
            }
            if (source === "catalog") reason = data.reason ?? data.error ?? `${provider.name} did not return a list`;
          } catch {
            reason = "could not reach this app's server";
          }
        }

        const record: ProviderList = {
          models: mergeModelLists(source === "live" ? live : null, provider.models),
          source,
          reason,
          at: Date.now(),
          count: source === "live" ? live.length : provider.models.length,
        };
        set((s) => ({
          lists: { ...s.lists, [providerId]: record },
          busy: { ...s.busy, [providerId]: false },
        }));
        return record;
      },
    }),
    {
      name: "webaios.modelcatalog.v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ lists: s.lists }),
    },
  ),
);

/** The list a picker should show: the last refresh if there was one,
 *  otherwise the built-in catalogue. */
export function modelsFor(providerId: string, lists: Record<string, ProviderList>): ModelEntry[] {
  return lists[providerId]?.models ?? mergeModelLists(null, getProvider(providerId)?.models ?? []);
}
