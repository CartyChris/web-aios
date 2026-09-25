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
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  /** Assistant turn only: the native tool calls the model made in this turn. */
  toolCalls?: ToolCall[];
  /** Tool turn only: which call this result answers, and that tool's name
   *  (Google matches a result to its call by name, not by id). */
  toolCallId?: string;
  toolName?: string;
  /** Assistant tool-call turn only: the model's reasoning for it. DeepSeek's
   *  thinking mode requires it back as reasoning_content on the next step of
   *  the same turn, or rejects the request. */
  reasoning?: string;
}

/* ── Native tool calling ──────────────────────────────────────────────────
   Additive: a request with no `tools` and no tool-shaped messages is built
   byte-for-byte as before, and a chunk with no tool payload parses as before.
   Three dialects, three shapes:
     OpenAI     tools[{type:"function",function}] -> streamed delta.tool_calls[{index,id?,function:{name?,arguments}}]
     Anthropic  tools[{name,description,input_schema}] -> content_block_start{tool_use} + input_json_delta
     Google     tools[{functionDeclarations}] -> whole functionCall parts, no ids */

/** A tool the model may call. `parameters` is a JSON Schema object. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** One complete tool call. `args` is the raw JSON text the model produced. */
export interface ToolCall {
  id: string;
  name: string;
  args: string;
  /** Gemini 3's thought signature for this call. It must be replayed on the
   *  functionCall part or the next step is rejected with 400. */
  signature?: string;
}

/** A streamed fragment of a tool call. OpenAI and Anthropic send the name and
 *  id once and the arguments in pieces keyed by `index`; Google sends each call
 *  whole, which is marked `complete` so the accumulator appends it instead of
 *  merging it into whatever shares its index. */
export interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  argsDelta?: string;
  complete?: boolean;
  signature?: string;
}

/** Fold tool-call deltas into complete calls. Pure; keep one per response. */
let accumulatorSeq = 0;

export class ToolCallAccumulator {
  private calls: Array<{ id: string; name: string; args: string; signature?: string }> = [];
  /** Per-response tag for id-less calls. Positional ids alone ("call_0")
   *  repeat on every step, so step 2's result paired with step 1's card and
   *  Anthropic rejected the duplicate tool_use ids. */
  private readonly tag = (accumulatorSeq++).toString(36);
  private byIndex = new Map<number, number>();
  add(deltas: ToolCallDelta[] | undefined): void {
    for (const d of deltas ?? []) {
      let slot = d.complete ? undefined : this.byIndex.get(d.index);
      if (slot === undefined) {
        slot = this.calls.length;
        this.calls.push({ id: "", name: "", args: "" });
        if (!d.complete) this.byIndex.set(d.index, slot);
      }
      const c = this.calls[slot];
      if (d.id) c.id = d.id;
      if (d.name) c.name = d.name;
      if (d.argsDelta) c.args += d.argsDelta;
      if (d.signature) c.signature = d.signature;
    }
  }
  /** Complete calls in arrival order. A call the provider sent no id for gets
   *  a positional one, so a result can still be matched back to it. */
  result(): ToolCall[] {
    return this.calls.filter((c) => c.name).map((c, i) => ({ id: c.id || `call_${this.tag}_${i}`, name: c.name, args: c.args || "{}", ...(c.signature ? { signature: c.signature } : {}) }));
  }
}

/** Parse a tool call's argument text; malformed JSON is an error the model
 *  should see, not a crash. */
export function parseToolArgs(args: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const v = JSON.parse(args || "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "arguments must be a JSON object" };
    return { ok: true, value: v as Record<string, unknown> };
  } catch (e) {
    return { ok: false, error: `arguments are not valid JSON: ${(e as Error).message}` };
  }
}

/** Gemini's function schema is an OpenAPI subset and rejects keys such as
 *  `additionalProperties` and `$schema` outright, so only the portable subset
 *  is forwarded. */
export function toGoogleSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(toGoogleSchema);
  const src = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ["type", "description", "enum", "required", "format", "nullable"]) if (k in src) out[k] = src[k];
  if (src.items) out.items = toGoogleSchema(src.items);
  if (src.properties && typeof src.properties === "object") {
    out.properties = Object.fromEntries(Object.entries(src.properties as Record<string, unknown>).map(([k, v]) => [k, toGoogleSchema(v)]));
  }
  return out;
}

const safeArgs = (args: string): unknown => {
  const p = parseToolArgs(args);
  return p.ok ? p.value : {};
};
const hasToolShape = (messages: ChatMessage[]) => messages.some((m) => m.role === "tool" || (m.toolCalls?.length ?? 0) > 0);

