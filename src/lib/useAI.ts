"use client";

import { useCallback, useRef, useState } from "react";
import { useSettings } from "@/kernel/settings";
import { assistantSteeringLine } from "@/lib/petmind";
import { bus } from "@/kernel/bus";
import { getProvider, estimateCost, estimateTokens } from "./providers";
import { streamChat, messageText, type ChatMessage } from "./ai-transport";

export interface AskOptions {
  messages: ChatMessage[];
  model?: string;
  provider?: string;
  temperature?: number;
  maxTokens?: number;
  system?: string;
  onDelta?: (delta: string, full: string) => void;
  signal?: AbortSignal;
  /** Force live web access on or off for this one call. Defaults to the
   *  Settings preference. */
  web?: boolean;
  /** Where this call belongs in a trace. Optional everywhere: an app that
   *  knows nothing about the harness still gets a span, just an unparented
   *  one. */
  trace?: { parentId?: string; runId?: string; role?: string; name?: string };
  /** Set false to send the system prompt exactly as given.
   *
   *  Everything the user talks to should sound like the same assistant, so the
   *  chosen voice and the "about you" note are prepended by default. The pet
   *  opts out: it has a personality of its own, and blending "deadpan" with
   *  "thorough" produces something that is neither. */
  persona?: boolean;
  /** Streams a reasoning model's thinking, which is not part of `text`. */
  onReasoning?: (delta: string, full: string) => void;
  reasoningEffort?: "low" | "medium" | "high";
  /** Default true: an empty answer is retried once with more room and less
   *  thinking. Set false where an empty reply is itself the signal. */
  rescueEmpty?: boolean;
}

export interface AskResult {
  text: string;
  costUsd: number;
  ms: number;
  /** The model's thinking, when it streamed any. */
  reasoning?: string;
  /** "length" means the token cap cut the reply off. */
  finish?: "stop" | "length";
  /** True when the first attempt came back empty and this is the retry. */
  rescued?: boolean;
}

/* ────────────────────────────────────────────────────────────────────────────
   Tracing.

   Every model call in this OS goes through ask(), which is the only reason
   the runtime layer is affordable: one function to instrument instead of
   twenty call sites, and no app has to know tracing exists. Observatory has
   subscribed to the "span" event since it was written and, until now, nothing
   in the codebase ever published one — a viewer with no producer.

   Two events per call, the same id both times. The first is emitted before the
   request so a call that hangs or throws is still visible as an open span;
   Observatory upserts by id, so the second replaces it. A span only written on
   success would make exactly the runs you need to debug the ones that leave no
   trace.
   ──────────────────────────────────────────────────────────────────────────── */

/** Parent for calls made by code that cannot pass `trace` down — a swarm
 *  worker deep inside a helper, say. The harness sets it around a run. */
let ambientParent: { parentId?: string; runId?: string } | null = null;

export function withTraceParent<T>(ctx: { parentId?: string; runId?: string } | null, fn: () => T): T {
  const previous = ambientParent;
  ambientParent = ctx;
  try {
    return fn();
  } finally {
    ambientParent = previous;
  }
}

let spanSeq = 0;
const nextSpanId = () => `sp_${(spanSeq++).toString(36)}_${Math.floor(performance.now()).toString(36)}`;

/** Route one chat call to the right place.
 *
 *  A local provider is fetched straight from the browser — a serverless
 *  function has no path to the user's localhost. Everything else goes through
 *  /api/ai/chat, which lets the deployment supply a key so a visitor without
 *  one still gets a working desktop. */
/** Providers cap output differently (DeepSeek's chat model stops at 8192),
 *  and a request above the cap is rejected outright rather than clamped. One
 *  step down to a size every current provider accepts, then give up. */
