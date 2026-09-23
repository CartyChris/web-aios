"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useVFS } from "@/kernel/vfs";
import { bus } from "@/kernel/bus";
import { useSettings } from "@/kernel/settings";
import type { AppProps } from "@/kernel/types";
import { Icon } from "@/shell/icons";
import { Empty, ErrorNote, Spinner, Markdown, CopyButton } from "./_ui";
import { cn } from "@/lib/cn";
import { SANDBOX_TOKENS, encodeTarget } from "@/lib/webproxy";

/** Browser — embedded browsing that actually reaches any site.
 *
 *  Five modes, picked per page:
 *   - auto:   asks /api/proxy?mode=headers whether the page allows framing,
 *             then uses frame if it does and web if it does not.
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
 *  Back/forward are kept here rather than in the iframe, because a cross-origin
 *  frame's history cannot be driven from outside; Web mode's shim reports every
 *  in-page navigation via postMessage so the address bar and history stay true. */

type Mode = "auto" | "frame" | "web" | "reader" | "cloud";
type View = Exclude<Mode, "auto">;
interface Entry { url: string; view: View; title?: string; confirmed: boolean }
interface CloudState { id: string; liveUrl: string; startedAt: number; timeoutMs: number }

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

export default function Browser({ args }: AppProps) {
  const vfs = useVFS();
  const settings = useSettings();
  const cloudKey = settings.ai.keys[CLOUD_PROVIDER] ?? "";
  const [url, setUrl] = useState((args?.url as string) ?? "");
  const [mode, setMode] = useState<Mode>("auto");
  // One state object so a push or a shim report updates list and cursor atomically.
  const [nav, setNav] = useState<{ entries: Entry[]; index: number }>({ entries: [], index: -1 });
  const [nonce, setNonce] = useState(0);
  const [autoNote, setAutoNote] = useState<string | null>(null);
  const [reader, setReader] = useState<{ title: string; text: string; url: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [sid] = useState(newSid);
  const [cloud, setCloud] = useState<CloudState | null>(null);
  const [needsKey, setNeedsKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const webFrame = useRef<HTMLIFrameElement>(null);
  const cloudRef = useRef<{ id: string; key: string } | null>(null);

  const { entries, index } = nav;
  const current = index >= 0 ? entries[index] ?? null : null;

  const normalize = (raw: string) => {
    const t = raw.trim();
    if (!t) return "";
    if (/^https?:\/\//i.test(t)) return t;
    if (/^[\w-]+(\.[\w-]+)+/.test(t)) return `https://${t}`;
    return `https://duckduckgo.com/?q=${encodeURIComponent(t)}`;
  };

  const push = useCallback((entry: Entry) => {
    setNav((n) => {
      const list = [...n.entries.slice(0, n.index + 1), entry].slice(-100);
      return { entries: list, index: list.length - 1 };
    });
  }, []);

  const loadReader = useCallback(async (target: string) => {
    setBusy("Fetching through the OS proxy…");
    try {
      const res = await fetch(`/api/proxy?url=${encodeURIComponent(target)}&mode=text`);
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? `${res.status}`);
      setReader({ title: data.title || target, text: data.text ?? "", url: data.url });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not fetch that page.");
    } finally { setBusy(null); }
  }, []);

  const cloudCall = useCallback(async (payload: Record<string, unknown>) => {
    const res = await fetch("/api/cloudbrowser", {
      method: "POST",
      headers: { "content-type": "application/json", ...(cloudKey ? { "x-api-key": cloudKey } : {}) },
      body: JSON.stringify({ provider: CLOUD_PROVIDER, ...payload }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && data.needsKey) { setNeedsKey(true); throw new Error(data.error ?? "A Steel API key is needed."); }
    if (!res.ok || data.error) throw new Error(data.error ?? `Cloud browser error ${res.status}`);
    return data;
  }, [cloudKey]);

  const cloudGo = useCallback(async (target: string) => {
    setBusy(cloud ? "Navigating the cloud browser…" : "Starting a cloud browser session…");
    try {
      if (cloud) {
        await cloudCall({ action: "navigate", sessionId: cloud.id, url: target });
      } else {
        const data = await cloudCall({ action: "create", url: target });
        setCloud({ id: data.id, liveUrl: data.liveUrl, startedAt: Date.now(), timeoutMs: data.timeoutMs ?? 0 });
        cloudRef.current = { id: data.id, key: cloudKey };
        setNeedsKey(false);
        if (data.warning) setError(`Session started, but the first navigation failed: ${data.warning}`);
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

  /** Show `target` in `view` without touching the history stack. */
  const show = useCallback(async (target: string, view: View) => {
    setError(null);
    setUrl(target);
    if (view !== "reader") setReader(null);
    if (view === "reader") await loadReader(target);
    if (view === "cloud") await cloudGo(target);
    setNonce((n) => n + 1);
  }, [loadReader, cloudGo]);

  const go = useCallback(async (raw?: string, forceMode?: Mode) => {
    const target = normalize(raw ?? url);
    if (!target) return;
    const chosen = forceMode ?? mode;
    setError(null);
    setHistory((h) => [target, ...h.filter((x) => x !== target)].slice(0, 30));
    bus.emit("activity", { source: "search", text: target });

    let view: View;
    if (chosen === "auto") {
      setBusy("Checking whether the site allows framing…");
      try {
        const res = await fetch(`/api/proxy?url=${encodeURIComponent(target)}&mode=headers`);
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error ?? `${res.status}`);
        view = data.frameable ? "frame" : "web";
        setAutoNote(data.frameable ? "auto: frame (site allows framing)" : `auto: web (${data.reason})`);
      } catch (e) {
        view = "web";
        setAutoNote(`auto: web (framing check failed: ${e instanceof Error ? e.message : "error"})`);
      } finally { setBusy(null); }
    } else {
      view = chosen;
      setAutoNote(null);
    }
    push({ url: target, view, confirmed: view !== "web" });
    await show(target, view);
  }, [url, mode, push, show]);

  const step = useCallback((delta: number) => {
    const next = index + delta;
    if (next < 0 || next >= entries.length) return;
    setNav((n) => ({ ...n, index: next }));
    const e = entries[next];
    void show(e.url, e.view);
  }, [index, entries, show]);

  const switchView = useCallback((m: Mode) => {
    setMode(m);
    if (current && m !== "auto" && m !== current.view) void go(current.url, m);
  }, [current, go]);

  // Web mode: the shim in the proxied page reports its real URL and title.
  // The sandboxed frame's origin is "null", so the source window is what is checked.
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      if (!webFrame.current || ev.source !== webFrame.current.contentWindow) return;
      const d = ev.data as { type?: string; url?: string; title?: string } | null;
      if (!d || d.type !== "aios-web" || typeof d.url !== "string" || !/^https?:\/\//i.test(d.url)) return;
      const reported = d.url.slice(0, 4000);
      const title = typeof d.title === "string" ? d.title.slice(0, 300) : "";
      setUrl(reported);
      setNav((n) => {
        const cur = n.entries[n.index];
        if (!cur) return n;
        // The first report after we navigated (possibly via redirects) confirms
        // the entry; a later, different URL is an in-page navigation.
        if (!cur.confirmed || cur.url === reported) {
          const list = n.entries.slice();
          list[n.index] = { ...cur, url: reported, title, confirmed: true };
          return { entries: list, index: n.index };
        }
        const list = [...n.entries.slice(0, n.index + 1), { url: reported, view: "web" as const, title, confirmed: true }].slice(-100);
        return { entries: list, index: list.length - 1 };
      });
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

  const view = current?.view ?? null;
  const frameSrc = current && view === "web" ? webSrc(sid, current.url) : null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border)] px-2.5 py-1.5">
        <div className="flex gap-0.5">
          <button className="os-btn !px-1.5 !py-1 text-[11px]" onClick={() => step(-1)} disabled={index <= 0} aria-label="Back" title="Back">
            <Icon name="chevronRight" className="rotate-180" />
          </button>
          <button className="os-btn !px-1.5 !py-1 text-[11px]" onClick={() => step(1)} disabled={index >= entries.length - 1} aria-label="Forward" title="Forward">
            <Icon name="chevronRight" />
          </button>
          <button className="os-btn !px-1.5 !py-1 text-[11px]" onClick={() => current && void show(current.url, current.view)} disabled={!current} aria-label="Reload" title="Reload">
            <Icon name="refresh" />
          </button>
        </div>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go()}
          placeholder="Address or search…"
          aria-label="Address"
          className="os-input min-w-32 flex-1 !py-1 text-[12px]"
          style={{ fontSize: 16 }}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
        <button className="os-btn !py-1 text-[11px]" onClick={() => go()} disabled={Boolean(busy)}>Go</button>
        <div className="flex gap-0.5" role="group" aria-label="Browsing mode">
          {MODES.map((m) => (
            <button
              key={m}
              onClick={() => switchView(m)}
              title={MODE_HINT[m]}
              aria-pressed={mode === m}
              className={cn("os-btn !py-1 text-[11px]", mode === m && "!border-[var(--accent)] !bg-[var(--accent)]/16")}
            >
              {m}
            </button>
          ))}
        </div>
        {current && view !== "cloud" && <a href={current.url} target="_blank" rel="noopener noreferrer" className="os-btn !py-1 text-[11px]">Open ↗</a>}
        {reader && view === "reader" && (
          <button
            className="os-btn !py-1 text-[11px]"
            onClick={() => { vfs.write(`/web/${Date.now()}.md`, `# ${reader.title}\n\n<${reader.url}>\n\n${reader.text}`, { appId: "browser" }); bus.emit("notify", { title: "Saved to Files", kind: "success" }); }}
          >
            Save
          </button>
        )}
      </div>

      {(autoNote || view === "web" || cloud) && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border)] px-2.5 py-1 text-[10.5px] text-[var(--muted)]">
          {autoNote && <span className="os-chip !text-[10px]">{autoNote}</span>}
          {view === "web" && (
            <span className="flex items-center gap-1">
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
            <span className="flex items-center gap-1.5" style={{ color: "var(--warn, #d97706)" }}>
              <Icon name="live" />
              Cloud session running on Steel: it uses your provider credits until stopped (auto-ends after {Math.round(cloud.timeoutMs / 60000)} min).
              <button className="os-btn !px-1.5 !py-0 !text-[10px]" onClick={() => void stopCloud()}>
                <Icon name="stop" /> Stop session
              </button>
            </span>
          )}
        </div>
      )}

      {history.length > 0 && (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--border)] px-2.5 py-1">
          {history.slice(0, 8).map((h) => (
            <button key={h} onClick={() => go(h)} className="os-btn shrink-0 !px-2 !py-0.5 !text-[10px]" title={h}>
              {safeHost(h)}
            </button>
          ))}
        </div>
      )}

      <div className="px-2.5 pt-2"><ErrorNote error={error} onDismiss={() => setError(null)} /></div>

      <div className="relative min-h-0 flex-1">
        {busy && <div className="absolute inset-x-0 top-0 z-10 p-4"><Spinner label={busy} /></div>}
        {view === "frame" && current && (
          <iframe
            key={`f${nonce}`}
            src={current.url}
            className="h-full w-full border-0 bg-white"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            referrerPolicy="no-referrer"
            title="Embedded page"
          />
        )}
        {view === "web" && frameSrc && (
          // No allow-same-origin: the page is served from this OS's origin and
          // must not be able to read its storage. The response also carries a
          // matching `sandbox` CSP, so this holds even if the frame is opened top-level.
          <iframe
            key={`w${nonce}`}
            ref={webFrame}
            src={frameSrc}
            className="h-full w-full border-0 bg-white"
            sandbox={SANDBOX_TOKENS}
            allow="fullscreen; autoplay; clipboard-write"
            title={current?.title || "Proxied page"}
          />
        )}
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
          <div className="h-full overflow-y-auto p-4">
            <div className="mx-auto max-w-3xl">
              <h1 className="mb-1 text-xl font-medium">{reader.title}</h1>
              <div className="mb-3 flex items-center gap-2">
                <a href={reader.url} target="_blank" rel="noopener noreferrer" className="truncate text-[11px] text-[var(--accent)] underline">{reader.url}</a>
                <CopyButton text={reader.text} label="Copy text" />
              </div>
              <Markdown text={reader.text} />
            </div>
          </div>
        )}
        {!current && !busy && (
          <Empty
            icon="browser"
            title="Nothing loaded"
            body="Type an address above. Auto embeds the page directly when the site allows it and otherwise loads it through the Web proxy. Reader fetches just the text; Cloud streams a real remote browser for sites that need logins or heavy scripts."
          />
        )}
      </div>
    </div>
  );
}

function safeHost(u: string): string {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u.slice(0, 20); }
}
