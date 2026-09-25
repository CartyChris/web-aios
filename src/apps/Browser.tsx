"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { useVFS } from "@/kernel/vfs";
import { bus } from "@/kernel/bus";
import { useSettings } from "@/kernel/settings";
import { registerContextTarget } from "@/kernel/ctxmenu";
import type { MenuItem } from "@/lib/ctxmenu";
import type { AppProps } from "@/kernel/types";
import { Icon } from "@/shell/icons";
import { Empty, ErrorNote, Spinner, Markdown, CopyButton } from "./_ui";
import { cn } from "@/lib/cn";
import { mediaEmbedFor } from "@/lib/media-embed";
import { relTime } from "@/lib/format";
import { SANDBOX_TOKENS, encodeTarget } from "@/lib/webproxy";
import {
  type BrowserMode, type BrowserView, type TabsState, type BrowserTab, type Bookmark, type Visit, type HostMemory,
  initialTabs, newTab, openTab, closeTab, switchTab, moveTab, patchTab, pushEntry, stepTab, applyShimReport,
  activeTab, currentEntry, normalizeAddress, engineById, validTemplate, SEARCH_ENGINES, rememberHost, startView,
  toggleBookmark, recordVisit, titleVisit, searchPlaces, findMatches, splitByMatches, pageFileName, hostOf, MAX_TABS,
} from "@/lib/browser-tabs";

/** Browser — embedded browsing that actually reaches any site, now with tabs.
 *
 *  Five modes, picked per page:
 *   - auto:   asks /api/proxy?mode=headers whether the page allows framing,
 *             then uses frame if it does and web if it does not. A host that
 *             refused framing is remembered and starts in web next time.
 *   - frame:  a plain iframe. Fastest; many sites refuse it.
 *   - web:    the rewriting proxy at /api/web. Headers that block framing are
 *             stripped, links and subresources are rewritten, and a shim keeps
 *             dynamic requests in the proxy. Free, no key. The page runs in a
 *             sandbox WITHOUT allow-same-origin (opaque origin), so it can never
 *             reach this OS's localStorage, where AI keys live.
 *   - reader: the page's text through the OS proxy, which is also what an agent wants.
 *   - cloud:  a real remote Chromium (Steel) streamed into a live view. Truly any
 *             site, including logins and video; uses the user's provider credits.
 *
 *  Every tab has its own mode selection and its own back/forward stack. The
 *  stacks are kept here rather than in the iframes, because a cross-origin
 *  frame's history cannot be driven from outside; Web mode's shim reports every
 *  in-page navigation via postMessage, and a report is attributed to a tab ONLY
 *  by matching `event.source` against that tab's own iframe window. The tab
 *  logic itself is pure and tested in `lib/browser-tabs.ts`. */

type Mode = BrowserMode;
type View = BrowserView;
interface CloudState { id: string; liveUrl: string; startedAt: number; timeoutMs: number }
interface ReaderPage { title: string; text: string; url: string }

const MODES: Mode[] = ["auto", "frame", "web", "reader", "cloud"];
const MODE_HINT: Record<Mode, string> = {
  auto: "Frame when the site allows it, otherwise Web",
  frame: "Plain iframe (many sites refuse)",
  web: "Rewriting proxy: free, no key, sandboxed",
  reader: "Text only, through the OS proxy",
  cloud: "Remote Chromium: any site, uses your Steel credits",
};
const CLOUD_PROVIDER = "steel";
const CLOUD_SIGNUP = "https://app.steel.dev/settings/api-keys";

/* ── what outlives the window: bookmarks, history, engine, host memory ──── */

interface BrowserData {
  bookmarks: Bookmark[];
  history: Visit[];
  hostModes: HostMemory;
  engineId: string;
  /** A custom search URL with one %s; used when valid, else the engine. */
  customEngine: string;
  toggleBookmark: (url: string, title: string) => void;
  visit: (url: string, title?: string) => void;
  retitle: (url: string, title: string) => void;
  remember: (url: string, view: View) => void;
  forgetHosts: () => void;
  clearHistory: () => void;
  removeVisit: (url: string) => void;
  setEngine: (id: string, custom?: string) => void;
}

export const useBrowserData = create<BrowserData>()(
  persist(
    (set) => ({
      bookmarks: [],
      history: [],
      hostModes: {},
      engineId: "duckduckgo",
      customEngine: "",
      toggleBookmark: (url, title) => set((s) => ({ bookmarks: toggleBookmark(s.bookmarks, url, title, Date.now()) })),
      visit: (url, title = "") => set((s) => ({ history: recordVisit(s.history, url, title, Date.now()) })),
      retitle: (url, title) => set((s) => ({ history: titleVisit(s.history, url, title), bookmarks: s.bookmarks.map((b) => (b.url === url && b.title === hostOf(url) && title ? { ...b, title } : b)) })),
      remember: (url, view) => set((s) => ({ hostModes: rememberHost(s.hostModes, url, view) })),
      forgetHosts: () => set({ hostModes: {} }),
      clearHistory: () => set({ history: [] }),
      removeVisit: (url) => set((s) => ({ history: s.history.filter((v) => v.url !== url) })),
      setEngine: (id, custom) => set((s) => ({ engineId: id, customEngine: custom ?? s.customEngine })),
    }),
    { name: "webaios.browser.v1", storage: createJSONStorage(() => localStorage) },
  ),
);

function engineTemplate(d: Pick<BrowserData, "engineId" | "customEngine">): string {
  if (d.engineId === "custom" && validTemplate(d.customEngine)) return d.customEngine;
  return engineById(d.engineId).template;
}