const TOKEN_LIMIT_ERROR = /max[_ ]?(?:completion[_ ]?)?tokens|maximum.{0,40}tokens|tokens.{0,40}(?:exceed|too large|must be|less than)/i;
async function askSized(opts: AskOptions): Promise<AskResult> {
  try {
    return await askOnce(opts);
  } catch (e) {
    const wanted = opts.maxTokens ?? 0;
    if (wanted > 8192 && TOKEN_LIMIT_ERROR.test((e as Error)?.message ?? "")) return askOnce({ ...opts, maxTokens: 8192 });
    throw e;
  }
}

export async function ask(opts: AskOptions): Promise<AskResult> {
  const first = await askSized(opts);
  if (first.text.trim() || opts.rescueEmpty === false || opts.signal?.aborted) return first;
  // Empty answer. With a reasoning model this is almost always the whole
  // max_tokens budget spent thinking, so the fix is room plus an instruction to
  // stop deliberating, not the same request again.
  const s = useSettings.getState();
  const base = opts.maxTokens ?? s.ai.maxTokens;
  const second = await askSized({
    ...opts,
    maxTokens: Math.min(32000, Math.max(base * 2, 8000)),
    reasoningEffort: "low",
    system: `${opts.system ?? s.ai.systemPrompt ?? ""}\n\nYour previous attempt produced no answer text${first.finish === "length" ? " because it ran out of tokens while thinking" : ""}. Think briefly, then write the final answer itself in full.`.trim(),
  });
  return { ...second, costUsd: first.costUsd + second.costUsd, ms: first.ms + second.ms, rescued: true };
}

