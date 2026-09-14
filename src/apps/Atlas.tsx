"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useVFS } from "@/kernel/vfs";
import { bus } from "@/kernel/bus";
import { ask } from "@/lib/useAI";
import type { AppProps } from "@/kernel/types";
import { uid, download, relTime } from "@/lib/format";
import { Markdown, CopyButton, ErrorNote, Tabs, Empty, Spinner } from "./_ui";
import { cn } from "@/lib/cn";
import { Icon } from "@/shell/icons";

/* ────────────────────────────────────────────────────────────────────────────
   Atlas — ported from Astro-Atlas-Research-Harness.

   The original's real contribution was refusing to let a model's prose float
   free of its sources: every claim carries a source id, confidence is derived
   from how many independent sources back it, and the export is a table you can
   audit rather than an essay you have to trust. That structure is preserved
   here; the fetching goes through the OS's SSRF-guarded proxy.
   ──────────────────────────────────────────────────────────────────────────── */

export interface Source {
  id: string;
  url: string;
  title: string;
  text: string;
  host: string;
  fetchedAt: number;
  trust: "high" | "medium" | "low" | "unknown";
  bytes: number;
  error?: string;
}

export interface Claim {
  id: string;
  text: string;
  sourceIds: string[];
  confidence: "corroborated" | "single-source" | "uncorroborated" | "contested";
}

export interface Mission {
  id: string;
  question: string;
  sources: Source[];
  claims: Claim[];
  brief: string;
  createdAt: number;
}

/** Domain heuristics for a first-pass trust label. Deliberately crude and
 *  labelled as a heuristic in the UI — the point is to make the user look, not
 *  to pretend the tool has judgement. */
function inferTrust(host: string): Source["trust"] {
  const h = host.toLowerCase();
  if (/\.(gov|mil|edu)$/.test(h) || /\.gov\./.test(h)) return "high";
  if (/(reuters|apnews|bbc|nature|science|arxiv|nih|who|worldbank|oecd|imf)\./.test(h)) return "high";
  if (/(wikipedia|britannica|stackexchange|stackoverflow|github)\./.test(h)) return "medium";
  if (/(medium|substack|blogspot|wordpress|reddit|quora|x|twitter|facebook)\./.test(h)) return "low";
  return "unknown";
}

const EXTRACT_PROMPT = `You extract claims from source documents.

Return ONLY a JSON array. Each element: {"text": "<one factual claim, one sentence>", "sources": ["<source id>", ...]}

Rules:
- A claim must be checkable. "The market is exciting" is not a claim; "Revenue grew 14% in 2025" is.
- Attribute every claim to the source ids that actually support it. Never attribute to a source that does not say it.
- If two sources contradict each other, emit BOTH claims with their own source ids. Do not silently pick one.
- Emit at most 25 claims. Prefer the load-bearing ones.
- Output nothing but the JSON array.`;

