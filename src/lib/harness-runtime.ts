"use client";

import { ask, withTraceParent } from "./useAI";
import { useSettings } from "@/kernel/settings";
import { useVFS } from "@/kernel/vfs";
import { bus } from "@/kernel/bus";
import { useHarness } from "@/kernel/harness";
import { registerAiosModule } from "./aios-api";
import { uid } from "./format";
import { runReAct, type LoopDeps } from "./harness/loop";
import { createRegistry, builtinTools, toolCatalogueText } from "./harness/tools";
import { webTools, DEFAULT_WEB_TOOLS } from "./harness/webtools";
import { SERVICES, type ServiceDef } from "./services";
import { FIXTURES } from "./harness/fixtures";
import { createFactStore } from "./harness/context";
import { traceToMarkdown } from "./harness/trace";
import { DEFAULT_LOOP_CONFIG, mergeConfig } from "./harness/config";
import type {
  DefinitionOfDone, Fact, LoopConfig, RunResult, Span, ToolDef, TriggerEvent,
} from "./harness/types";

/* ────────────────────────────────────────────────────────────────────────────
   Binding the pure harness to this OS.

   Everything under lib/harness/ is deliberately free of the browser: no
   window, no zustand, no ask(). That is what makes it testable in Node and
   what would let the same tool code serve an MCP route. The cost is that
   something has to hand it real implementations, and this is that something.

   The interesting binding is memory. A harness is only a different class of
   machine from a chat model because it can read and write external storage,
   so the agent's facts come from the OS filesystem and its artifacts go back
   into it — and every one of those reads and writes is a span, because a
   conclusion you cannot trace to what was read is not auditable.
   ──────────────────────────────────────────────────────────────────────────── */

export interface StartRunOptions {
  objective: string;
  dod: DefinitionOfDone;
  config?: Partial<LoopConfig>;
  /** Paths in the VFS the agent is allowed to see. Layer 4: what the agent may
   *  read is a decision someone makes, not whatever happens to be lying around. */
  factPaths?: string[];
  /** Service ids from lib/services.ts to expose as live tools. Omitted means
   *  DEFAULT_WEB_TOOLS; an explicit [] means none, which is what a run that
   *  must be replayable byte for byte should pass. */
  webServices?: string[];
  trigger?: Partial<TriggerEvent>;
  signal?: AbortSignal;
  approve?: (tool: ToolDef, args: Record<string, unknown>) => Promise<string | null>;
  onSpan?: (span: Span) => void;
}

/**
 * The harness's transport to the open web.
 *
 * `lib/harness/webtools.ts` is pure and takes this as a dependency, which is
 * what lets the whole live catalogue be driven in Node against recorded
 * payloads. This is the browser half: a CORS-enabled host directly, everything
 * else through the SSRF-guarded relay the Browser and Atlas apps already use.
 *
 * It THROWS on a bad status rather than returning the error body. A 429 page
 * handed to a parser produces a parse failure, and a parse failure reads as
 * "the API changed" — which would send whoever is debugging it in exactly the
 * wrong direction.
 */
async function browserFetchText(url: string, o: { signal: AbortSignal; reach: ServiceDef["reach"] }): Promise<string> {
  if (o.reach === "direct") {
    const res = await fetch(url, { signal: o.signal, headers: { accept: "application/json, text/plain, */*" } });
    if (!res.ok) throw new Error(`the service answered HTTP ${res.status}`);
    return res.text();
  }
  const res = await fetch(`/api/proxy?mode=raw&url=${encodeURIComponent(url)}`, { signal: o.signal });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) detail = j.error;
    } catch { /* a non-JSON error body is still an error */ }
    throw new Error(detail);
  }
  return res.text();
}

/** Turn allowed VFS paths into the agent's readable memory. */
function factsFrom(paths: string[]): Fact[] {
  const vfs = useVFS.getState();
  const out: Fact[] = [];
  for (const path of paths) {
    const node = vfs.read(path);
    if (!node?.content) continue;
    out.push({
      id: path,
      source: path,
      sourceKind: "vfs",
      text: node.content.slice(0, 8_000),
      weight: 1,
      updatedAt: node.updatedAt ?? Date.now(),
      volatile: false,
      tags: [],
    });
  }
  return out;
}

