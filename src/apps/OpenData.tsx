"use client";

import { fetchServiceText } from "@/lib/service-fetch";
import { useCallback, useMemo, useState } from "react";
import { useVFS } from "@/kernel/vfs";
import { bus } from "@/kernel/bus";
import type { AppProps } from "@/kernel/types";
import {
  SERVICES, SERVICE_CATEGORIES, missingParams, withDefaults,
  type ServiceResult,
} from "@/lib/services";
import { download } from "@/lib/format";
import { Empty, ErrorNote, Spinner, CopyButton } from "./_ui";
import { cn } from "@/lib/cn";
import { Icon } from "@/shell/icons";

/* ────────────────────────────────────────────────────────────────────────────
   Open Data — every free service, no key required.

   This is the only app in the OS that works fully on a cold install. Everything
   else waits behind a provider key, which is the right default for a model call
   and the wrong one for a fact: a desktop that can do nothing at all until you
   paste a secret is a desktop most people close before they ever see it work.

   The catalogue and its parsers live in lib/services.ts and are unit-tested
   against recorded payloads, because that is the half that breaks — a public
   API renames a field and a parser that answers `[]` looks exactly like a query
   with no matches. This file is the surface: pick a service, fill its
   arguments, read the rows. Nothing here decides what a payload means.
   ──────────────────────────────────────────────────────────────────────────── */

const CATEGORY_LABEL: Record<string, string> = {
  knowledge: "Knowledge",
  science: "Science",
  earth: "Earth",
  finance: "Money",
  dev: "Software",
  language: "Language",
  civic: "Civic",
  media: "Culture",
};

const CATEGORY_ICON: Record<string, string> = {
  knowledge: "notes",
  science: "labs",
  earth: "atlas",
  finance: "report",
  dev: "ide",
  language: "chat",
  civic: "shield",
  media: "media",
};

interface Outcome {
  at: number;
  serviceId: string;
  /** Present on success. */
  data?: ServiceResult;
  /** "transport" and "parse" are different facts and the UI must not merge
   *  them — see the note on the empty state below. */
  failure?: { kind: "transport" | "parse"; message: string };
  ms: number;
  url: string;
}

