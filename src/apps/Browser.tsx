"use client";

import { useCallback, useState } from "react";
import { useVFS } from "@/kernel/vfs";
import { bus } from "@/kernel/bus";
import type { AppProps } from "@/kernel/types";
import { Empty, ErrorNote, Spinner, Markdown, CopyButton } from "./_ui";
import { cn } from "@/lib/cn";

/** Browser — embedded browsing with an honest fallback.
 *
 *  Most sites set X-Frame-Options or a frame-ancestors CSP and simply will not
 *  render in an iframe. Rather than showing a permanently blank pane, this
 *  offers a reader mode that fetches the page through the OS proxy and shows
 *  the text, which is also what an agent wants. */
export default function Browser({ args }: AppProps) {
  const vfs = useVFS();
  const [url, setUrl] = useState((args?.url as string) ?? "");
  const [loaded, setLoaded] = useState<string | null>(null);
  const [mode, setMode] = useState<"frame" | "reader">("frame");
  const [reader, setReader] = useState<{ title: string; text: string; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);

  const normalize = (raw: string) => {
    const t = raw.trim();
    if (!t) return "";
    if (/^https?:\/\//i.test(t)) return t;
    if (/^[\w-]+(\.[\w-]+)+/.test(t)) return `https://${t}`;
    return `https://duckduckgo.com/?q=${encodeURIComponent(t)}`;
  };

  const go = useCallback(async (raw?: string) => {
    const target = normalize(raw ?? url);
    if (!target) return;
    setError(null);
    setUrl(target);
    setHistory((h) => [target, ...h.filter((x) => x !== target)].slice(0, 30));
    bus.emit("activity", { source: "search", text: target });

    if (mode === "frame") { setLoaded(target); setReader(null); return; }

    setBusy(true);
    try {
      const res = await fetch(`/api/proxy?url=${encodeURIComponent(target)}&mode=text`);
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? `${res.status}`);
      setReader({ title: data.title || target, text: data.text ?? "", url: data.url });
      setLoaded(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not fetch that page.");
    } finally { setBusy(false); }
  }, [url, mode]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border)] px-2.5 py-1.5">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go()}
          placeholder="Address or search…"
          className="os-input min-w-32 flex-1 !py-1 text-[12px]"
          style={{ fontSize: 16 }}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
        <button className="os-btn !py-1 text-[11px]" onClick={() => go()} disabled={busy}>Go</button>
        <div className="flex gap-0.5">
          {(["frame", "reader"] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)} className={cn("os-btn !py-1 text-[11px]", mode === m && "!border-[var(--accent)] !bg-[var(--accent)]/16")}>{m}</button>
          ))}
        </div>
        {loaded && <a href={loaded} target="_blank" rel="noopener noreferrer" className="os-btn !py-1 text-[11px]">Open ↗</a>}
        {reader && (
          <button
            className="os-btn !py-1 text-[11px]"
            onClick={() => { vfs.write(`/web/${Date.now()}.md`, `# ${reader.title}\n\n<${reader.url}>\n\n${reader.text}`, { appId: "browser" }); bus.emit("notify", { title: "Saved to Files", kind: "success" }); }}
          >
            Save
          </button>
        )}
      </div>

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

      <div className="min-h-0 flex-1">
        {busy && <div className="p-4"><Spinner label="Fetching through the OS proxy…" /></div>}
        {!busy && loaded && (
          <iframe
            src={loaded}
            className="h-full w-full border-0 bg-white"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            referrerPolicy="no-referrer"
            title="Embedded page"
          />
        )}
        {!busy && reader && (
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
        {!busy && !loaded && !reader && (
          <Empty
            icon="browser"
            title="Nothing loaded"
            body="Type an address above. Frame mode embeds the page directly; many sites refuse to be framed, and reader mode fetches the text through the OS proxy instead."
          />
        )}
      </div>
    </div>
  );
}

function safeHost(u: string): string {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u.slice(0, 20); }
}