export async function startRun(opts: StartRunOptions): Promise<RunResult> {
  const settings = useSettings.getState();
  const vfs = useVFS.getState();

  // The model is configuration. Nothing below names a provider, which is the
  // whole point of the runtime layer: once traces exist, a model swap is a
  // settings change rather than an edit.
  const config = mergeConfig(DEFAULT_LOOP_CONFIG, {
    ...opts.config,
    llm: { ...DEFAULT_LOOP_CONFIG.llm, provider: settings.ai.provider, model: settings.ai.model, persona: false },
  });

  const runId = uid("run");
  const registry = createRegistry();
  for (const tool of builtinTools({
    fixtures: FIXTURES,
    writeArtifact: async (path, content) => {
      try {
        vfs.write(path, content, { appId: "harness" });
        return { ok: true, path };
      } catch (e) {
        return { ok: false, path, error: e instanceof Error ? e.message : "write failed" };
      }
    },
  })) registry.register(tool);

  // The free services, as live tools. Every one is marked non-deterministic,
  // which `toolCatalogueText` renders into the system prompt as "do not quote
  // it as a fixed figure" — the distinction between an audited number and a
  // live one is the whole reason the deterministic tools exist.
  const wanted = opts.webServices ?? DEFAULT_WEB_TOOLS;
  if (wanted.length > 0) {
    for (const tool of webTools({ only: wanted, fetchText: browserFetchText })) registry.register(tool);
  }

  const spans: Span[] = [];
  const emit = (span: Span) => {
    spans.push(span);
    // Observatory has listened for these since before anything emitted one.
    bus.emit("span", span);
    opts.onSpan?.(span);
  };

  const trigger: TriggerEvent = {
    triggerId: opts.trigger?.triggerId ?? uid("trg"),
    kind: opts.trigger?.kind ?? "manual",
    at: Date.now(),
    payload: opts.trigger?.payload ?? {},
    dedupeKey: opts.trigger?.dedupeKey ?? `${opts.objective}:${Date.now()}`,
  };

  const deps: LoopDeps = {
    llm: async (req) => {
      const res = await ask({
        messages: [{ role: "user", content: req.prompt }],
        system: req.system,
        model: req.model,
        temperature: req.temperature,
        maxTokens: req.maxTokens,
        persona: false,
        signal: opts.signal,
        trace: { parentId: req.parentSpanId, runId, role: req.role, name: req.label },
      });
      return {
        text: res.text, tokensIn: 0, tokensOut: 0, costUsd: res.costUsd, ms: res.ms,
        provider: config.llm.provider, model: req.model, spanId: req.parentSpanId,
      };
    },
    tools: registry,
    facts: createFactStore(factsFrom(opts.factPaths ?? [])),
    span: emit,
    now: () => Date.now(),
    uid,
    signal: opts.signal ?? new AbortController().signal,
    // ask() already commits spend; this only reads it, so nothing double-counts.
    spend: () => useSettings.getState().ai.spentUsd,
    approve: opts.approve ?? (async () => null),
    fingerprint: `${toolCatalogueText(registry.list()).length}:${FIXTURES.version}`,
  };

  const result = await withTraceParent({ runId }, () => runReAct(opts.objective, config, opts.dod, trigger, deps));

  // The receipt is written where the rest of the OS can read it, and the store
  // keeps only a pointer — a full trace per run would fill the quota.
  const tracePath = `/harness/runs/${result.runId}.md`;
  try {
    // Keys are redacted at write time: a trace is the thing people paste
    // into a bug report.
    vfs.write(tracePath, traceToMarkdown(result, Object.values(useSettings.getState().ai.keys).filter(Boolean)), { appId: "harness" });
  } catch {
    // A trace we could not store is worth saying nothing about here; the run
    // itself succeeded or failed on its own terms.
  }
  useHarness.getState().record(result, tracePath);
  return result;
}

/** Expose the harness on window.__aios so a run can be driven and inspected
 *  from outside the UI — which is how any of this gets verified. */
export function installHarness() {
  registerAiosModule("harness", {
    startRun,
    tools: () => {
      const r = createRegistry();
      for (const t of builtinTools({ fixtures: FIXTURES })) r.register(t);
      for (const t of webTools({ only: DEFAULT_WEB_TOOLS, fetchText: browserFetchText })) r.register(t);
      return r.list().map((t) => ({ name: t.name, deterministic: t.deterministic, openWorld: t.annotations.openWorld }));
    },
    services: () => SERVICES.map((s) => ({ id: s.id, provider: s.provider, reach: s.reach })),
    runs: () => useHarness.getState().runs,
    defaultConfig: DEFAULT_LOOP_CONFIG,
  });
}
