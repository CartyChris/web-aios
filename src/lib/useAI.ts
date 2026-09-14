"use client";

import { useCallback, useRef, useState } from "react";
import { useSettings } from "@/kernel/settings";
import { getProvider, estimateCost, estimateTokens } from "./providers";
import { streamChat, type ChatMessage } from "./ai-transport";

export interface AskOptions {
  messages: ChatMessage[];
  model?: string;
  provider?: string;
  temperature?: number;
  maxTokens?: number;
  system?: string;
  onDelta?: (delta: string, full: string) => void;
  signal?: AbortSignal;
}

export interface AskResult {
  text: string;
  costUsd: number;
  ms: number;
}

/** Route one chat call to the right place.
 *
 *  A local provider is fetched straight from the browser — a serverless
 *  function has no path to the user's localhost. Everything else goes through
 *  /api/ai/chat, which lets the deployment supply a key so a visitor without
 *  one still gets a working desktop. */
export async function ask(opts: AskOptions): Promise<AskResult> {
  const s = useSettings.getState();
  const providerId = opts.provider ?? s.ai.provider;
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`Unknown provider "${providerId}".`);

  const model = opts.model ?? s.ai.model;
  const messages: ChatMessage[] = [
    ...(opts.system ?? s.ai.systemPrompt ? [{ role: "system" as const, content: opts.system ?? s.ai.systemPrompt }] : []),
    ...opts.messages.filter((m) => m.role !== "system"),
  ];

  if (s.ai.budgetUsd > 0 && s.ai.spentUsd >= s.ai.budgetUsd) {
    throw new Error(`AI budget of $${s.ai.budgetUsd.toFixed(2)} reached. Raise it in Settings → AI to continue.`);
  }

  const started = performance.now();
  let text = "";
  let usage = { inputTokens: 0, outputTokens: 0 };

  const baseUrl = s.ai.baseUrls[providerId] || provider.baseUrl;
  const apiKey = s.ai.keys[providerId] ?? "";

  if (provider.local) {
    for await (const chunk of streamChat({
      dialect: provider.dialect, baseUrl, apiKey, model, messages,
      temperature: opts.temperature ?? s.ai.temperature,
      maxTokens: opts.maxTokens ?? s.ai.maxTokens,
      signal: opts.signal,
    })) {
      if (chunk.delta) { text += chunk.delta; opts.onDelta?.(chunk.delta, text); }
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
      }),
      signal: opts.signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `${res.status} ${res.statusText}` }));
      throw new Error(err.error ?? "Request failed.");
    }
    if (!res.body) throw new Error("No response stream.");

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
        const evt = JSON.parse(line.slice(5).trim()) as { delta?: string; usage?: typeof usage; error?: string; done?: boolean };
        if (evt.error) throw new Error(evt.error);
        if (evt.delta) { text += evt.delta; opts.onDelta?.(evt.delta, text); }
        if (evt.usage) usage = evt.usage;
        if (evt.done) break outer;
      }
    }
  }

  // Providers that omit usage still need a budget estimate, so fall back to a
  // character-count approximation rather than silently charging nothing.
  const inTok = usage.inputTokens || estimateTokens(messages.map((m) => m.content).join(" "));
  const outTok = usage.outputTokens || estimateTokens(text);
  const costUsd = estimateCost(model, inTok, outTok);
  useSettings.getState().setAI("spentUsd", +(s.ai.spentUsd + costUsd).toFixed(6));

  return { text, costUsd, ms: Math.round(performance.now() - started) };
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