export default function Atlas({}: AppProps) {
  const vfs = useVFS();
  const [tab, setTab] = useState("mission");
  const [question, setQuestion] = useState("");
  const [urlInput, setUrlInput] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const addSource = useCallback(
    async (raw: string) => {
      const url = raw.trim();
      if (!url) return;
      const id = `S${sources.length + 1}`;
      setBusy(`Fetching ${url}…`);
      setError(null);
      try {
        const res = await fetch(`/api/proxy?url=${encodeURIComponent(url)}&mode=text`);
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error ?? `${res.status}`);
        const host = new URL(data.url).hostname;
        setSources((s) => [
          ...s,
          {
            id, url: data.url, title: data.title || host, text: data.text ?? "",
            host, fetchedAt: Date.now(), trust: inferTrust(host), bytes: (data.text ?? "").length,
          },
        ]);
        setUrlInput("");
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Fetch failed.";
        setError(`${url} — ${msg}`);
        setSources((s) => [...s, { id, url, title: url, text: "", host: safeHost(url), fetchedAt: Date.now(), trust: "unknown", bytes: 0, error: msg }]);
      } finally {
        setBusy(null);
      }
    },
    [sources.length],
  );

  const extractClaims = useCallback(async () => {
    const usable = sources.filter((s) => s.text && !s.error);
    if (!usable.length) { setError("Add at least one source that fetched successfully."); return; }
    setBusy("Extracting claims…");
    setError(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      // Each source is capped so a single long page cannot crowd out the rest
      // of the corpus in the context window.
      const budget = Math.max(1500, Math.floor(60_000 / usable.length));
      const corpus = usable
        .map((s) => `[${s.id}] ${s.title} (${s.host})\n${s.text.slice(0, budget)}`)
        .join("\n\n---\n\n");

      const res = await ask({
        messages: [{ role: "user", content: `Question under investigation: ${question || "(general survey)"}\n\nSources:\n\n${corpus}` }],
        system: EXTRACT_PROMPT,
        maxTokens: 3000,
        signal: ctrl.signal,
      });

      const parsed = parseJsonArray(res.text);
      if (!parsed) throw new Error("The model did not return parseable JSON. Try again or use a stronger model.");

      const next: Claim[] = parsed.map((c) => {
        const ids = (Array.isArray(c.sources) ? c.sources : []).filter((x): x is string => typeof x === "string" && usable.some((s) => s.id === x));
        return {
          id: uid("c"),
          text: String(c.text ?? "").trim(),
          sourceIds: ids,
          confidence: (ids.length >= 2 ? "corroborated" : ids.length === 1 ? "single-source" : "uncorroborated") as Claim["confidence"],
        };
      }).filter((c) => c.text);

      // A claim that another claim directly negates is marked contested rather
      // than left looking as solid as an unchallenged one.
      const marked = next.map((c) => {
        const negated = next.some((o) => o.id !== c.id && contradicts(c.text, o.text));
        return negated ? { ...c, confidence: "contested" as const } : c;
      });

      setClaims(marked);
      setTab("claims");
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError(e instanceof Error ? e.message : "Extraction failed.");
    } finally {
      setBusy(null);
    }
  }, [sources, question]);

  const writeBrief = useCallback(async () => {
    if (!claims.length) { setError("Extract claims first."); return; }
    setBusy("Writing brief…");
    setError(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const table = claims
        .map((c) => `- [${c.confidence}] ${c.text} ${c.sourceIds.length ? `(${c.sourceIds.join(", ")})` : "(no source)"}`)
        .join("\n");
      const sourceList = sources.map((s) => `${s.id} = ${s.title} — ${s.url} [trust: ${s.trust}]`).join("\n");
      const res = await ask({
        messages: [{ role: "user", content: `Question: ${question}\n\nExtracted claims:\n${table}\n\nSources:\n${sourceList}` }],
        system: `Write a research brief answering the question from ONLY the claims given.

Requirements:
- Cite every assertion with its source id in square brackets, e.g. [S1].
- Give contested claims their own paragraph and present both sides.
- End with a section "What this does not settle" listing the open questions.
- Do not introduce facts that are not in the claims. If the claims cannot answer the question, say so.`,
        maxTokens: 2500,
        signal: ctrl.signal,
        onDelta: (_d, full) => setBrief(full),
      });
      setBrief(res.text);
      setTab("brief");
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError(e instanceof Error ? e.message : "Brief failed.");
    } finally {
      setBusy(null);
    }
  }, [claims, sources, question]);

  const exportMd = useCallback(() => {
    const lines = [
      `# Atlas mission: ${question || "untitled"}`,
      "", `> ${new Date().toISOString()}`, "",
      "## Brief", "", brief || "_(not generated)_", "",
      "## Claims", "",
      "| Confidence | Claim | Sources |", "| --- | --- | --- |",
      ...claims.map((c) => `| ${c.confidence} | ${c.text.replace(/\|/g, "\\|")} | ${c.sourceIds.join(", ") || "—"} |`),
      "", "## Sources", "",
      ...sources.map((s) => `- **${s.id}** [${s.trust}] ${s.title} — <${s.url}>${s.error ? ` _(failed: ${s.error})_` : ""}`),
    ];
    return lines.join("\n");
  }, [question, brief, claims, sources]);

  const stats = useMemo(() => ({
    corroborated: claims.filter((c) => c.confidence === "corroborated").length,
    single: claims.filter((c) => c.confidence === "single-source").length,
    contested: claims.filter((c) => c.confidence === "contested").length,
    ok: sources.filter((s) => !s.error).length,
  }), [claims, sources]);

  return (
    <div className="flex h-full flex-col">
      <Tabs
        tabs={[
          { id: "mission", label: "Mission", icon: "deepwork" },
          { id: "sources", label: `Sources (${sources.length})`, icon: "link" },
          { id: "claims", label: `Claims (${claims.length})`, icon: "claim" },
          { id: "brief", label: "Brief", icon: "report" },
        ]}
        active={tab}
        onChange={setTab}
      />

      <div className="shrink-0 border-b border-[var(--border)] px-2.5 py-1.5">
        <ErrorNote error={error} onDismiss={() => setError(null)} />
        <div className="flex flex-wrap items-center gap-1.5">
          {busy ? (
            <>
              <Spinner label={busy} />
              <button className="os-btn !py-1 text-[11px]" onClick={() => abortRef.current?.abort()}>Cancel</button>
            </>
          ) : (
            <>
              <button className="os-btn !py-1 text-[11px]" onClick={extractClaims} disabled={!stats.ok}>Extract claims</button>
              <button className="os-btn !py-1 text-[11px]" onClick={writeBrief} disabled={!claims.length}>Write brief</button>
            </>
          )}
          <div className="flex-1" />
          {claims.length > 0 && (
            <>
              <span className="os-chip" title="Backed by 2+ independent sources"><Icon name="doubleCheck" size={11} /> {stats.corroborated}</span>
              <span className="os-chip" title="Only one source"><Icon name="half" size={11} /> {stats.single}</span>
              {stats.contested > 0 && <span className="os-chip !border-[var(--warn)] !bg-[var(--warn)]/15"><Icon name="warning" size={11} /> {stats.contested} contested</span>}
            </>
          )}
          {(claims.length > 0 || brief) && (
            <>
              <button className="os-btn !py-1 text-[11px]" onClick={() => { vfs.write(`/research/atlas-${Date.now()}.md`, exportMd(), { appId: "atlas" }); bus.emit("notify", { title: "Mission saved to Files", kind: "success" }); }}>Save</button>
              <button className="os-btn !py-1 text-[11px]" onClick={() => download(`atlas-${Date.now()}.md`, exportMd(), "text/markdown")}>Export</button>
            </>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === "mission" && (
          <div className="mx-auto max-w-2xl">
            <div className="os-label mb-1">Research question</div>
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              rows={3}
              placeholder="What are you trying to establish? Be specific — a vague question produces vague claims."
              className="os-input mb-3 resize-none"
            />
            <div className="os-label mb-1">Add a source URL</div>
            <div className="mb-3 flex gap-1.5">
              <input
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addSource(urlInput)}
                placeholder="https://…"
                className="os-input flex-1"
              />
              <button className="os-btn" onClick={() => addSource(urlInput)} disabled={!urlInput.trim() || !!busy}>Fetch</button>
            </div>
            <div className="os-card text-[12px] leading-relaxed text-[var(--muted)]">
              <div className="mb-1.5 font-medium text-[var(--text)]">How Atlas works</div>
              <ol className="list-decimal space-y-1 pl-4">
                <li>Fetch sources through the OS proxy, which strips markup and blocks private addresses.</li>
                <li>Extract checkable claims, each tagged with the source ids that support it.</li>
                <li>Confidence is derived, not asserted: two independent sources means corroborated, one means single-source, a direct contradiction means contested.</li>
                <li>The brief may only use extracted claims, and must cite each one.</li>
              </ol>
              <div className="mt-2">Trust labels are a domain heuristic, not a verdict. Check the source.</div>
            </div>
          </div>
        )}

        {tab === "sources" && (
          sources.length === 0 ? (
            <Empty icon="link" title="No sources yet" body="Add URLs on the Mission tab. Each one is fetched, stripped to readable text and given an id that claims cite." />
          ) : (
            <div className="space-y-2">
              {sources.map((s) => (
                <div key={s.id} className={cn("os-card", s.error && "!border-[var(--danger)]")}>
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <span className="os-chip">{s.id}</span>
                    <TrustBadge trust={s.trust} />
                    <span className="min-w-0 flex-1 truncate font-medium text-[13px]">{s.title}</span>
                    <span className="text-[10px] text-[var(--muted)]">{relTime(s.fetchedAt)}</span>
                    <button className="os-btn !px-2 !py-0.5 text-[11px]" onClick={() => setSources((x) => x.filter((y) => y.id !== s.id))}><Icon name="close" size={11} /></button>
                  </div>
                  <a href={s.url} target="_blank" rel="noopener noreferrer" className="block truncate text-[11px] text-[var(--accent)] underline">{s.url}</a>
                  {s.error ? (
                    <div className="mt-1 text-[11px] text-[var(--danger)]">Failed: {s.error}</div>
                  ) : (
                    <div className="mt-1 text-[11px] text-[var(--muted)]">{s.bytes.toLocaleString()} chars extracted · {s.text.slice(0, 180).replace(/\s+/g, " ")}…</div>
                  )}
                </div>
              ))}
            </div>
          )
        )}

        {tab === "claims" && (
          claims.length === 0 ? (
            <Empty icon="claim" title="No claims extracted" body="Add sources, then press “Extract claims”. Each claim is tied to the source ids that back it." />
          ) : (
            <div className="space-y-1.5">
              {claims.map((c) => (
                <div key={c.id} className="os-card flex items-start gap-2.5 !py-2">
                  <ConfidenceBadge confidence={c.confidence} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] leading-relaxed">{c.text}</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {c.sourceIds.length === 0 && <span className="text-[10px] text-[var(--danger)]">no supporting source</span>}
                      {c.sourceIds.map((sid) => {
                        const src = sources.find((s) => s.id === sid);
                        return (
                          <button
                            key={sid}
                            className="os-chip !text-[10px]"
                            title={src?.url}
                            onClick={() => src && window.open(src.url, "_blank", "noopener")}
                          >
                            {sid} · {src?.host ?? "?"}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )
        )}

        {tab === "brief" && (
          brief ? (
            <div className="mx-auto max-w-3xl">
              <div className="mb-2 flex justify-end"><CopyButton text={brief} /></div>
              <Markdown text={brief} />
            </div>
          ) : (
            <Empty icon="report" title="No brief yet" body="Extract claims first, then press “Write brief”. The brief may only use extracted claims and must cite each one." />
          )
        )}
      </div>
    </div>
  );
}

function TrustBadge({ trust }: { trust: Source["trust"] }) {
  const map = { high: "var(--ok)", medium: "var(--accent)", low: "var(--warn)", unknown: "var(--muted)" };
  return (
    <span className="os-chip !text-[10px]" style={{ borderColor: map[trust], background: `color-mix(in srgb, ${map[trust]} 14%, transparent)` }} title="Domain heuristic, not a verdict">
      {trust}
    </span>
  );
}

function ConfidenceBadge({ confidence }: { confidence: Claim["confidence"] }) {
  const map: Record<Claim["confidence"], { glyph: string; color: string; title: string }> = {
    corroborated: { glyph: "doubleCheck", color: "var(--ok)", title: "Two or more independent sources" },
    "single-source": { glyph: "half", color: "var(--accent)", title: "Exactly one source" },
    uncorroborated: { glyph: "circle", color: "var(--muted)", title: "No source attributed" },
    contested: { glyph: "warning", color: "var(--warn)", title: "Another claim contradicts this one" },
  };
  const c = map[confidence];
  return (
    <Icon name={c.glyph} size={13} className="mt-0.5 shrink-0" style={{ color: c.color }} label={c.title} />
  );
}

function safeHost(url: string): string {
  try { return new URL(url).hostname; } catch { return url.slice(0, 40); }
}

/** Models wrap JSON in prose and fences no matter how firmly you ask them not
 *  to, so find the array rather than trusting the whole response. */
function parseJsonArray(text: string): Array<{ text?: unknown; sources?: unknown }> | null {
  const candidates = [text, text.replace(/^[\s\S]*?```(?:json)?\s*/i, "").replace(/```[\s\S]*$/, "")];
  const bracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (bracket !== -1 && lastBracket > bracket) candidates.push(text.slice(bracket, lastBracket + 1));
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c.trim());
      if (Array.isArray(parsed)) return parsed;
    } catch { /* try the next shape */ }
  }
  return null;
}

/** Cheap contradiction test: same subject words, one negated. Deliberately
 *  conservative — a false "contested" flag is worse than a missed one, because
 *  it sends the reader chasing a disagreement that is not there. */
function contradicts(a: string, b: string): boolean {
  const neg = /\b(not|no|never|cannot|isn't|doesn't|didn't|won't|false|declined|decreased|fell)\b/i;
  const aNeg = neg.test(a);
  const bNeg = neg.test(b);
  if (aNeg === bNeg) return false;
  const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 4));
  const wa = words(a);
  const wb = words(b);
  if (wa.size < 3 || wb.size < 3) return false;
  const shared = [...wa].filter((w) => wb.has(w)).length;
  return shared / Math.min(wa.size, wb.size) > 0.6;
}
