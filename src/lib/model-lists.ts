/** Model lists: parsing every provider's listing shape, and merging a live
 *  listing with the built-in catalogue.
 *
 *  Pure on purpose. No DOM, no clock (the caller passes `now`), no imports from
 *  the app — which is what lets tests/model-lists.test.mjs pin the rules the
 *  picker, the Settings page and the /api/ai/models route all rely on.
 *
 *  The one ordering rule, and why: the catalogue in providers.ts is curated
 *  current-first, so its ids lead. Everything else the provider listed follows,
 *  newest first. OpenRouter lists ~450 models; alphabetical would bury this
 *  week's flagship under "ai21/…", and pure newest-first would put a batch
 *  variant released an hour ago above the model most people came for. */

export interface ModelEntry {
  id: string;
  name: string;
  /** Unix seconds, when the provider says. */
  created?: number;
  context?: number;
  vision?: boolean;
  image?: boolean;
  tools?: boolean;
  inUsd?: number;
  outUsd?: number;
  free?: boolean;
  /** In the built-in catalogue but absent from the provider's live listing:
   *  retired, renamed, or not enabled for this key. Kept (additive), shown last. */
  unlisted?: boolean;
}

export type ListSource = "live" | "catalog";

/** Tolerates the route's old bare-string shape, trims, drops blanks, dedupes
 *  by id keeping the first occurrence. */
export function normaliseEntries(raw: ReadonlyArray<ModelEntry | string | null | undefined>): ModelEntry[] {
  const seen = new Set<string>();
  const out: ModelEntry[] = [];
  for (const r of raw) {
    if (!r) continue;
    const e: ModelEntry = typeof r === "string" ? { id: r, name: r } : { ...r };
    const id = typeof e.id === "string" ? e.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ ...e, id, name: (typeof e.name === "string" && e.name.trim()) || id });
  }
  return out;
}

/** Newest first where the provider dates its models, then by id. */
export function sortNewestFirst(models: ModelEntry[]): ModelEntry[] {
  return [...models].sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || a.id.localeCompare(b.id));
}

/** Merge a live listing with the catalogue.
 *
 *  1. Catalogue ids the provider also listed, in catalogue order, carrying the
 *     live metadata (price, context) because it is the fresher fact.
 *  2. The rest of the live listing, newest first.
 *  3. Catalogue ids the provider did not list, flagged `unlisted`.
 *
 *  With no live list the catalogue comes back as-is: a failed refresh never
 *  shrinks the picker. */
export function mergeModelLists(live: ReadonlyArray<ModelEntry | string> | null | undefined, catalog: ReadonlyArray<string>): ModelEntry[] {
  const cat = normaliseEntries(catalog);
  const liveList = normaliseEntries(live ?? []);
  if (liveList.length === 0) return cat;
  const byId = new Map(liveList.map((m) => [m.id, m]));
  const catIds = new Set(cat.map((m) => m.id));
  const head = cat.filter((m) => byId.has(m.id)).map((m) => ({ ...byId.get(m.id)! }));
  const middle = sortNewestFirst(liveList.filter((m) => !catIds.has(m.id)));
  const tail = cat.filter((m) => !byId.has(m.id)).map((m) => ({ ...m, unlisted: true }));
  return [...head, ...middle, ...tail];
}

/* ── Provider listing shapes ─────────────────────────────────────────────── */

/** Anthropic `GET /v1/models`: `{ data: [{ id, display_name, created_at }] }`,
 *  created_at an ISO string. */
export function parseAnthropicModels(json: unknown): ModelEntry[] {
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  return sortNewestFirst(normaliseEntries(data.map((m) => {
    const r = m as { id?: unknown; display_name?: unknown; created_at?: unknown };
    const id = typeof r.id === "string" ? r.id : "";
    const t = typeof r.created_at === "string" ? Date.parse(r.created_at) : NaN;
    return {
      id,
      name: typeof r.display_name === "string" && r.display_name ? r.display_name : id,
      created: Number.isFinite(t) ? Math.floor(t / 1000) : undefined,
      // Every current Claude model takes images and calls tools.
      vision: true,
      tools: true,
    };
  })));
}

/** Google `GET /v1beta/models?key=…`: `{ models: [{ name: "models/gemini-…",
 *  displayName, inputTokenLimit, supportedGenerationMethods }] }`. Only models
 *  that can `generateContent` are chat models; embedders and the like are not. */
export function parseGoogleModels(json: unknown): ModelEntry[] {
  const models = (json as { models?: unknown })?.models;
  if (!Array.isArray(models)) return [];
  return normaliseEntries(models.flatMap((m) => {
    const r = m as { name?: unknown; displayName?: unknown; inputTokenLimit?: unknown; supportedGenerationMethods?: unknown };
    const methods = Array.isArray(r.supportedGenerationMethods) ? r.supportedGenerationMethods : [];
    if (!methods.includes("generateContent")) return [];
    const id = typeof r.name === "string" ? r.name.replace(/^models\//, "") : "";
    return [{
      id,
      name: typeof r.displayName === "string" && r.displayName ? r.displayName : id,
      context: typeof r.inputTokenLimit === "number" ? r.inputTokenLimit : undefined,
    }];
  }));
}

/** OpenAI-dialect `GET /models` (also Ollama's and LM Studio's /v1/models):
 *  `{ data: [{ id, created? }] }`. Minimal on purpose; the server route keeps
 *  its richer OpenRouter normaliser. */
export function parseOpenAIModels(json: unknown): ModelEntry[] {
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  return sortNewestFirst(normaliseEntries(data.map((m) => {
    const r = m as { id?: unknown; created?: unknown };
    const id = typeof r.id === "string" ? r.id : "";
    return { id, name: id, created: typeof r.created === "number" ? r.created : undefined };
  })));
}

/* ── Saying what happened ────────────────────────────────────────────────── */

/** "just now", "5 min ago", "3 h ago", "2 d ago". `now` and `at` in ms. */
export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export interface RefreshRecord {
  source: ListSource;
  /** ms since epoch of the refresh. */
  at: number;
  /** Why the list is the catalogue, when it is. */
  reason?: string;
  count: number;
}

/** One line for under a model list. Says plainly when a refresh fell back. */
export function describeRefresh(r: RefreshRecord | undefined, now: number): string {
  if (!r) return "built-in list · not refreshed yet";
  const when = ago(r.at, now);
  if (r.source === "live") return `live from the provider · ${r.count} models · refreshed ${when}`;
  return `built-in list · refreshed ${when} but fell back to the catalogue${r.reason ? `: ${r.reason}` : ""}`;
}
