/** Universal chat transport.
 *
 *  One function talks to every provider in the catalogue by translating to and
 *  from three wire dialects. This is deliberately hand-rolled rather than built
 *  on a provider SDK, for one hard reason: Ollama and LM Studio live on the
 *  user's own localhost, which a serverless function physically cannot reach.
 *  Those calls have to leave from the browser. Since a second, client-side code
 *  path was unavoidable, one transport that both the route handler and the
 *  browser can import is simpler — and more portable — than two.
 */

/** A piece of one message. Text is the common case; an image part is what
 *  makes a vision model able to *see* — a rendered 3D viewport, a screenshot,
 *  a reference photo — instead of only reading a description of it. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; dataUrl: string };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

/** Flatten a message to plain text — for token estimates, logs and any
 *  provider that cannot take an image. */
export function messageText(m: ChatMessage): string {
  return typeof m.content === "string"
    ? m.content
    : m.content.map((p) => (p.type === "text" ? p.text : "[image]")).join(" ");
}

/** Split `data:image/png;base64,AAAA` into its parts.
 *
 *  Returns null for anything that is not a base64 data URL: a remote https://
 *  image is passed through untouched on OpenAI, and the other two dialects
 *  cannot take a URL at all, so guessing would produce a silent failure. */
export function splitDataUrl(url: string): { mime: string; data: string } | null {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(url.trim());
  return m ? { mime: m[1], data: m[2] } : null;
}

const hasImage = (messages: ChatMessage[]) =>
  messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image"));

/** True when this request needs a model that can see. Callers use it to warn
 *  before spending a call on a model that will ignore the picture. */
export function requiresVision(messages: ChatMessage[]): boolean {
  return hasImage(messages);
}

export interface ChatRequest {
  dialect: "openai" | "anthropic" | "google";
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  signal?: AbortSignal;
  /** Give the model live web access. OpenRouter-only — see buildRequest. */
  web?: boolean;
  /** Ask for an image back as well as text (OpenRouter image models). */
  wantImage?: boolean;
}

export interface ChatChunk {
  delta: string;
  done: boolean;
  usage?: { inputTokens: number; outputTokens: number };
}

/** Build the provider-specific HTTP request. Exported so the server route and
 *  the browser build identical requests. */
export function buildRequest(req: ChatRequest): { url: string; init: RequestInit } {
  const base = req.baseUrl.replace(/\/+$/, "");
  const sys = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const rest = req.messages.filter((m) => m.role !== "system");

  if (req.dialect === "anthropic") {
    return {
      url: `${base}/messages`,
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": req.apiKey,
          "anthropic-version": "2023-06-01",
          // Required for browser-originated calls; harmless server-side.
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxTokens ?? 4096,
          temperature: req.temperature,
          ...(sys ? { system: sys } : {}),
          messages: rest.map((m) => ({ role: m.role, content: toAnthropicContent(m.content) })),
          stream: req.stream ?? true,
        }),
      },
    };
  }

  if (req.dialect === "google") {
    const action = req.stream ? "streamGenerateContent?alt=sse&" : "generateContent?";
    return {
      url: `${base}/models/${req.model}:${action}key=${encodeURIComponent(req.apiKey)}`,
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(sys ? { systemInstruction: { parts: [{ text: sys }] } } : {}),
          contents: rest.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: toGoogleParts(m.content) })),
          generationConfig: { temperature: req.temperature, maxOutputTokens: req.maxTokens ?? 4096 },
        }),
      },
    };
  }

  // OpenRouter's web plugin is what gives any model live search, whether or
  // not the underlying vendor has its own. It is sent only to OpenRouter:
  // every other OpenAI-compatible host ignores unknown keys in theory and
  // rejects the request in practice.
  const isOpenRouter = /openrouter\.ai/i.test(base);
  const extras: Record<string, unknown> = {};
  if (isOpenRouter && req.web) extras.plugins = [{ id: "web", max_results: 5 }];
  if (isOpenRouter && req.wantImage) extras.modalities = ["image", "text"];

  return {
    url: `${base}/chat/completions`,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(req.apiKey ? { authorization: `Bearer ${req.apiKey}` } : {}),
        // OpenRouter asks for these; every other OpenAI-compatible host ignores them.
        "http-referer": "https://web-aios.vercel.app",
        "x-title": "Web-AIOS",
      },
      body: JSON.stringify({
        model: req.model,
        messages: req.messages.map((m) => ({ role: m.role, content: toOpenAIContent(m.content) })),
        temperature: req.temperature,
        max_tokens: req.maxTokens ?? 4096,
        stream: req.stream ?? true,
        ...(req.stream ? { stream_options: { include_usage: true } } : {}),
        ...extras,
      }),
    },
  };
}