function openAIMessage(m: ChatMessage, reasoningBack = false): Record<string, unknown> {
  if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId ?? "", content: messageText(m) };
  if (m.role === "assistant" && m.toolCalls?.length) {
    return {
      role: "assistant",
      content: messageText(m) || null,
      ...(reasoningBack && m.reasoning ? { reasoning_content: m.reasoning } : {}),
      tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args || "{}" } })),
    };
  }
  return { role: m.role, content: toOpenAIContent(m.content) };
}

/** Anthropic: tool results travel as a user turn of tool_result blocks, and
 *  consecutive results must share one user turn. */
function anthropicMessages(rest: ChatMessage[]): Array<Record<string, unknown>> {
  const out: Array<{ role: string; content: unknown }> = [];
  for (const m of rest) {
    if (m.role === "tool") {
      const block = { type: "tool_result", tool_use_id: m.toolCallId ?? "", content: messageText(m) };
      const prev = out.at(-1);
      if (prev && prev.role === "user" && Array.isArray(prev.content) && (prev.content as Array<{ type: string }>).every((b) => b.type === "tool_result")) {
        (prev.content as unknown[]).push(block);
      } else out.push({ role: "user", content: [block] });
      continue;
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      const text = messageText(m);
      out.push({
        role: "assistant",
        content: [
          ...(text ? [{ type: "text", text }] : []),
          ...m.toolCalls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: safeArgs(c.args) })),
        ],
      });
      continue;
    }
    out.push({ role: m.role, content: toAnthropicContent(m.content) });
  }
  return out;
}

function googleContents(rest: ChatMessage[]): Array<Record<string, unknown>> {
  const out: Array<{ role: string; parts: unknown[] }> = [];
  for (const m of rest) {
    if (m.role === "tool") {
      const part = { functionResponse: { name: m.toolName ?? "", response: { content: messageText(m) } } };
      const prev = out.at(-1);
      if (prev && prev.role === "user" && prev.parts.every((p) => typeof p === "object" && p !== null && "functionResponse" in p)) prev.parts.push(part);
      else out.push({ role: "user", parts: [part] });
      continue;
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      const text = messageText(m);
      out.push({ role: "model", parts: [...(text ? [{ text }] : []), ...m.toolCalls.map((c) => ({
        functionCall: { name: c.name, args: safeArgs(c.args) },
        // Gemini 3 requires the signature it issued. For calls that never had
        // one (history from another provider), Google documents this
        // placeholder as the way to skip validation.
        thoughtSignature: c.signature ?? "skip_thought_signature_validator",
      }))] });
      continue;
    }
    out.push({ role: m.role === "assistant" ? "model" : "user", parts: toGoogleParts(m.content) });
  }
  return out;
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
  /** Refuse redirects. Set by server relays for caller-chosen base URLs, so a
   *  public host cannot 307 the server into an internal address. */
  noRedirects?: boolean;
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
  /** How hard a reasoning model should think. Sent as OpenRouter's
   *  `reasoning.effort` or OpenAI's `reasoning_effort`; ignored elsewhere. */
  reasoningEffort?: "low" | "medium" | "high";
  /** Native tool calling. Omitted or empty = the request is unchanged. */
  tools?: ToolSpec[];
}