export default function OpenData({}: AppProps) {
  const vfs = useVFS();
  const [category, setCategory] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>(SERVICES[0]?.id ?? "");
  const [args, setArgs] = useState<Record<string, Record<string, string>>>({});
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = useMemo(() => SERVICES.find((s) => s.id === selectedId) ?? SERVICES[0], [selectedId]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return SERVICES.filter((s) => {
      if (category !== "all" && s.category !== category) return false;
      if (!q) return true;
      return `${s.name} ${s.description} ${s.provider} ${s.id}`.toLowerCase().includes(q);
    });
  }, [category, query]);

  const currentArgs = args[selected?.id ?? ""] ?? {};
  const missing = selected ? missingParams(selected, currentArgs) : [];

  const setArg = useCallback((serviceId: string, name: string, value: string) => {
    setArgs((a) => ({ ...a, [serviceId]: { ...(a[serviceId] ?? {}), [name]: value } }));
  }, []);

  const run = useCallback(async () => {
    if (!selected || busy) return;
    const filled = withDefaults(selected, args[selected.id] ?? {});
    const still = missingParams(selected, filled);
    if (still.length > 0) {
      setError(`${selected.name} needs ${still.join(" and ")}.`);
      return;
    }

    setError(null);
    setBusy(true);
    const started = Date.now();
    const ctrl = new AbortController();

    try {
      const { body, url } = await fetchServiceText(selected, filled, ctrl.signal);
      // Parsed in a second try so a parse failure is never reported as a
      // transport failure. They mean opposite things to whoever reads this.
      try {
        const data = selected.parse(body);
        setOutcome({ at: started, serviceId: selected.id, data, ms: Date.now() - started, url });
        bus.emit("activity", { source: "service", text: `${selected.name} ${Object.values(filled).join(" ")}` });
      } catch (e) {
        setOutcome({
          at: started, serviceId: selected.id, ms: Date.now() - started, url,
          failure: { kind: "parse", message: e instanceof Error ? e.message : "The reply could not be read." },
        });
      }
    } catch (e) {
      setOutcome({
        at: started, serviceId: selected.id, ms: Date.now() - started, url: "",
        failure: { kind: "transport", message: e instanceof Error ? e.message : "The request failed." },
      });
    } finally {
      setBusy(false);
    }
  }, [selected, busy, args]);

  const saveToVfs = useCallback(() => {
    if (!selected || !outcome?.data) return;
    const path = `/opendata/${selected.id}-${new Date(outcome.at).toISOString().slice(0, 19).replace(/[:T]/g, "")}.md`;
    const lines = [
      `# ${selected.name}`,
      "",
      `> Source: ${selected.provider} — ${selected.licence}`,
      `> Retrieved: ${new Date(outcome.at).toISOString()}`,
      `> Request: ${outcome.url}`,
      "",
      outcome.data.summary,
      "",
      "| Result | Detail | Value |",
      "| --- | --- | --- |",
      ...outcome.data.rows.map((r) => `| ${esc(r.title)} | ${esc(r.detail)} | ${esc(r.meta ?? "")} |`),
    ];
    vfs.write(path, lines.join("\n"), { appId: "opendata" });
    bus.emit("notify", { title: "Saved to Files", body: path, kind: "success" });
  }, [selected, outcome, vfs]);

  if (!selected) return <Empty icon="signals" title="No services registered." />;

  return (
    <div className="app-split flex h-full min-h-0">
      {/* ── catalogue ─────────────────────────────────────────────────────── */}
      <aside className="app-sidebar flex w-64 shrink-0 flex-col border-r border-[var(--border)]">
        <div className="shrink-0 border-b border-[var(--border)] p-2">
          <input
            className="os-input w-full text-[12px]"
            placeholder="Filter services"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="mt-1.5 flex flex-wrap gap-1">
            <button
              onClick={() => setCategory("all")}
              className={cn("os-chip !py-0.5 text-[10px]", category === "all" && "!border-[var(--accent)] !text-[var(--accent)]")}
            >
              All {SERVICES.length}
            </button>
            {SERVICE_CATEGORIES.map((c) => (
              <button
                key={c}
                onClick={() => setCategory(c)}
                className={cn("os-chip !py-0.5 text-[10px]", category === c && "!border-[var(--accent)] !text-[var(--accent)]")}
              >
                {CATEGORY_LABEL[c] ?? c}
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-1.5">
          {visible.length === 0 && <p className="p-3 text-[11px] text-[var(--muted)]">Nothing matches that filter.</p>}
          {visible.map((s) => (
            <button
              key={s.id}
              onClick={() => { setSelectedId(s.id); setOutcome(null); setError(null); }}
              className={cn(
                "mb-0.5 flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                s.id === selected.id ? "bg-[var(--accent)]/16 text-[var(--fg)]" : "hover:bg-[var(--hover)]",
              )}
            >
              <Icon name={CATEGORY_ICON[s.category] ?? "signals"} className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-70" />
              <span className="min-w-0">
                <span className="block truncate text-[12px] font-medium">{s.name}</span>
                <span className="block truncate text-[10px] text-[var(--muted)]">{s.provider}</span>
              </span>
            </button>
          ))}
        </div>

        <p className="shrink-0 border-t border-[var(--border)] p-2 text-[10px] leading-snug text-[var(--muted)]">
          Every service here is free and needs no account. Each names its own licence; keep the attribution if you republish.
        </p>
      </aside>

      {/* ── the service ───────────────────────────────────────────────────── */}
      <section className="app-aside flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="shrink-0 border-b border-[var(--border)] p-2.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="truncate text-[13px] font-semibold">{selected.name}</h2>
              <p className="mt-0.5 text-[11px] leading-snug text-[var(--muted)]">{selected.description}</p>
            </div>
            <a
              href={selected.docs}
              target="_blank"
              rel="noreferrer noopener"
              className="os-chip shrink-0 !py-0.5 text-[10px]"
              title="Provider documentation"
            >
              <Icon name="external" className="h-3 w-3" /> Docs
            </a>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[10px] text-[var(--muted)]">
            <span className="os-chip !py-0.5 !text-[10px]">{selected.provider}</span>
            <span className="os-chip !py-0.5 !text-[10px]">{selected.licence}</span>
            <span className="os-chip !py-0.5 !text-[10px]">
              {selected.reach === "direct" ? "Fetched directly" : "Relayed (the host sets no CORS header)"}
            </span>
          </div>
        </header>

        <div className="shrink-0 border-b border-[var(--border)] p-2.5">
          <ErrorNote error={error} onDismiss={() => setError(null)} />
          <div className="grid gap-2 sm:grid-cols-2">
            {selected.params.map((p) => (
              <label key={p.name} className="block">
                <span className="os-label mb-0.5 block">
                  {p.label}
                  {p.required && <span className="ml-1 text-[var(--accent)]">required</span>}
                </span>
                <input
                  className="os-input w-full text-[12px]"
                  inputMode={p.kind === "number" ? "decimal" : "text"}
                  placeholder={p.placeholder}
                  value={currentArgs[p.name] ?? ""}
                  onChange={(e) => setArg(selected.id, p.name, e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void run(); }}
                />
                {p.default !== undefined && (currentArgs[p.name] ?? "") === "" && (
                  <span className="mt-0.5 block text-[10px] text-[var(--muted)]">Defaults to {p.default}</span>
                )}
              </label>
            ))}
            {selected.params.length === 0 && (
              <p className="text-[11px] text-[var(--muted)]">This service takes no arguments.</p>
            )}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button onClick={() => void run()} disabled={busy || missing.length > 0} className="os-btn">
              <Icon name="play" className="h-3.5 w-3.5" /> {busy ? "Fetching…" : "Fetch"}
            </button>
            {missing.length > 0 && (
              <span className="text-[11px] text-[var(--muted)]">Fill {missing.join(" and ")} first.</span>
            )}
            {outcome?.data && (
              <>
                <button onClick={saveToVfs} className="os-btn">
                  <Icon name="save" className="h-3.5 w-3.5" /> Save to Files
                </button>
                <CopyButton text={outcome.data.summary} label="Copy summary" />
                <button
                  onClick={() => download(`${selected.id}.json`, JSON.stringify(outcome.data?.rows ?? [], null, 2), "application/json")}
                  className="os-btn"
                >
                  <Icon name="download" className="h-3.5 w-3.5" /> JSON
                </button>
              </>
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-2.5">
          {busy && <Spinner label={`Asking ${selected.provider}…`} />}

          {!busy && !outcome && (
            <Empty
              icon="signals"
              title="Nothing fetched yet."
              body={`${selected.description} No key, no account — press Fetch.`}
            />
          )}

          {/* The three outcomes are rendered as three different things on
              purpose. A relay failure, an unreadable reply and a genuine miss
              mean the opposite of each other, and a UI that shows one grey
              "no results" box for all three teaches you to distrust the app. */}
          {!busy && outcome?.failure?.kind === "transport" && (
            <div className="os-card border-[var(--warn,#f59e0b)]/40 p-3">
              <p className="flex items-center gap-1.5 text-[12px] font-medium">
                <Icon name="warning" className="h-4 w-4" /> Could not reach {selected.provider}
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">{outcome.failure.message}</p>
              <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--muted)]">
                The query was never answered, so this is not an empty result. The host may be down, rate-limiting,
                or blocked by your network.
              </p>
            </div>
          )}

          {!busy && outcome?.failure?.kind === "parse" && (
            <div className="os-card border-[var(--warn,#f59e0b)]/40 p-3">
              <p className="flex items-center gap-1.5 text-[12px] font-medium">
                <Icon name="warning" className="h-4 w-4" /> {selected.provider} replied, but not in a shape this reader knows
              </p>
              <p className="mt-1 font-mono text-[11px] leading-relaxed text-[var(--muted)]">{outcome.failure.message}</p>
              <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--muted)]">
                This usually means the API changed. It is not the same as your query matching nothing.
              </p>
            </div>
          )}

          {!busy && outcome?.data?.empty && (
            <Empty
              icon="search"
              title="No matches."
              body={`${selected.provider} answered normally — the query simply matched nothing. Try a broader or differently spelled term.`}
            />
          )}

          {!busy && outcome?.data && !outcome.data.empty && (
            <>
              <p className="mb-2 flex flex-wrap items-center gap-2 text-[10px] text-[var(--muted)]">
                <span>{outcome.data.rows.length} result{outcome.data.rows.length === 1 ? "" : "s"}</span>
                <span>·</span>
                <span>{outcome.ms} ms</span>
                <span>·</span>
                <span>{new Date(outcome.at).toLocaleTimeString()}</span>
                <span>·</span>
                <span>{selected.provider}, {selected.licence}</span>
              </p>
              <ul className="space-y-1.5">
                {outcome.data.rows.map((r, i) => (
                  <li key={`${r.title}-${i}`} className="os-card p-2.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        {r.url ? (
                          <a
                            href={r.url}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="text-[12px] font-medium text-[var(--accent)] hover:underline"
                          >
                            {r.title}
                          </a>
                        ) : (
                          <span className="text-[12px] font-medium">{r.title}</span>
                        )}
                        <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--muted)]">{r.detail}</p>
                      </div>
                      {r.meta && (
                        <span className="os-chip shrink-0 !py-0.5 whitespace-nowrap !text-[10px]">{r.meta}</span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </section>
    </div>
  );
}

/** A pipe inside a markdown table cell ends the cell early and silently
 *  shifts every column after it. */
function esc(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