/* ── Content translation ──────────────────────────────────────────────────
   Three vendors, three shapes for the same picture. A plain string stays a
   plain string in every dialect, so nothing changes for the text-only path
   that every other app uses. */

function toOpenAIContent(c: ChatMessage["content"]) {
  if (typeof c === "string") return c;
  return c.map((p) =>
    p.type === "text"
      ? { type: "text", text: p.text }
      // OpenAI accepts a data: URL here directly, which is why this one needs
      // no base64 surgery.
      : { type: "image_url", image_url: { url: p.dataUrl } },
  );
}

function toAnthropicContent(c: ChatMessage["content"]) {
  if (typeof c === "string") return c;
  return c.map((p) => {
    if (p.type === "text") return { type: "text", text: p.text };
    const split = splitDataUrl(p.dataUrl);
    return split
      ? { type: "image", source: { type: "base64", media_type: split.mime, data: split.data } }
      : { type: "image", source: { type: "url", url: p.dataUrl } };
  });
}

function toGoogleParts(c: ChatMessage["content"]) {
  if (typeof c === "string") return [{ text: c }];
  return c.map((p) => {
    if (p.type === "text") return { text: p.text };
    const split = splitDataUrl(p.dataUrl);
    // Google has no URL form for inline image data, so an un-encoded image
    // degrades to a note rather than a malformed request the model cannot read.
    return split
      ? { inlineData: { mimeType: split.mime, data: split.data } }
      : { text: `[image at ${p.dataUrl}]` };
  });
}

/** Parse one dialect's SSE payload into a plain text delta. */
export function parseChunk(dialect: ChatRequest["dialect"], raw: string): ChatChunk | null {
  if (!raw || raw === "[DONE]") return raw === "[DONE]" ? { delta: "", done: true } : null;
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }

  if (dialect === "anthropic") {
    const type = json.type as string;
    if (type === "content_block_delta") {
      const d = json.delta as { text?: string } | undefined;
      return { delta: d?.text ?? "", done: false };
    }
    if (type === "message_delta") {
      const u = json.usage as { output_tokens?: number } | undefined;
      return { delta: "", done: false, usage: { inputTokens: 0, outputTokens: u?.output_tokens ?? 0 } };
    }
    if (type === "message_stop") return { delta: "", done: true };
    if (type === "error") {
      const e = json.error as { message?: string } | undefined;
      throw new Error(e?.message ?? "Provider error");
    }
    return null;
  }

  if (dialect === "google") {
    const cands = json.candidates as Array<{ content?: { parts?: Array<{ text?: string }> } }> | undefined;
    const text = cands?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    const um = json.usageMetadata as { promptTokenCount?: number; candidatesTokenCount?: number } | undefined;
    return {
      delta: text,
      done: false,
      ...(um ? { usage: { inputTokens: um.promptTokenCount ?? 0, outputTokens: um.candidatesTokenCount ?? 0 } } : {}),
    };
  }

  const err = json.error as { message?: string } | undefined;
  if (err) throw new Error(err.message ?? "Provider error");
  const choices = json.choices as Array<{ delta?: { content?: string }; message?: { content?: string } }> | undefined;
  const delta = choices?.[0]?.delta?.content ?? choices?.[0]?.message?.content ?? "";
  const usage = json.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
  return {
    delta,
    done: false,
    ...(usage ? { usage: { inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0 } } : {}),
  };
}

/** Consume an SSE body and yield deltas. Works in both runtimes. */
export async function* streamChat(req: ChatRequest): AsyncGenerator<ChatChunk> {
  const { url, init } = buildRequest({ ...req, stream: true });
  const res = await fetch(url, { ...init, signal: req.signal });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 400)}` : ""}`);
  }
  if (!res.body) throw new Error("Provider returned no stream body.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line; a frame may hold several
    // `data:` lines. Anything left in `buffer` is an incomplete frame.
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      for (const line of frame.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        const chunk = parseChunk(req.dialect, payload);
        if (chunk) {
          yield chunk;
          if (chunk.done) return;
        }
      }
    }
  }
  yield { delta: "", done: true };
}

/** Non-streaming convenience for agents that only need the final text. */
export async function completeChat(req: ChatRequest): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }> {
  let text = "";
  let usage = { inputTokens: 0, outputTokens: 0 };
  for await (const chunk of streamChat(req)) {
    text += chunk.delta;
    if (chunk.usage) usage = { inputTokens: chunk.usage.inputTokens || usage.inputTokens, outputTokens: chunk.usage.outputTokens || usage.outputTokens };
  }
  return { text, usage };
}