async function askOnce(opts: AskOptions): Promise<AskResult> {
  const s = useSettings.getState();
  const providerId = opts.provider ?? s.ai.provider;
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`Unknown provider "${providerId}".`);

  const model = opts.model ?? s.ai.model;
  const baseSystem = opts.system ?? s.ai.systemPrompt;
  const system = opts.persona === false ? baseSystem : withPersona(baseSystem, s);
  const messages: ChatMessage[] = [
    ...(system ? [{ role: "system" as const, content: system }] : []),
    ...opts.messages.filter((m) => m.role !== "system"),
  ];

  if (s.ai.budgetUsd > 0 && s.ai.spentUsd >= s.ai.budgetUsd) {
    throw new Error(`AI budget of $${s.ai.budgetUsd.toFixed(2)} reached. Raise it in Settings → AI to continue.`);
  }

  const started = performance.now();
  let text = "";
  let reasoning = "";
  let finish: AskResult["finish"];
  let usage = { inputTokens: 0, outputTokens: 0 };

  const spanId = nextSpanId();
  const spanParent = opts.trace?.parentId ?? ambientParent?.parentId ?? null;
  const spanName = opts.trace?.name ?? `${providerId} · ${model}`;
  const emitSpan = (fields: Record<string, unknown>) =>
    bus.emit("span", {
      id: spanId,
      parentId: spanParent,
      name: spanName,
      kind: "model",
      startedAt: Date.now(),
      runId: opts.trace?.runId ?? ambientParent?.runId,
      role: opts.trace?.role ?? "llm",
      ...fields,
    });
  emitSpan({});

  const baseUrl = s.ai.baseUrls[providerId] || provider.baseUrl;
  const apiKey = s.ai.keys[providerId] ?? "";

  if (provider.local) {
    for await (const chunk of streamChat({
      dialect: provider.dialect, baseUrl, apiKey, model, messages,
      temperature: opts.temperature ?? s.ai.temperature,
      maxTokens: opts.maxTokens ?? s.ai.maxTokens,
      web: opts.web ?? s.ai.webAccess,
      reasoningEffort: opts.reasoningEffort,
      signal: opts.signal,
    })) {
      if (chunk.delta) { text += chunk.delta; opts.onDelta?.(chunk.delta, text); }
      if (chunk.reasoning) { reasoning += chunk.reasoning; opts.onReasoning?.(chunk.reasoning, reasoning); }
      if (chunk.finish) finish = chunk.finish;
      if (chunk.usage) usage = chunk.usage;
      if (chunk.done) break;
    }
  } else {
    const res = await fetch("/api/ai/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: providerId, model, messages,
        temperature: opts.temperature ?? s.ai.temperature,
        maxTokens: opts.maxTokens ?? s.ai.maxTokens,
        apiKey: apiKey || undefined,
        baseUrl: s.ai.baseUrls[providerId] || undefined,
        web: opts.web ?? s.ai.webAccess,
        reasoningEffort: opts.reasoningEffort,
      }),
      signal: opts.signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `${res.status} ${res.statusText}` }));
      const message = err.error ?? "Request failed.";
      emitSpan({ endedAt: Date.now(), error: message });
      throw new Error(message);
    }
    if (!res.body) {
      emitSpan({ endedAt: Date.now(), error: "No response stream." });
      throw new Error("No response stream.");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split(/\n\n/);
      buf = frames.pop() ?? "";
      for (const frame of frames) {
        const line = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        const evt = JSON.parse(line.slice(5).trim()) as { delta?: string; reasoning?: string; finish?: AskResult["finish"]; usage?: typeof usage; error?: string; done?: boolean };
        if (evt.error) throw new Error(evt.error);
        if (evt.delta) { text += evt.delta; opts.onDelta?.(evt.delta, text); }
        if (evt.reasoning) { reasoning += evt.reasoning; opts.onReasoning?.(evt.reasoning, reasoning); }
        if (evt.finish) finish = evt.finish;
        if (evt.usage) usage = evt.usage;
        if (evt.done) break outer;
      }
    }
  }

  // Providers that omit usage still need a budget estimate, so fall back to a
  // character-count approximation rather than silently charging nothing.
  const inTok = usage.inputTokens || estimateTokens(messages.map(messageText).join(" "));
  // Thinking is billed as output, so an estimate that ignores it undercounts
  // exactly the calls that cost the most.
  const outTok = usage.outputTokens || estimateTokens(text + reasoning);
  const costUsd = estimateCost(model, inTok, outTok);
  useSettings.getState().setAI("spentUsd", +(s.ai.spentUsd + costUsd).toFixed(6));
  const ms = Math.round(performance.now() - started);

  // Truncated: a span is a receipt, and a receipt that carries every token of
  // every reply will exhaust the origin's storage quota and take unrelated
  // stores down with it.
  emitSpan({ endedAt: Date.now(), tokensIn: inTok, tokensOut: outTok, costUsd, text: text.slice(0, 4000) });

  return { text, costUsd, ms, ...(reasoning ? { reasoning } : {}), ...(finish ? { finish } : {}) };
}

/** Layer the user's chosen voice and their "about you" note over a task
 *  prompt. The task comes first: a tone preference must not be able to talk a
 *  model out of the thing it was actually asked to do. */
export function withPersona(base: string, s = useSettings.getState()): string {
  const parts = [base].filter(Boolean);
  // One tone, from whichever source the user picked. Two would average into
  // neither — see assistantSteeringLine.
  const steer = assistantSteeringLine(s.assistantSteering, s.voice, s.petPersonality);
  if (steer) parts.push(steer);
  if (s.aboutMe.trim()) parts.push(`About the person you are helping: ${s.aboutMe.trim()}`);
  return parts.join("\n\n");
}

/** React wrapper with streaming text, in-flight state and cancellation. */
export function useAI() {
  const [streaming, setStreaming] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(async (opts: Omit<AskOptions, "onDelta" | "signal">) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setStreaming(true);
    setError(null);
    setText("");
    try {
      const result = await ask({ ...opts, signal: ctrl.signal, onDelta: (_d, full) => setText(full) });
      return result;
    } catch (e) {
      if ((e as Error).name === "AbortError") return null;
      const msg = e instanceof Error ? e.message : "Request failed.";
      setError(msg);
      throw e;
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, []);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  return { run, stop, streaming, text, error, setText };
}
