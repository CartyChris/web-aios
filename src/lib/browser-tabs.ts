/* Browser tabs, bookmarks, history and per-host mode memory — the pure half.

   The Browser app keeps one of these states and drives it with the functions
   below, so every rule (which tab gets focus when one closes, what "back"
   means per tab, which view a host starts in) is decided here and tested,
   instead of living in a component where only a click can exercise it.

   No DOM, no clock, no randomness: ids and timestamps are passed in. */

export type BrowserView = "frame" | "web" | "reader" | "cloud";
export type BrowserMode = "auto" | BrowserView;

export interface TabEntry {
  url: string;
  view: BrowserView;
  title?: string;
  /** Web mode only: false until the shim reports the real (post-redirect) URL. */
  confirmed: boolean;
}

export interface BrowserTab {
  id: string;
  /** The mode buttons' selection for this tab. */
  mode: BrowserMode;
  entries: TabEntry[];
  index: number;
  /** The address bar text, which can differ from the entry while typing. */
  draft: string;
}

export interface TabsState {
  tabs: BrowserTab[];
  activeId: string;
}

export const MAX_TABS = 24;
export const MAX_ENTRIES = 100;

export function newTab(id: string, draft = "", mode: BrowserMode = "auto"): BrowserTab {
  return { id, mode, entries: [], index: -1, draft };
}

export function initialTabs(id: string, draft = ""): TabsState {
  return { tabs: [newTab(id, draft)], activeId: id };
}

export const activeTab = (s: TabsState): BrowserTab =>
  s.tabs.find((t) => t.id === s.activeId) ?? s.tabs[0];

export const currentEntry = (t: BrowserTab): TabEntry | null =>
  t.index >= 0 ? t.entries[t.index] ?? null : null;

/** Open a tab right after the active one (what every browser does for "open in new tab"). */
export function openTab(s: TabsState, tab: BrowserTab, focus = true): TabsState {
  if (s.tabs.length >= MAX_TABS) return s;
  const at = s.tabs.findIndex((t) => t.id === s.activeId);
  const tabs = [...s.tabs.slice(0, at + 1), tab, ...s.tabs.slice(at + 1)];
  return { tabs, activeId: focus ? tab.id : s.activeId };
}

/**
 * Close a tab. Closing the active one focuses its right neighbour, else its
 * left one. Closing the last tab replaces it with a fresh one (`freshId`), so
 * the window is never left with nothing to type into.
 */
export function closeTab(s: TabsState, id: string, freshId: string): TabsState {
  const at = s.tabs.findIndex((t) => t.id === id);
  if (at === -1) return s;
  const tabs = s.tabs.filter((t) => t.id !== id);
  if (!tabs.length) return initialTabs(freshId);
  if (s.activeId !== id) return { tabs, activeId: s.activeId };
  const next = tabs[Math.min(at, tabs.length - 1)];
  return { tabs, activeId: next.id };
}

export function switchTab(s: TabsState, id: string): TabsState {
  return s.tabs.some((t) => t.id === id) ? { ...s, activeId: id } : s;
}

/** Move tab `id` to position `to` (clamped). */
export function moveTab(s: TabsState, id: string, to: number): TabsState {
  const from = s.tabs.findIndex((t) => t.id === id);
  if (from === -1) return s;
  const tabs = s.tabs.slice();
  const [t] = tabs.splice(from, 1);
  const dest = Math.max(0, Math.min(tabs.length, to));
  tabs.splice(dest, 0, t);
  return { ...s, tabs };
}

export function patchTab(s: TabsState, id: string, patch: Partial<BrowserTab>): TabsState {
  return { ...s, tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) };
}

/** Push a navigation onto a tab's own history, dropping any forward entries. */
export function pushEntry(t: BrowserTab, e: TabEntry): BrowserTab {
  const entries = [...t.entries.slice(0, t.index + 1), e].slice(-MAX_ENTRIES);
  return { ...t, entries, index: entries.length - 1, draft: e.url };
}

/** Move the tab's cursor. Returns the same tab when the step is out of range. */
export function stepTab(t: BrowserTab, delta: number): BrowserTab {
  const next = t.index + delta;
  if (next < 0 || next >= t.entries.length) return t;
  return { ...t, index: next, draft: t.entries[next].url };
}

/**
 * The web-mode shim reported the page's real URL. The first report after a
 * navigation confirms (and may rewrite, after redirects) the current entry; a
 * later different URL is an in-page navigation and becomes a new entry.
 */
export function applyShimReport(t: BrowserTab, url: string, title: string): BrowserTab {
  const cur = currentEntry(t);
  if (!cur) return t;
  if (!cur.confirmed || cur.url === url) {
    const entries = t.entries.slice();
    entries[t.index] = { ...cur, url, title, confirmed: true };
    return { ...t, entries, draft: url };
  }
  return pushEntry(t, { url, view: "web", title, confirmed: true });
}

/* ── address normalising and search engines ─────────────────────────────── */

export interface SearchEngine { id: string; name: string; template: string }

export const SEARCH_ENGINES: SearchEngine[] = [
  { id: "duckduckgo", name: "DuckDuckGo", template: "https://duckduckgo.com/?q=%s" },
  { id: "brave", name: "Brave Search", template: "https://search.brave.com/search?q=%s" },
  { id: "startpage", name: "Startpage", template: "https://www.startpage.com/do/search?q=%s" },
  { id: "wikipedia", name: "Wikipedia", template: "https://en.wikipedia.org/w/index.php?search=%s" },
  { id: "google", name: "Google", template: "https://www.google.com/search?q=%s" },
  { id: "bing", name: "Bing", template: "https://www.bing.com/search?q=%s" },
];

