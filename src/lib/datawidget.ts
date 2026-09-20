/* Live Data widget — the pure half: what a pinned service's configuration may
   be, when its reading is stale, and how a result shrinks to fit a card.
   Kept free of the DOM so a saved widget that no longer makes sense (a service
   removed from the catalogue, a required argument blanked) is caught by a test
   rather than by a widget that spins forever on the desktop. */

import { missingParams, withDefaults, type ServiceDef, type ServiceResult } from "./services";

export interface DataWidgetConfig {
  serviceId: string;
  args: Record<string, string>;
  refreshMin: number;
  rows: number;
  /** Set when the widget came from a preset whose arguments depend on the day
   *  (On This Day), so the widget can recompute them instead of showing the
   *  date it was pinned on forever. */
  presetId?: string;
}

export type NormalisedDataConfig = { ok: true; config: DataWidgetConfig } | { ok: false; reason: string };

export const REFRESH_MIN = 5;
export const REFRESH_MAX = 1440;
export const REFRESH_DEFAULT = 30;
export const ROWS_MIN = 1;
export const ROWS_MAX = 8;
export const ROWS_DEFAULT = 4;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Settings are persisted and may have been written by an older build or by
 *  hand, so every field is re-validated on the way in and nothing throws. */
export function normaliseDataConfig(raw: unknown, services: ServiceDef[]): NormalisedDataConfig {
  if (!isRecord(raw)) return { ok: false, reason: "No data source has been chosen yet." };
  const serviceId = typeof raw.serviceId === "string" ? raw.serviceId.trim() : "";
  if (!serviceId) return { ok: false, reason: "No data source has been chosen yet." };
  const def = services.find((s) => s.id === serviceId);
  if (!def) return { ok: false, reason: `The service "${serviceId}" is not in the catalogue any more.` };

  const given: Record<string, string> = {};
  if (isRecord(raw.args)) {
    for (const [k, v] of Object.entries(raw.args)) {
      // Objects and arrays would stringify to "[object Object]" and reach a
      // URL as garbage; dropping them lets a declared default step in instead.
      if (typeof v === "string") given[k] = v;
      else if ((typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean") given[k] = String(v);
    }
  }
  const args = withDefaults(def, given);
  const missing = missingParams(def, args);
  if (missing.length > 0) {
    const labels = missing.map((name) => def.params.find((p) => p.name === name)?.label ?? name);
    return { ok: false, reason: `${def.name} needs ${labels.join(" and ")} (${missing.join(", ")}).` };
  }

  const config: DataWidgetConfig = {
    serviceId,
    args,
    refreshMin: clampInt(raw.refreshMin, REFRESH_MIN, REFRESH_MAX, REFRESH_DEFAULT),
    rows: clampInt(raw.rows, ROWS_MIN, ROWS_MAX, ROWS_DEFAULT),
  };
  if (typeof raw.presetId === "string" && DATA_PRESETS.some((p) => p.id === raw.presetId && p.serviceId === serviceId)) {
    config.presetId = raw.presetId;
  }
  return { ok: true, config };
}

/** A reading from the future (clock changed, restored backup) counts as stale:
 *  otherwise the widget would sit on it until real time caught up. */
export function isStale(lastAt: number | undefined, refreshMin: number, now: number): boolean {
  if (lastAt === undefined || !Number.isFinite(lastAt)) return true;
  if (lastAt > now) return true;
  const minutes = Number.isFinite(refreshMin) && refreshMin > 0 ? refreshMin : REFRESH_DEFAULT;
  return now - lastAt >= minutes * 60_000;
}

function cut(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Row urls come from third-party payloads; anything but http(s) could run
 *  script when clicked, so it is dropped rather than rendered as a link. */
function safeUrl(u: string | undefined): string | undefined {
  if (!u) return undefined;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

export interface CompactRow {
  title: string;
  detail: string;
  meta?: string;
  url?: string;
}

export function compactRows(result: ServiceResult, n: number): CompactRow[] {
  const count = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  return result.rows.slice(0, count).map((r) => {
    const row: CompactRow = { title: cut(r.title, 60), detail: cut(r.detail, 90) };
    if (r.meta) row.meta = cut(r.meta, 32);
    const url = safeUrl(r.url);
    if (url) row.url = url;
    return row;
  });
}

/** Two widgets showing the same query should share one reading, however their
 *  argument objects happen to have been built. */
export function cacheKey(config: DataWidgetConfig): string {
  const sorted = Object.keys(config.args)
    .sort()
    .map((k) => [k, config.args[k] ?? ""]);
  return `${config.serviceId}:${JSON.stringify(sorted)}`;
}

export interface DataPreset {
  id: string;
  name: string;
  serviceId: string;
  args: Record<string, string>;
  /** Arguments that must be recomputed from the current date. */
  dated?: boolean;
}

export const DATA_PRESETS: DataPreset[] = [
  { id: "weather-london", name: "Weather in London", serviceId: "weather", args: { latitude: "51.51", longitude: "-0.13" } },
  { id: "air-london", name: "Air quality in London", serviceId: "air_quality", args: { latitude: "51.51", longitude: "-0.13" } },
  { id: "quakes-45", name: "Earthquakes, magnitude 4.5+", serviceId: "earthquakes", args: { band: "4.5" } },
  { id: "fx-usd", name: "Dollar exchange rates", serviceId: "fx", args: { from: "USD", to: "EUR,GBP,JPY", amount: "1" } },
  { id: "crypto-btc", name: "Bitcoin price", serviceId: "crypto", args: { ids: "bitcoin", vs: "usd" } },
  { id: "hn-ai", name: "Hacker News: AI", serviceId: "hackernews", args: { query: "AI", sort: "date" } },
  { id: "apod", name: "NASA picture of the day", serviceId: "nasa_apod", args: {} },
  { id: "onthisday", name: "On this day", serviceId: "onthisday", args: {}, dated: true },
];

/** The full arguments a preset should run with at `now` (UTC, so the answer
 *  does not depend on where the test machine is). */
export function presetArgs(presetId: string, now: number): Record<string, string> | null {
  const preset = DATA_PRESETS.find((p) => p.id === presetId);
  if (!preset) return null;
  if (!preset.dated) return { ...preset.args };
  if (!Number.isFinite(now)) return null;
  const d = new Date(now);
  return {
    ...preset.args,
    month: String(d.getUTCMonth() + 1).padStart(2, "0"),
    day: String(d.getUTCDate()).padStart(2, "0"),
  };
}