function newId(prefix: string): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `${prefix}${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
function newSid(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function webSrc(sid: string, url: string): string | null {
  const enc = encodeTarget(url);
  return enc ? `/api/web/${sid}/${enc}` : null;
}

function releaseBeacon(sessionId: string, key: string) {
  const body = JSON.stringify({ action: "release", provider: CLOUD_PROVIDER, sessionId, key: key || undefined });
  try {
    if (navigator.sendBeacon?.("/api/cloudbrowser", new Blob([body], { type: "application/json" }))) return;
  } catch { /* fall through to keepalive fetch */ }
  fetch("/api/cloudbrowser", { method: "POST", body, keepalive: true, headers: { "content-type": "application/json" } }).catch(() => {});
}

async function fetchReader(target: string): Promise<ReaderPage> {
  const res = await fetch(`/api/proxy?url=${encodeURIComponent(target)}&mode=text`);
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error ?? `${res.status}`);
  return { title: data.title || target, text: data.text ?? "", url: data.url };
}

const tabLabel = (t: BrowserTab) => {
  const e = currentEntry(t);
  return e ? e.title || hostOf(e.url) || e.url : "New tab";
};

export default function Browser({ args }: AppProps) {
  const vfs = useVFS();
  const settings = useSettings();
  const data = useBrowserData();
  const cloudKey = settings.ai.keys[CLOUD_PROVIDER] ?? "";
  const [tabsState, setTabs] = useState<TabsState>(() => initialTabs(newId("tab"), (args?.url as string) ?? ""));
  const [reloads, setReloads] = useState<Record<string, number>>({});
  const [autoNotes, setAutoNotes] = useState<Record<string, string>>({});
  const [readers, setReaders] = useState<Record<string, ReaderPage>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sid] = useState(newSid);
  const [cloud, setCloud] = useState<CloudState | null>(null);
  const [needsKey, setNeedsKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [library, setLibrary] = useState<null | "bookmarks" | "history">(null);
  const [libQuery, setLibQuery] = useState("");
  const [find, setFind] = useState<{ open: boolean; q: string; at: number }>({ open: false, q: "", at: 0 });
  const [dragId, setDragId] = useState<string | null>(null);
  /** A navigation queued for a tab that did not exist yet when it was asked for. */
  const [pending, setPending] = useState<{ tabId: string; url: string } | null>(null);
  /** Each web-mode tab's iframe, so a postMessage is attributed by its source window. */
  const frames = useRef(new Map<string, HTMLIFrameElement>());
  const cloudRef = useRef<{ id: string; key: string } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const readerBox = useRef<HTMLDivElement>(null);

  const tab = activeTab(tabsState);
  const current = currentEntry(tab);
  // A video page's audible local form (lib/media-embed.ts): cloud live views carry no sound.
  const media = current ? mediaEmbedFor(current.url) : null;
  const view = current?.view ?? null;
  const reader = readers[tab.id] ?? null;
  const template = engineTemplate(data);
  const bookmarked = current ? data.bookmarks.some((b) => b.url === current.url) : false;

  const updateTab = useCallback((id: string, fn: (t: BrowserTab) => BrowserTab) => {
    setTabs((s) => ({ ...s, tabs: s.tabs.map((t) => (t.id === id ? fn(t) : t)) }));
  }, []);

  const loadReader = useCallback(async (tabId: string, target: string) => {
    setBusy("Fetching through the OS proxy…");
    try {
      const page = await fetchReader(target);
      setReaders((r) => ({ ...r, [tabId]: page }));
      if (page.title) useBrowserData.getState().retitle(target, page.title);
      updateTab(tabId, (t) => {
        const e = currentEntry(t);
        if (!e || e.url !== target) return t;
        const entries = t.entries.slice();
        entries[t.index] = { ...e, title: page.title };
        return { ...t, entries };
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not fetch that page.");
    } finally { setBusy(null); }
  }, [updateTab]);

  const cloudCall = useCallback(async (payload: Record<string, unknown>) => {
    const res = await fetch("/api/cloudbrowser", {
      method: "POST",
      headers: { "content-type": "application/json", ...(cloudKey ? { "x-api-key": cloudKey } : {}) },
      body: JSON.stringify({ provider: CLOUD_PROVIDER, ...payload }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 && body.needsKey) { setNeedsKey(true); throw new Error(body.error ?? "A Steel API key is needed."); }
    if (!res.ok || body.error) throw new Error(body.error ?? `Cloud browser error ${res.status}`);
    return body;
  }, [cloudKey]);

  const cloudGo = useCallback(async (target: string) => {
    setBusy(cloud ? "Navigating the cloud browser…" : "Starting a cloud browser session…");
    try {
      if (cloud) {
        await cloudCall({ action: "navigate", sessionId: cloud.id, url: target });
      } else {
        const d = await cloudCall({ action: "create", url: target });
        setCloud({ id: d.id, liveUrl: d.liveUrl, startedAt: Date.now(), timeoutMs: d.timeoutMs ?? 0 });
        cloudRef.current = { id: d.id, key: cloudKey };
        setNeedsKey(false);
        if (d.warning) setError(`Session started, but the first navigation failed: ${d.warning}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Cloud browser request failed.");
    } finally { setBusy(null); }
  }, [cloud, cloudCall, cloudKey]);

  const stopCloud = useCallback(async () => {
    const s = cloudRef.current;
    cloudRef.current = null;
    setCloud(null);
    if (!s) return;
    try { await cloudCall({ action: "release", sessionId: s.id }); bus.emit("notify", { title: "Cloud session stopped", kind: "success" }); }
    catch (e) { setError(e instanceof Error ? `Could not release the session: ${e.message}` : "Could not release the session."); }
  }, [cloudCall]);

  /** Show `target` in `view` for tab `tabId` without touching its history stack. */
  const show = useCallback(async (tabId: string, target: string, v: View) => {
    setError(null);
    if (v !== "reader") setReaders((r) => { if (!(tabId in r)) return r; const { [tabId]: _gone, ...rest } = r; void _gone; return rest; });
    if (v === "reader") await loadReader(tabId, target);
    if (v === "cloud") await cloudGo(target);
    setReloads((n) => ({ ...n, [tabId]: (n[tabId] ?? 0) + 1 }));
  }, [loadReader, cloudGo]);

  const go = useCallback(async (tabId: string, raw: string, forceMode?: Mode) => {
    const target = normalizeAddress(raw, template);
    if (!target) return;
    const t = tabsState.tabs.find((x) => x.id === tabId);
    if (!t) return;
    const chosen = forceMode ?? t.mode;
    setError(null);
    setLibrary(null);
    useBrowserData.getState().visit(target);
    bus.emit("activity", { source: "search", text: target });

    let v: View;
    const remembered = startView(useBrowserData.getState().hostModes, target, chosen);
    if (remembered) {
      v = remembered;
      setAutoNotes((n) => ({ ...n, [tabId]: chosen === "auto" ? `auto: ${v} (remembered: ${hostOf(target)} refused framing before)` : "" }));
    } else {
      setBusy("Checking whether the site allows framing…");
      try {
        const res = await fetch(`/api/proxy?url=${encodeURIComponent(target)}&mode=headers`);
        const d = await res.json();
        if (!res.ok || d.error) throw new Error(d.error ?? `${res.status}`);
        v = d.frameable ? "frame" : "web";
        if (!d.frameable) useBrowserData.getState().remember(target, "web");
        setAutoNotes((n) => ({ ...n, [tabId]: d.frameable ? "auto: frame (site allows framing)" : `auto: web (${d.reason})` }));
      } catch (e) {
        v = "web";
        setAutoNotes((n) => ({ ...n, [tabId]: `auto: web (framing check failed: ${e instanceof Error ? e.message : "error"})` }));
      } finally { setBusy(null); }
    }
    updateTab(tabId, (x) => pushEntry(x, { url: target, view: v, confirmed: v !== "web" }));
    await show(tabId, target, v);
  }, [template, tabsState.tabs, updateTab, show]);

  const step = useCallback((delta: number) => {
    const next = stepTab(tab, delta);
    if (next === tab) return;
    updateTab(tab.id, () => next);
    const e = currentEntry(next);
    if (e) void show(tab.id, e.url, e.view);
  }, [tab, updateTab, show]);

  const reload = useCallback(() => {
    if (current) void show(tab.id, current.url, current.view);
  }, [current, tab.id, show]);

  const switchView = useCallback((m: Mode) => {
    updateTab(tab.id, (t) => ({ ...t, mode: m }));
    if (current && m !== "auto" && m !== current.view) void go(tab.id, current.url, m);
  }, [current, go, tab.id, updateTab]);

  const addTab = useCallback((url?: string, focus = true) => {
    if (tabsState.tabs.length >= MAX_TABS) { setError(`At most ${MAX_TABS} tabs per window.`); return; }
    const t = newTab(newId("tab"), url ?? "");
    setTabs((s) => openTab(s, t, focus));
    setFind({ open: false, q: "", at: 0 });
    // The new tab exists after this render; the effect below navigates it.
    if (url) setPending({ tabId: t.id, url });
  }, [tabsState.tabs.length]);

  useEffect(() => {
    if (!pending) return;
    if (!tabsState.tabs.some((t) => t.id === pending.tabId)) return;
    const p = pending;
    const id = setTimeout(() => { setPending(null); void go(p.tabId, p.url); }, 0);
    return () => clearTimeout(id);
  }, [pending, tabsState.tabs, go]);

  const closeOne = useCallback((id: string) => {
    frames.current.delete(id);
    setTabs((s) => closeTab(s, id, newId("tab")));
    setReaders((r) => { if (!(id in r)) return r; const { [id]: _gone, ...rest } = r; void _gone; return rest; });
    setFind({ open: false, q: "", at: 0 });
  }, []);

  const selectTab = useCallback((id: string) => {
    setTabs((s) => switchTab(s, id));
    setFind({ open: false, q: "", at: 0 });
  }, []);

  const pageText = useCallback(async (): Promise<ReaderPage | null> => {
    if (!current) return null;
    if (reader && reader.url) return reader;
    setBusy("Reading the page through the OS proxy…");
    try { return await fetchReader(current.url); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not read that page."); return null; }
    finally { setBusy(null); }
  }, [current, reader]);

  const savePage = useCallback(async () => {
    const page = await pageText();
    if (!page) return;
    const path = `/web/${pageFileName(page.title, page.url)}`;
    vfs.write(path, `# ${page.title}\n\n<${page.url}>\n\n${page.text}`, { appId: "browser" });
    bus.emit("notify", { title: "Saved to Files", body: path, kind: "success" });
  }, [pageText, vfs]);

  const askAI = useCallback(async () => {
    const page = await pageText();
    if (!page) return;
    bus.emit("aios-chat:ask", {
      prompt: `Summarize this page and tell me what matters in it: ${page.title}`,
      context: { label: `Web page: ${page.title} (${page.url})`, text: page.text.slice(0, 16000) },
    });
  }, [pageText]);

  // Web mode: the shim in the proxied page reports its real URL and title.
  // The sandboxed frame's origin is "null", so the source WINDOW is what is
  // checked, against each tab's own iframe. A message from anything else is dropped.
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      let tabId: string | null = null;
      for (const [id, el] of frames.current) if (el.contentWindow && ev.source === el.contentWindow) { tabId = id; break; }
      if (!tabId) return;
      const d = ev.data as { type?: string; url?: string; title?: string } | null;
      if (!d || d.type !== "aios-web" || typeof d.url !== "string" || !/^https?:\/\//i.test(d.url)) return;
      const reported = d.url.slice(0, 4000);
      const title = typeof d.title === "string" ? d.title.slice(0, 300) : "";
      const owner = tabId;
      setTabs((s) => ({ ...s, tabs: s.tabs.map((t) => (t.id === owner ? applyShimReport(t, reported, title) : t)) }));
      if (title) useBrowserData.getState().retitle(reported, title);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // A cloud session costs money every minute: release it when the window
  // closes or the tab goes away, not just on Stop.
  useEffect(() => {
    const onHide = () => { const s = cloudRef.current; if (s) releaseBeacon(s.id, s.key); };
    window.addEventListener("pagehide", onHide);
    return () => { window.removeEventListener("pagehide", onHide); onHide(); cloudRef.current = null; };
  }, []);

  /* ── right-click: a Browser section, contributed through the registry ── */
  const menuState = useRef({ tab, current, bookmarked, tabs: tabsState.tabs });
  useEffect(() => { menuState.current = { tab, current, bookmarked, tabs: tabsState.tabs }; });
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    return registerContextTarget(el, ({ target }) => {
      const { tab: t, current: cur, bookmarked: bm, tabs } = menuState.current;
      const link = (target.closest("a[href]") as HTMLAnchorElement | null)?.href;
      const tabEl = (target.closest("[data-browser-tab]") as HTMLElement | null)?.dataset.browserTab;
      const entries: MenuItem[] = [];
      if (tabEl) {
        const at = tabs.findIndex((x) => x.id === tabEl);
        entries.push(
          { id: "tab-close", label: "Close tab", icon: "close", run: () => closeOne(tabEl) },
          { id: "tab-dup", label: "Duplicate tab", icon: "copy", disabled: !currentEntry(tabs[at] ?? t), run: () => { const e = currentEntry(tabs[at] ?? t); if (e) addTab(e.url); } },
          { id: "tab-left", label: "Move tab left", icon: "chevronRight", disabled: at <= 0, run: () => setTabs((s) => moveTab(s, tabEl, at - 1)) },
          { id: "tab-right", label: "Move tab right", icon: "chevronRight", disabled: at >= tabs.length - 1, run: () => setTabs((s) => moveTab(s, tabEl, at + 1)) },
        );
        return { id: "browser-tab", entries };
      }
      const canBack = t.index > 0;
      const canFwd = t.index < t.entries.length - 1;
      entries.push(
        { id: "back", label: "Back", icon: "arrowUp", disabled: !canBack, run: () => step(-1) },
        { id: "forward", label: "Forward", icon: "arrowDown", disabled: !canFwd, run: () => step(1) },
        { id: "reload", label: "Reload", icon: "refresh", disabled: !cur, run: () => reload() },
        { id: "newtab", label: link ? "Open link in new tab" : "Open in new tab", icon: "plus", disabled: !link && !cur, run: () => addTab(link ?? cur?.url) },
        { id: "copyurl", label: link ? "Copy link address" : "Copy page address", icon: "copy", disabled: !link && !cur,
          run: () => { void navigator.clipboard?.writeText(link ?? cur?.url ?? "").catch(() => {}); } },
        { id: "bookmark", label: bm ? "Remove bookmark" : "Bookmark this page", icon: "star", disabled: !cur, checked: bm,
          run: () => { if (cur) useBrowserData.getState().toggleBookmark(cur.url, cur.title ?? ""); } },
      );
      return { id: "browser", entries };
    });
  }, [addTab, closeOne, reload, step]);

  /* ── find in page (reader mode) ── */
  const matches = useMemo(() => (find.open && reader ? findMatches(reader.text, find.q) : []), [find.open, find.q, reader]);
  const matchAt = matches.length ? ((find.at % matches.length) + matches.length) % matches.length : -1;
  useEffect(() => {
    if (matchAt < 0) return;
    readerBox.current?.querySelector(`[data-hit="${matchAt}"]`)?.scrollIntoView({ block: "center" });
  }, [matchAt, find.q]);
  const openFind = useCallback(() => {
    setFind((f) => ({ ...f, open: true }));
    requestAnimationFrame(() => findInput.current?.focus());
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "f" && view === "reader") { e.preventDefault(); openFind(); }
    else if (mod && e.key.toLowerCase() === "t") { e.preventDefault(); addTab(); }
    else if (e.key === "Escape" && find.open) setFind({ open: false, q: "", at: 0 });
  };

  const libList = useMemo(() => {
    if (library === "bookmarks") return searchPlaces(data.bookmarks, libQuery, 200);
    if (library === "history") return searchPlaces(data.history, libQuery, 200);
    return [];
  }, [library, libQuery, data.bookmarks, data.history]);

  const autoNote = autoNotes[tab.id] || null;

  return (
    <div ref={rootRef} className="app-surface flex h-full flex-col" onKeyDown={onKeyDown}>
      {/* Tab strip */}
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--border)] px-1.5 pt-1" role="tablist" aria-label="Browser tabs">
        {tabsState.tabs.map((t, i) => (
          <div
            key={t.id}
            data-browser-tab={t.id}
            draggable
            onDragStart={(e) => { setDragId(t.id); e.dataTransfer.effectAllowed = "move"; }}
            onDragOver={(e) => { if (dragId) e.preventDefault(); }}
            onDrop={(e) => { e.preventDefault(); if (dragId) setTabs((s) => moveTab(s, dragId, i)); setDragId(null); }}
            onDragEnd={() => setDragId(null)}
            className={cn(
              "group flex max-w-44 shrink-0 items-center gap-1 rounded-t-[calc(var(--radius)*0.6)] border border-b-0 px-2 py-1 text-[11px]",
              t.id === tab.id ? "border-[var(--border)] bg-[var(--accent)]/12" : "border-transparent opacity-75 hover:opacity-100",
            )}
          >
            <button
              role="tab"
              aria-selected={t.id === tab.id}
              className="min-w-0 flex-1 truncate text-left"
              onClick={() => selectTab(t.id)}
              title={currentEntry(t)?.url ?? "New tab"}
            >
              {tabLabel(t)}
            </button>
            <button className="shrink-0 opacity-60 hover:opacity-100" onClick={() => closeOne(t.id)} aria-label={`Close tab ${tabLabel(t)}`} title="Close tab">
              <Icon name="close" size={10} />
            </button>
          </div>
        ))}
        <button className="os-btn shrink-0 !px-1.5 !py-0.5" onClick={() => addTab()} aria-label="New tab" title="New tab (Ctrl+T)" disabled={tabsState.tabs.length >= MAX_TABS}>
          <Icon name="plus" size={11} />
        </button>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border)] px-2.5 py-1.5">
        <div className="flex gap-0.5">
          <button className="os-btn !px-1.5 !py-1 text-[11px]" onClick={() => step(-1)} disabled={tab.index <= 0} aria-label="Back" title="Back">
            <Icon name="chevronRight" className="rotate-180" />
          </button>
          <button className="os-btn !px-1.5 !py-1 text-[11px]" onClick={() => step(1)} disabled={tab.index >= tab.entries.length - 1} aria-label="Forward" title="Forward">
            <Icon name="chevronRight" />
          </button>
          <button className="os-btn !px-1.5 !py-1 text-[11px]" onClick={reload} disabled={!current} aria-label="Reload" title="Reload">
            <Icon name="refresh" />
          </button>
        </div>
        <input
          value={tab.draft}
          onChange={(e) => setTabs((s) => patchTab(s, tab.id, { draft: e.target.value }))}
          onKeyDown={(e) => { if (e.key === "Enter") void go(tab.id, tab.draft); }}
          placeholder={`Address or search ${engineById(data.engineId).name}…`}
          aria-label="Address"
          className="os-input min-w-32 flex-1 !py-1 text-[12px]"
          style={{ fontSize: 16 }}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
        <button className="os-btn !py-1 text-[11px]" onClick={() => void go(tab.id, tab.draft)} disabled={Boolean(busy)}>Go</button>
        <button
          className={cn("os-btn !px-1.5 !py-1 text-[11px]", bookmarked && "!border-[var(--accent)] !text-[var(--accent)]")}
          onClick={() => current && data.toggleBookmark(current.url, current.title ?? "")}
          disabled={!current}
          aria-pressed={bookmarked}
          aria-label={bookmarked ? "Remove bookmark" : "Bookmark this page"}
          title={bookmarked ? "Remove bookmark" : "Bookmark this page"}
        >
          <Icon name="star" size={12} />
        </button>
        <div className="flex gap-0.5" role="group" aria-label="Browsing mode">
          {MODES.map((m) => (
            <button
              key={m}
              onClick={() => switchView(m)}
              title={MODE_HINT[m]}
              aria-pressed={tab.mode === m}
              className={cn("os-btn !py-1 text-[11px]", tab.mode === m && "!border-[var(--accent)] !bg-[var(--accent)]/16")}
            >
              {m}
            </button>
          ))}
        </div>
        <div className="flex gap-0.5">
          <button className="os-btn !px-1.5 !py-1 text-[11px]" onClick={() => setLibrary((l) => (l === "bookmarks" ? null : "bookmarks"))} aria-pressed={library === "bookmarks"} aria-label="Bookmarks" title="Bookmarks">
            <Icon name="star" size={12} /><span className="ml-0.5">{data.bookmarks.length}</span>
          </button>
          <button className="os-btn !px-1.5 !py-1 text-[11px]" onClick={() => setLibrary((l) => (l === "history" ? null : "history"))} aria-pressed={library === "history"} aria-label="History" title="History">
            <Icon name="clock" size={12} />
          </button>
          {current && (
            <>
              <button className="os-btn !px-1.5 !py-1 text-[11px]" onClick={() => void savePage()} disabled={Boolean(busy)} aria-label="Save page to Files" title="Save page text to Files">
                <Icon name="save" size={12} />
              </button>
              <button className="os-btn !px-1.5 !py-1 text-[11px]" onClick={() => void askAI()} disabled={Boolean(busy)} aria-label="Ask AI about this page" title="Ask AI about this page">
                <Icon name="spark" size={12} />
              </button>
              {view === "reader" && (
                <button className="os-btn !px-1.5 !py-1 text-[11px]" onClick={openFind} aria-label="Find in page" title="Find in page (Ctrl+F)">
                  <Icon name="search" size={12} />
                </button>
              )}
              {view !== "cloud" && (
                <a href={current.url} target="_blank" rel="noopener noreferrer" className="os-btn !px-1.5 !py-1 text-[11px]" aria-label="Open in a real browser tab" title="Open in a real browser tab">
                  <Icon name="external" size={12} />
                </a>
              )}
            </>
          )}
        </div>
      </div>

      {(autoNote || view === "web" || cloud || (media && current?.url !== media.url)) && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border)] px-2.5 py-1 text-[10.5px] text-[var(--muted)]">
          {autoNote && <span className="os-chip !text-[10px]">{autoNote}</span>}
          {media && current && current.url !== media.url && (
            <span className="flex flex-wrap items-center gap-1" data-browser-sound>
              {view === "cloud" ? "Cloud sessions stream the picture only, with no sound (Steel's live view has no audio track)." : "This page has a video or audio track."}
              <button className="os-btn !px-1.5 !py-0 !text-[10px]" data-variant="primary" onClick={() => void go(tab.id, media.url, "frame")} aria-label={`Play with sound here using the ${media.label}`}>
                <Icon name="speaker" size={10} className="mr-1" />Play with sound here
              </button>
            </span>
          )}
          {view === "web" && (
            <span className="flex flex-wrap items-center gap-1">
              <Icon name="shield" />
              Web mode: sandboxed proxy. Some script-heavy sites and logins break here; cookies are shared by every site in this window, so sign in to things in Cloud mode.
              {current && (
                <>
                  <button className="os-btn !px-1.5 !py-0 !text-[10px]" onClick={() => switchView("cloud")}>Try Cloud</button>
                  <button className="os-btn !px-1.5 !py-0 !text-[10px]" onClick={() => switchView("reader")}>Reader</button>
                </>
              )}
            </span>
          )}
          {cloud && (
            <span className="flex flex-wrap items-center gap-1.5" style={{ color: "var(--warn, #d97706)" }}>
              <Icon name="live" />
              Cloud session running on Steel: it uses your provider credits until stopped (auto-ends after {Math.round(cloud.timeoutMs / 60000)} min).
              <button className="os-btn !px-1.5 !py-0 !text-[10px]" onClick={() => void stopCloud()}>
                <Icon name="stop" /> Stop session
              </button>
            </span>
          )}
        </div>
      )}

      {find.open && view === "reader" && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--border)] px-2.5 py-1">
          <input
            ref={findInput}
            value={find.q}
            onChange={(e) => setFind({ open: true, q: e.target.value, at: 0 })}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); setFind((f) => ({ ...f, at: f.at + (e.shiftKey ? -1 : 1) })); } }}
            placeholder="Find in page"
            aria-label="Find in page"
            className="os-input min-w-0 flex-1 !py-0.5 text-[12px]"
            style={{ fontSize: 16 }}
          />
          <span className="shrink-0 text-[10.5px] tabular-nums text-[var(--muted)]" aria-live="polite">
            {find.q ? (matches.length ? `${matchAt + 1} of ${matches.length}` : "No matches") : ""}
          </span>
          <button className="os-btn !px-1.5 !py-0.5" onClick={() => setFind((f) => ({ ...f, at: f.at - 1 }))} disabled={!matches.length} aria-label="Previous match"><Icon name="arrowUp" size={11} /></button>
          <button className="os-btn !px-1.5 !py-0.5" onClick={() => setFind((f) => ({ ...f, at: f.at + 1 }))} disabled={!matches.length} aria-label="Next match"><Icon name="arrowDown" size={11} /></button>
          <button className="os-btn !px-1.5 !py-0.5" onClick={() => setFind({ open: false, q: "", at: 0 })} aria-label="Close find bar"><Icon name="close" size={11} /></button>
        </div>
      )}

      <div className="px-2.5 pt-2 empty:hidden"><ErrorNote error={error} onDismiss={() => setError(null)} /></div>

      <div className="relative min-h-0 flex-1">
        {busy && <div className="absolute inset-x-0 top-0 z-10 p-4"><Spinner label={busy} /></div>}

        {library && (
          <div className="absolute inset-0 z-20 flex flex-col bg-[var(--bg,var(--surface))]" style={{ background: "var(--window-bg, var(--bg))" }}>
            <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border)] px-2.5 py-1.5">
              <span className="text-[12px] font-medium">{library === "bookmarks" ? `Bookmarks (${data.bookmarks.length})` : `History (${data.history.length})`}</span>
              <input
                value={libQuery}
                onChange={(e) => setLibQuery(e.target.value)}
                placeholder={`Search ${library}`}
                aria-label={`Search ${library}`}
                className="os-input min-w-0 flex-1 !py-0.5 text-[12px]"
                style={{ fontSize: 16 }}
              />
              {library === "history" && data.history.length > 0 && (
                <button className="os-btn !py-0.5 text-[11px]" onClick={() => data.clearHistory()}>Clear history</button>
              )}
              <button className="os-btn !px-1.5 !py-0.5" onClick={() => setLibrary(null)} aria-label="Close library"><Icon name="close" size={11} /></button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {libList.length === 0 ? (
                <Empty icon={library === "bookmarks" ? "star" : "clock"} title={libQuery ? "No matches" : library === "bookmarks" ? "No bookmarks yet" : "No history yet"} body={library === "bookmarks" ? "Use the star in the toolbar or the right-click menu to bookmark a page." : "Pages you open are listed here, newest first."} />
              ) : libList.map((item) => (
                <div key={item.url} className="group flex items-center gap-2 rounded px-2 py-1 hover:bg-white/6">
                  <button className="min-w-0 flex-1 text-left" onClick={() => void go(tab.id, item.url)} title={item.url}>
                    <div className="truncate text-[12px]">{item.title}</div>
                    <div className="truncate text-[10px] text-[var(--muted)]">{item.url}</div>
                  </button>
                  <span className="shrink-0 text-[10px] text-[var(--muted)]">{"count" in item ? `${(item as Visit).count}x · ` : ""}{relTime(item.at)}</span>
                  <button className="shrink-0 opacity-60 hover:opacity-100" onClick={() => addTab(item.url)} aria-label={`Open ${item.title} in new tab`} title="Open in new tab"><Icon name="plus" size={11} /></button>
                  <button
                    className="shrink-0 opacity-60 hover:opacity-100"
                    onClick={() => (library === "bookmarks" ? data.toggleBookmark(item.url, item.title) : data.removeVisit(item.url))}
                    aria-label={library === "bookmarks" ? `Remove bookmark ${item.title}` : `Remove ${item.title} from history`}
                  >
                    <Icon name="trash" size={11} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Frame and web tabs stay mounted while hidden, so switching tabs does not reload them. */}
        {tabsState.tabs.map((t) => {
          const e = currentEntry(t);
          if (!e || (e.view !== "frame" && e.view !== "web")) return null;
          const hidden = t.id !== tab.id;
          const n = reloads[t.id] ?? 0;
          if (e.view === "frame") {
            return (
              <iframe
                key={`f${t.id}${n}`}
                src={e.url}
                className={cn("absolute inset-0 h-full w-full border-0 bg-white", hidden && "invisible")}
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-presentation"
                // Official video players refuse to play without a referrer, so
                // they get the origin only (never the path); everything else none.
                referrerPolicy={/^https:\/\/(www\.youtube-nocookie\.com|player\.vimeo\.com)\//.test(e.url) ? "strict-origin-when-cross-origin" : "no-referrer"}
                allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
                title={e.title || "Embedded page"}
              />
            );
          }
          const src = webSrc(sid, e.url);
          if (!src) return null;
          // No allow-same-origin: the page is served from this OS's origin and
          // must not be able to read its storage. The response also carries a
          // matching `sandbox` CSP, so this holds even if the frame is opened top-level.
          return (
            <iframe
              key={`w${t.id}${n}`}
              ref={(el) => { if (el) frames.current.set(t.id, el); else frames.current.delete(t.id); }}
              src={src}
              className={cn("absolute inset-0 h-full w-full border-0 bg-white", hidden && "invisible")}
              sandbox={SANDBOX_TOKENS}
              allow="fullscreen; autoplay; clipboard-write"
              title={e.title || "Proxied page"}
            />
          );
        })}

        {view === "cloud" && cloud && (
          <iframe
            src={cloud.liveUrl}
            className="h-full w-full border-0 bg-black"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            allow="clipboard-read; clipboard-write; autoplay; fullscreen"
            title="Cloud browser live view"
          />
        )}
        {view === "cloud" && !cloud && !busy && (needsKey || !cloudKey) && (
          <div className="h-full overflow-y-auto p-4">
            <div className="os-card mx-auto max-w-lg space-y-2 text-[12px]">
              <div className="flex items-center gap-2 text-[13px] font-medium"><Icon name="browser" /> Cloud mode needs a Steel API key</div>
              <p className="text-[var(--muted)]">
                Cloud mode runs a real Chromium on Steel&apos;s servers and streams it here, so any site works: logins,
                heavy apps, video. It uses your Steel account&apos;s credits while a session runs (sessions end when you
                press Stop, close this window, or after 15 minutes).
              </p>
              <ol className="list-decimal space-y-0.5 pl-5 text-[var(--muted)]">
                <li>Create a free account and an API key at <a className="text-[var(--accent)] underline" href={CLOUD_SIGNUP} target="_blank" rel="noopener noreferrer">app.steel.dev</a>.</li>
                <li>Paste it below. It stays in this browser with your other keys and is sent only to this OS&apos;s server, which forwards it to Steel.</li>
              </ol>
              <div className="flex gap-1.5">
                <input
                  type="password"
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                  placeholder="Steel API key"
                  aria-label="Steel API key"
                  autoComplete="off"
                  spellCheck={false}
                  className="os-input flex-1 !py-1 font-[family-name:var(--font-mono)] text-[11px]"
                />
                <button
                  className="os-btn !py-1 text-[11px]"
                  disabled={!keyDraft.trim()}
                  onClick={() => { settings.setAI("keys", { ...settings.ai.keys, [CLOUD_PROVIDER]: keyDraft.trim() }); setKeyDraft(""); setNeedsKey(false); }}
                >
                  Save key
                </button>
              </div>
              <p className="text-[10.5px] text-[var(--muted)]">A deployment can instead set STEEL_API_KEY on the server.</p>
              {cloudKey && !needsKey && <p className="text-[10.5px]">Key saved. Enter an address above to start a session.</p>}
            </div>
          </div>
        )}
        {view === "cloud" && !cloud && !busy && cloudKey && !needsKey && (
          <Empty icon="browser" title="No cloud session" body="Enter an address and press Go to start a remote browser session." />
        )}
        {view === "reader" && reader && !busy && (
          <div ref={readerBox} className="h-full overflow-y-auto p-4">
            <div className="mx-auto max-w-3xl">
              <h1 className="mb-1 text-xl font-medium">{reader.title}</h1>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <a href={reader.url} target="_blank" rel="noopener noreferrer" className="truncate text-[11px] text-[var(--accent)] underline">{reader.url}</a>
                <CopyButton text={reader.text} label="Copy text" />
                <span className="text-[10.5px] text-[var(--muted)]">{reader.text.length.toLocaleString()} characters</span>
              </div>
              {find.open && find.q && matches.length > 0 ? (
                <div className="whitespace-pre-wrap text-[13px] leading-relaxed">
                  {splitByMatches(reader.text, matches).map((run, i) =>
                    run.hit === null ? <span key={i}>{run.text}</span> : (
                      <mark
                        key={i}
                        data-hit={run.hit}
                        style={{ background: run.hit === matchAt ? "var(--accent)" : "color-mix(in srgb, var(--accent) 35%, transparent)", color: "inherit", borderRadius: 2 }}
                      >
                        {run.text}
                      </mark>
                    ),
                  )}
                </div>
              ) : (
                <Markdown text={reader.text} />
              )}
            </div>
          </div>
        )}
        {!current && !busy && !library && (
          <NewTabPage
            onGo={(u) => void go(tab.id, u)}
            onOpenNew={(u) => addTab(u)}
          />
        )}
      </div>
    </div>
  );
}

/** The page a fresh tab shows: search, bookmarks, recent pages, engine choice. */
function NewTabPage({ onGo, onOpenNew }: { onGo: (url: string) => void; onOpenNew: (url: string) => void }) {
  const data = useBrowserData();
  const [q, setQ] = useState("");
  const [custom, setCustom] = useState(data.customEngine);
  const recent = useMemo(() => searchPlaces(data.history, q, 12), [data.history, q]);
  const marks = useMemo(() => searchPlaces(data.bookmarks, q, 24), [data.bookmarks, q]);
  const remembered = Object.keys(data.hostModes).length;
  const customOk = validTemplate(custom);

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mx-auto max-w-2xl space-y-4">
        <form
          className="flex gap-1.5"
          onSubmit={(e) => { e.preventDefault(); if (q.trim()) onGo(q); }}
        >
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Search ${data.engineId === "custom" ? "with your engine" : engineById(data.engineId).name}, type an address, or filter your pages`}
            aria-label="Search or address"
            className="os-input min-w-0 flex-1 text-[13px]"
            style={{ fontSize: 16 }}
            autoCapitalize="none"
            spellCheck={false}
          />
          <button className="os-btn" data-variant="primary" type="submit" disabled={!q.trim()}>
            <Icon name="search" size={13} /> Go
          </button>
        </form>

        <section>
          <div className="os-label mb-1.5">Bookmarks {data.bookmarks.length > 0 && `(${marks.length}${q ? ` of ${data.bookmarks.length}` : ""})`}</div>
          {marks.length === 0 ? (
            <p className="text-[11.5px] text-[var(--muted)]">{q ? "No bookmark matches." : "No bookmarks yet. Use the star in the toolbar to add one."}</p>
          ) : (
            <div className="grid gap-1.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}>
              {marks.map((b) => (
                <button key={b.url} className="os-card !p-2 text-left" onClick={() => onGo(b.url)} title={b.url}>
                  <div className="truncate text-[12px]">{b.title}</div>
                  <div className="truncate text-[10px] text-[var(--muted)]">{hostOf(b.url)}</div>
                </button>
              ))}
            </div>
          )}
        </section>

        <section>
          <div className="os-label mb-1.5">Recent</div>
          {recent.length === 0 ? (
            <p className="text-[11.5px] text-[var(--muted)]">{q ? "No history matches." : "Nothing yet."}</p>
          ) : (
            <div>
              {recent.map((v) => (
                <div key={v.url} className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-white/6">
                  <button className="min-w-0 flex-1 truncate text-left text-[12px]" onClick={() => onGo(v.url)} title={v.url}>{v.title}</button>
                  <span className="shrink-0 text-[10px] text-[var(--muted)]">{relTime(v.at)}</span>
                  <button className="shrink-0 opacity-60 hover:opacity-100" onClick={() => onOpenNew(v.url)} aria-label={`Open ${v.title} in new tab`}><Icon name="plus" size={11} /></button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="os-card !p-2.5 text-[11.5px]">
          <div className="os-label mb-1.5">Search engine</div>
          <div className="flex flex-wrap items-center gap-1.5">
            <select
              className="os-input !w-auto !py-1 text-[11.5px]"
              value={data.engineId}
              onChange={(e) => data.setEngine(e.target.value)}
              aria-label="Search engine"
            >
              {SEARCH_ENGINES.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              <option value="custom">Custom…</option>
            </select>
            {data.engineId === "custom" && (
              <>
                <input
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  placeholder="https://search.example/?q=%s"
                  aria-label="Custom search URL"
                  className="os-input min-w-0 flex-1 !py-1 text-[11.5px]"
                  style={{ fontSize: 16 }}
                />
                <button className="os-btn !py-1 text-[11px]" disabled={!customOk} onClick={() => data.setEngine("custom", custom.trim())}>Save</button>
              </>
            )}
          </div>
          {data.engineId === "custom" && !validTemplate(data.customEngine) && (
            <p className="mt-1 text-[10.5px] text-[var(--muted)]">A custom URL needs http(s) and exactly one %s. Until one is saved, searches use DuckDuckGo.</p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[10.5px] text-[var(--muted)]">
            <span>{remembered} host{remembered === 1 ? "" : "s"} remembered as refusing framing (they start in Web mode).</span>
            {remembered > 0 && <button className="os-btn !px-1.5 !py-0 !text-[10px]" onClick={() => data.forgetHosts()}>Forget</button>}
          </div>
        </section>
      </div>
    </div>
  );
}