export function engineById(id: string | undefined): SearchEngine {
  return SEARCH_ENGINES.find((e) => e.id === id) ?? SEARCH_ENGINES[0];
}

/** A custom template must be http(s) and contain exactly one `%s`. */
export function validTemplate(t: string): boolean {
  if (!/^https?:\/\/[^\s]+$/i.test(t.trim())) return false;
  return t.split("%s").length === 2;
}

export function searchUrl(query: string, template: string): string {
  return template.replace("%s", encodeURIComponent(query));
}

/**
 * Typed text to a URL. Only http(s) survives as a URL; anything that looks like
 * a host becomes https; everything else, including `javascript:` and `data:`,
 * is a search.
 */
export function normalizeAddress(raw: string, template: string): string {
  const t = raw.trim();
  if (!t) return "";
  if (/^https?:\/\//i.test(t)) return t;
  if (!/\s/.test(t) && /^(localhost(:\d+)?|[\w-]+(\.[\w-]+)+)(:\d+)?([/?#].*)?$/i.test(t)) return `https://${t}`;
  return searchUrl(t, validTemplate(template) ? template : SEARCH_ENGINES[0].template);
}

export function hostOf(u: string): string {
  const m = /^https?:\/\/([^/?#:]+)/i.exec(u);
  return m ? m[1].toLowerCase().replace(/^www\./, "") : "";
}

/* ── per-host mode memory ───────────────────────────────────────────────── */

/**
 * What a host did last time. Only a *refusal* is remembered as "web": if a
 * site refused framing once it will refuse again, so auto skips the header
 * probe and starts in web. A host the user explicitly pinned to a view keeps
 * that view.
 */
export type HostMemory = Record<string, BrowserView>;
export const MAX_HOST_MEMORY = 400;

export function rememberHost(mem: HostMemory, url: string, view: BrowserView): HostMemory {
  const h = hostOf(url);
  if (!h) return mem;
  const { [h]: _old, ...rest } = mem;
  void _old;
  const next: HostMemory = { ...rest, [h]: view };
  const keys = Object.keys(next);
  if (keys.length <= MAX_HOST_MEMORY) return next;
  // Oldest insertion first: drop from the front.
  const trimmed: HostMemory = {};
  for (const k of keys.slice(keys.length - MAX_HOST_MEMORY)) trimmed[k] = next[k];
  return trimmed;
}

/** The view to start in, or null when auto should probe the headers. */
export function startView(mem: HostMemory, url: string, mode: BrowserMode): BrowserView | null {
  if (mode !== "auto") return mode;
  return mem[hostOf(url)] ?? null;
}

/* ── bookmarks and history ──────────────────────────────────────────────── */

export interface Bookmark { url: string; title: string; at: number }
export interface Visit { url: string; title: string; at: number; count: number }

export const MAX_HISTORY = 500;
export const MAX_BOOKMARKS = 300;

export function toggleBookmark(list: Bookmark[], url: string, title: string, at: number): Bookmark[] {
  if (list.some((b) => b.url === url)) return list.filter((b) => b.url !== url);
  return [{ url, title: title || hostOf(url) || url, at }, ...list].slice(0, MAX_BOOKMARKS);
}

/** Record a visit: one row per URL, moved to the front, with a visit count. */
export function recordVisit(list: Visit[], url: string, title: string, at: number): Visit[] {
  const prev = list.find((v) => v.url === url);
  const row: Visit = { url, title: title || prev?.title || hostOf(url) || url, at, count: (prev?.count ?? 0) + 1 };
  return [row, ...list.filter((v) => v.url !== url)].slice(0, MAX_HISTORY);
}

/** A title learned later (from the shim or reader) fills in the history row. */
export function titleVisit(list: Visit[], url: string, title: string): Visit[] {
  if (!title) return list;
  return list.map((v) => (v.url === url ? { ...v, title } : v));
}

/**
 * Every whitespace-separated term must appear in the title or the URL,
 * case-insensitively. Results keep the list's order (most recent first).
 */
export function searchPlaces<T extends { url: string; title: string }>(list: T[], query: string, limit = 50): T[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return list.slice(0, limit);
  const out: T[] = [];
  for (const item of list) {
    const hay = `${item.title}\n${item.url}`.toLowerCase();
    if (terms.every((t) => hay.includes(t))) out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

/* ── find in page (reader mode) ─────────────────────────────────────────── */

export interface Match { start: number; end: number }

/** Case-insensitive, non-overlapping matches of `q` in `text`, capped. */
export function findMatches(text: string, q: string, cap = 1000): Match[] {
  const needle = q.toLowerCase();
  if (!needle) return [];
  const hay = text.toLowerCase();
  const out: Match[] = [];
  let at = hay.indexOf(needle);
  while (at !== -1 && out.length < cap) {
    out.push({ start: at, end: at + needle.length });
    at = hay.indexOf(needle, at + needle.length);
  }
  return out;
}

/** Split text into plain and highlighted runs for rendering. */
export function splitByMatches(text: string, matches: Match[]): Array<{ text: string; hit: number | null }> {
  const out: Array<{ text: string; hit: number | null }> = [];
  let pos = 0;
  matches.forEach((m, i) => {
    if (m.start > pos) out.push({ text: text.slice(pos, m.start), hit: null });
    out.push({ text: text.slice(m.start, m.end), hit: i });
    pos = m.end;
  });
  if (pos < text.length) out.push({ text: text.slice(pos), hit: null });
  return out;
}

/** A filesystem-safe name for "save page to Files". */
export function pageFileName(title: string, url: string): string {
  const base = (title || hostOf(url) || "page").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 60);
  return `${base || "page"}.md`;
}
