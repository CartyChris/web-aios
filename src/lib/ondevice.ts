/* The on-device model: Chrome's built-in Prompt API (Gemini Nano).

   Nothing leaves the device, no key is needed, and it works offline once the
   browser has downloaded the model. Feature-detected: where `LanguageModel`
   does not exist (Safari, Firefox, older Chrome) the provider says so plainly
   instead of failing. API per the Chrome guide:
   LanguageModel.availability() / create({ initialPrompts, monitor }) /
   session.promptStreaming(text, { signal }) / session.destroy(). Model output
   is untrusted text: callers render it as text, never as HTML. */

import type { ChatMessage } from "./ai-transport";

interface LMSession {
  promptStreaming(input: string, opts?: { signal?: AbortSignal }): AsyncIterable<string> | ReadableStream<string>;
  destroy(): void;
}
interface LMStatic {
  availability(): Promise<string>;
  create(opts: { initialPrompts?: Array<{ role: string; content: string }>; monitor?: (m: EventTarget) => void; signal?: AbortSignal }): Promise<LMSession>;
}

const api = (): LMStatic | undefined => (globalThis as unknown as { LanguageModel?: LMStatic }).LanguageModel;

export async function onDeviceStatus(): Promise<"unsupported" | "unavailable" | "downloadable" | "downloading" | "available"> {
  const lm = api();
  if (!lm) return "unsupported";
  try { return (await lm.availability()) as "unavailable" | "downloadable" | "downloading" | "available"; } catch { return "unavailable"; }
}

const text = (m: ChatMessage) => (typeof m.content === "string" ? m.content : m.content.map((p) => ("text" in p ? p.text : "")).join(""));

/** Stream a reply. Earlier Chrome builds yielded the whole text so far on each
 *  chunk and later ones yield only the new part; both are handled. */
export async function* promptOnDevice(system: string, messages: ChatMessage[], signal?: AbortSignal, onDownload?: (fraction: number) => void): AsyncGenerator<string> {
  const lm = api();
  if (!lm) throw new Error("This browser has no on-device model. Chrome's built-in AI (Prompt API) is needed; pick another provider here.");
  const status = await onDeviceStatus();
  if (status === "downloadable" || status === "downloading") {
    throw new Error("The on-device model is not downloaded yet. Open Settings, AI, and press \"Download on-device model\": Chrome only starts the download from a click.");
  }
  if (status === "unavailable") throw new Error("Chrome says the on-device model cannot run on this device (it needs enough memory and disk). Pick another provider.");
  const history = messages.filter((m) => m.role === "user" || m.role === "assistant");
  const last = history.pop();
  const session = await lm.create({
    initialPrompts: [...(system ? [{ role: "system", content: system }] : []), ...history.map((m) => ({ role: m.role, content: text(m) }))],
    monitor: (m) => m.addEventListener("downloadprogress", (e) => onDownload?.((e as unknown as { loaded: number }).loaded)),
    signal,
  });
  try {
    let sofar = "";
    const stream = session.promptStreaming(last ? text(last) : "", { signal });
    const iter: AsyncIterable<string> = Symbol.asyncIterator in (stream as object)
      ? (stream as AsyncIterable<string>)
      : { [Symbol.asyncIterator]: () => { const r = (stream as ReadableStream<string>).getReader(); return { next: () => r.read() as Promise<IteratorResult<string>> }; } };
    for await (const chunk of iter) {
      const delta = chunk.startsWith(sofar) && sofar ? chunk.slice(sofar.length) : chunk;
      sofar = chunk.startsWith(sofar) && sofar ? chunk : sofar + chunk;
      if (delta) yield delta;
    }
  } finally {
    session.destroy();
  }
}

/** Start (or finish) the model download. Chrome only allows this from a user
 *  gesture while the model is "downloadable" or "downloading", so it must be
 *  called directly from a click handler. Resolves when the model is ready. */
export async function downloadOnDeviceModel(onProgress?: (fraction: number) => void): Promise<void> {
  const lm = api();
  if (!lm) throw new Error("This browser has no on-device model API.");
  const s = await lm.create({ monitor: (m) => m.addEventListener("downloadprogress", (e) => onProgress?.((e as unknown as { loaded: number }).loaded)) });
  s.destroy();
}