export interface ChatChunk {
  delta: string;
  done: boolean;
  usage?: { inputTokens: number; outputTokens: number };
  /** Thinking text from a reasoning model. Kept apart from `delta` because it
   *  is not the answer; dropping it entirely is how a model that spent its
   *  whole budget thinking came back looking like it had said nothing. */
  reasoning?: string;
  /** Normalised stop reason: "stop", or "length" when the token cap cut it off. */
  finish?: "stop" | "length";
  /** Streamed native tool-call fragments; fold them with ToolCallAccumulator. */
  toolCalls?: ToolCallDelta[];
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
          messages: hasToolShape(rest) ? anthropicMessages(rest) : rest.map((m) => ({ role: m.role, content: toAnthropicContent(m.content) })),
          ...(req.tools?.length ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}),
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
          contents: hasToolShape(rest) ? googleContents(rest) : rest.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: toGoogleParts(m.content) })),
          ...(req.tools?.length ? { tools: [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: toGoogleSchema(t.parameters) })) }] } : {}),
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
  if (req.reasoningEffort) {
    if (isOpenRouter) extras.reasoning = { effort: req.reasoningEffort };
    else if (/api\.openai\.com/i.test(base)) extras.reasoning_effort = req.reasoningEffort;
  }

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
        messages: hasToolShape(req.messages) ? req.messages.map((m) => openAIMessage(m, /deepseek/i.test(base))) : req.messages.map((m) => ({ role: m.role, content: toOpenAIContent(m.content) })),
        ...(req.tools?.length ? { tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
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
    if (type === "content_block_start") {
      const b = json.content_block as { type?: string; id?: string; name?: string } | undefined;
      if (b?.type === "tool_use") return { delta: "", done: false, toolCalls: [{ index: Number(json.index ?? 0), id: b.id, name: b.name }] };
      return null;
    }
    if (type === "content_block_delta") {
      const d = json.delta as { type?: string; text?: string; thinking?: string; partial_json?: string } | undefined;
      if (d?.type === "input_json_delta") return { delta: "", done: false, toolCalls: [{ index: Number(json.index ?? 0), argsDelta: d.partial_json ?? "" }] };
      return { delta: d?.text ?? "", done: false, ...(d?.thinking ? { reasoning: d.thinking } : {}) };
    }
    if (type === "message_delta") {
      const u = json.usage as { output_tokens?: number } | undefined;
      const stop = (json.delta as { stop_reason?: string } | undefined)?.stop_reason;
      return {
        delta: "", done: false, usage: { inputTokens: 0, outputTokens: u?.output_tokens ?? 0 },
        ...(stop ? { finish: stop === "max_tokens" ? "length" as const : "stop" as const } : {}),
      };
    }
    if (type === "message_stop") return { delta: "", done: true };
    if (type === "error") {
      const e = json.error as { message?: string } | undefined;
      throw new Error(e?.message ?? "Provider error");
    }
    return null;
  }

  if (dialect === "google") {
    const cands = json.candidates as Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean; thoughtSignature?: string; functionCall?: { name?: string; args?: unknown } }> }; finishReason?: string }> | undefined;
    const parts = cands?.[0]?.content?.parts ?? [];
    const calls: ToolCallDelta[] = parts
      .filter((p) => p.functionCall?.name)
      .map((p, i) => ({ index: i, name: p.functionCall!.name, argsDelta: JSON.stringify(p.functionCall!.args ?? {}), complete: true, ...(p.thoughtSignature ? { signature: p.thoughtSignature } : {}) }));
    const text = parts.filter((p) => !p.thought).map((p) => p.text ?? "").join("");
    const thought = parts.filter((p) => p.thought).map((p) => p.text ?? "").join("");
    const fr = cands?.[0]?.finishReason;
    const um = json.usageMetadata as { promptTokenCount?: number; candidatesTokenCount?: number } | undefined;
    return {
      delta: text,
      done: false,
      ...(thought ? { reasoning: thought } : {}),
      ...(calls.length ? { toolCalls: calls } : {}),
      ...(fr ? { finish: fr === "MAX_TOKENS" ? "length" as const : "stop" as const } : {}),
      ...(um ? { usage: { inputTokens: um.promptTokenCount ?? 0, outputTokens: um.candidatesTokenCount ?? 0 } } : {}),
    };
  }

  const err = json.error as { message?: string } | undefined;
  if (err) throw new Error(err.message ?? "Provider error");
  type RawCall = { index?: number; id?: string; function?: { name?: string; arguments?: string } };
  type Msg = { content?: string | null; reasoning?: string | null; reasoning_content?: string | null; tool_calls?: RawCall[] };
  const choices = json.choices as Array<{ delta?: Msg; message?: Msg; finish_reason?: string | null }> | undefined;
  const c0 = choices?.[0];
  const delta = c0?.delta?.content ?? c0?.message?.content ?? "";
  // OpenRouter streams thinking as `reasoning`, DeepSeek and several
  // OpenAI-compatible hosts as `reasoning_content`.
  const reasoning = c0?.delta?.reasoning ?? c0?.delta?.reasoning_content ?? c0?.message?.reasoning ?? c0?.message?.reasoning_content ?? "";
  const fr = c0?.finish_reason;
  const usage = json.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
  // Streamed calls arrive as delta.tool_calls; a non-streamed reply carries
  // whole calls on message.tool_calls, which have no index of their own.
  const rawCalls = c0?.delta?.tool_calls ?? c0?.message?.tool_calls;
  const toolCalls: ToolCallDelta[] | undefined = rawCalls?.map((c, i) => ({
    index: c.index ?? i,
    ...(c.id ? { id: c.id } : {}),
    ...(c.function?.name ? { name: c.function.name } : {}),
    ...(c.function?.arguments ? { argsDelta: c.function.arguments } : {}),
  }));
  return {
    delta,
    done: false,
    ...(reasoning ? { reasoning } : {}),
    ...(toolCalls?.length ? { toolCalls } : {}),
    ...(fr ? { finish: fr === "length" ? "length" as const : "stop" as const } : {}),
    ...(usage ? { usage: { inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0 } } : {}),
  };
}

/** Consume an SSE body and yield deltas. Works in both runtimes. */
export async function* streamChat(req: ChatRequest): AsyncGenerator<ChatChunk> {
  const { url, init } = buildRequest({ ...req, stream: true });
  const res = await fetch(url, { ...init, signal: req.signal, ...(req.noRedirects ? { redirect: "manual" as const } : {}) });

  if (req.noRedirects && (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400))) {
    throw new Error("The custom base URL answered with a redirect, which is refused for relayed requests.");
  }
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
