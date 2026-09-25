/* MCP Multi Round-Trip Requests (MRTR), client side — pure.

   Spec: https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr
   and the `_meta` / resultType rules in
   https://modelcontextprotocol.io/specification/2026-07-28/basic/index (read 2026-09-24).

   In 2026-07-28 a server no longer sends elicitation, sampling or roots
   requests down an open stream. It answers the client's own request with
     result: { resultType: "input_required", inputRequests?: {key: {method, params}}, requestState?: string }
   and the client retries the SAME method with a NEW JSON-RPC id and
     params.inputResponses = {key: <ElicitResult | CreateMessageResult | ListRootsResult>}
     params.requestState   = <the exact string it was given, only if it was given>

   Rules implemented and tested here:
   - absent resultType means "complete" (older servers); an unrecognised one is invalid;
   - input_required must carry inputRequests or requestState;
   - only tools/call, prompts/get and resources/read may return it;
   - requestState is echoed byte-for-byte and never included when absent;
   - a request for a capability the client did not declare is a server fault;
   - the loop is bounded, because a server MAY ask again forever. */

export const MRTR_METHODS = ["tools/call", "prompts/get", "resources/read"] as const;
export const DEFAULT_MAX_ROUNDS = 8;

export interface ClientCaps {
  elicitation: boolean;
  sampling: boolean;
  roots: boolean;
}

/** The ClientCapabilities object for `_meta` / initialize. */
export function capabilitiesObject(c: ClientCaps): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (c.elicitation) out.elicitation = { form: {} };
  if (c.sampling) out.sampling = {};
  if (c.roots) out.roots = {};
  return out;
}

/**
 * The per-request `_meta` keys the 2026-07-28 spec names:
 * protocolVersion and clientCapabilities are required; clientInfo is a SHOULD.
 */
export function specMeta(protocol: string, client: { name: string; version: string }, caps: ClientCaps): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/protocolVersion": protocol,
    "io.modelcontextprotocol/clientInfo": { name: client.name, version: client.version },
    "io.modelcontextprotocol/clientCapabilities": capabilitiesObject(caps),
  };
}

/* ── elicitation forms ───────────────────────────────────────────────────── */

export interface ElicitField {
  name: string;
  type: "string" | "number" | "integer" | "boolean";
  title?: string;
  description?: string;
  required: boolean;
  options?: string[];
  default?: string | number | boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A form-mode requestedSchema is a flat object of primitive properties. */
export function parseElicitSchema(schema: unknown): { ok: true; fields: ElicitField[] } | { ok: false; reason: string } {
  if (!isObj(schema) || schema.type !== "object" || !isObj(schema.properties)) {
    return { ok: false, reason: "requestedSchema must be an object schema with properties." };
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((x): x is string => typeof x === "string") : []);
  const fields: ElicitField[] = [];
  for (const [name, raw] of Object.entries(schema.properties)) {
    if (!isObj(raw)) return { ok: false, reason: `Property ${name} is not a schema.` };
    const t = raw.type;
    if (t !== "string" && t !== "number" && t !== "integer" && t !== "boolean") {
      return { ok: false, reason: `Property ${name} has unsupported type ${String(t)}; elicitation forms are flat primitives.` };
    }
    const f: ElicitField = { name, type: t, required: required.has(name) };
    if (typeof raw.title === "string") f.title = raw.title;
    if (typeof raw.description === "string") f.description = raw.description;
    const en = Array.isArray(raw.enum) ? raw.enum : Array.isArray(raw.oneOf) ? (raw.oneOf as unknown[]).map((o) => (isObj(o) ? o.const : undefined)) : null;
    if (en) f.options = en.filter((x): x is string => typeof x === "string");
    if (typeof raw.default === "string" || typeof raw.default === "number" || typeof raw.default === "boolean") f.default = raw.default;
    fields.push(f);
  }
  return { ok: true, fields };
}

/**
 * Turn what the user typed into ElicitResult content, validating against the
 * fields. Empty optional fields are omitted rather than sent as "".
 */
export function coerceElicit(fields: ElicitField[], raw: Record<string, string | boolean | undefined>):
  { ok: true; content: Record<string, string | number | boolean> } | { ok: false; errors: Record<string, string> } {
  const content: Record<string, string | number | boolean> = {};
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const v = raw[f.name];
    if (f.type === "boolean") {
      if (typeof v === "boolean") content[f.name] = v;
      else if (v === "true" || v === "false") content[f.name] = v === "true";
      else if (f.required) errors[f.name] = "Required.";
      continue;
    }
    const s = typeof v === "string" ? v.trim() : "";
    if (!s) { if (f.required) errors[f.name] = "Required."; continue; }
    if (f.type === "number" || f.type === "integer") {
      const n = Number(s);
      if (!Number.isFinite(n)) { errors[f.name] = "Must be a number."; continue; }
      if (f.type === "integer" && !Number.isInteger(n)) { errors[f.name] = "Must be a whole number."; continue; }
      content[f.name] = n;
      continue;
    }
    if (f.options && f.options.length && !f.options.includes(s)) { errors[f.name] = `Must be one of: ${f.options.join(", ")}.`; continue; }
    content[f.name] = s;
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, content };
}

/* ── classifying a result ────────────────────────────────────────────────── */

export type InputKind = "elicit-form" | "elicit-url" | "sampling" | "roots";

export interface InputRequest {
  key: string;
  method: string;
  kind: InputKind;
  params: Record<string, unknown>;
  message: string;
  /** elicit-form only. */
  fields?: ElicitField[];
  /** elicit-url only. */
  url?: string;
}

export type Classified =
  | { kind: "complete"; result: unknown }
  | { kind: "input_required"; requests: InputRequest[]; requestState?: string }
  | { kind: "invalid"; reason: string };

export function classifyResult(method: string, result: unknown, caps: ClientCaps): Classified {
  if (!isObj(result)) return { kind: "complete", result };
  const rt = result.resultType;
  if (rt === undefined || rt === "complete") return { kind: "complete", result };
  if (rt !== "input_required") return { kind: "invalid", reason: `Unrecognised resultType "${String(rt)}".` };
  if (!(MRTR_METHODS as readonly string[]).includes(method)) {
    return { kind: "invalid", reason: `${method} may not return input_required.` };
  }
  const hasReq = isObj(result.inputRequests);
  const state = result.requestState;
  if (state !== undefined && typeof state !== "string") return { kind: "invalid", reason: "requestState must be a string." };
  if (!hasReq && state === undefined) return { kind: "invalid", reason: "input_required carried neither inputRequests nor requestState." };

  const requests: InputRequest[] = [];
  if (hasReq) {
    for (const [key, raw] of Object.entries(result.inputRequests as Record<string, unknown>)) {
      if (!isObj(raw) || typeof raw.method !== "string") return { kind: "invalid", reason: `Input request "${key}" has no method.` };
      const params = isObj(raw.params) ? raw.params : {};
      const message = typeof params.message === "string" ? params.message : "";
      if (raw.method === "elicitation/create") {
        if (!caps.elicitation) return { kind: "invalid", reason: `Server asked for elicitation ("${key}") which this client did not declare.` };
        if (params.mode === "url") {
          const url = typeof params.url === "string" && /^https:\/\//i.test(params.url) ? params.url : undefined;
          if (!url) return { kind: "invalid", reason: `URL elicitation "${key}" must carry an https url.` };
          requests.push({ key, method: raw.method, kind: "elicit-url", params, message, url });
          continue;
        }
        const parsed = parseElicitSchema(params.requestedSchema);
        if (!parsed.ok) return { kind: "invalid", reason: `Elicitation "${key}": ${parsed.reason}` };
        requests.push({ key, method: raw.method, kind: "elicit-form", params, message, fields: parsed.fields });
      } else if (raw.method === "sampling/createMessage") {
        if (!caps.sampling) return { kind: "invalid", reason: `Server asked for sampling ("${key}") which this client did not declare.` };
        requests.push({ key, method: raw.method, kind: "sampling", params, message: samplingPreview(params) });
      } else if (raw.method === "roots/list") {
        if (!caps.roots) return { kind: "invalid", reason: `Server asked for roots ("${key}") which this client did not declare.` };
        requests.push({ key, method: raw.method, kind: "roots", params, message: "The server asks which roots it may see." });
      } else {
        return { kind: "invalid", reason: `Input request "${key}" uses unsupported method ${raw.method}.` };
      }
    }
  }
  return { kind: "input_required", requests, ...(state !== undefined ? { requestState: state } : {}) };
}

/* ── sampling ────────────────────────────────────────────────────────────── */

function contentText(c: unknown): string {
  if (Array.isArray(c)) return c.map(contentText).filter(Boolean).join("\n");
  if (isObj(c) && c.type === "text" && typeof c.text === "string") return c.text;
  if (isObj(c) && typeof c.type === "string") return `[${c.type}]`;
  return "";
}

/** A sampling request as a chat call. Only text parts are carried. */
export function samplingToChat(params: Record<string, unknown>): {
  system?: string; messages: Array<{ role: "user" | "assistant"; content: string }>; maxTokens: number;
} {
  const msgs = Array.isArray(params.messages) ? params.messages : [];
  const messages = msgs
    .filter(isObj)
    .map((m) => ({ role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant", content: contentText(m.content) }))
    .filter((m) => m.content);
  const mt = typeof params.maxTokens === "number" && params.maxTokens > 0 ? Math.min(Math.floor(params.maxTokens), 8192) : 1024;
  return { ...(typeof params.systemPrompt === "string" && params.systemPrompt ? { system: params.systemPrompt } : {}), messages, maxTokens: mt };
}

export function samplingPreview(params: Record<string, unknown>): string {
  const chat = samplingToChat(params);
  const last = chat.messages[chat.messages.length - 1];
  return last ? last.content.slice(0, 400) : "(empty sampling request)";
}

export function samplingResult(text: string, model: string, truncated = false): Record<string, unknown> {
  return { role: "assistant", content: { type: "text", text }, model, stopReason: truncated ? "maxTokens" : "endTurn" };
}

export const elicitAccept = (content: Record<string, unknown>) => ({ action: "accept", content });
export const elicitDecline = () => ({ action: "decline" });
export const elicitCancel = () => ({ action: "cancel" });
export const rootsResult = (roots: Array<{ uri: string; name?: string }>) => ({ roots });

/* ── the retry ───────────────────────────────────────────────────────────── */

/**
 * The retry's params: the original params (minus any previous round's MRTR
 * fields), plus inputResponses when there are any, plus requestState only when
 * the server sent one — echoed exactly.
 */
export function buildRetryParams(
  original: Record<string, unknown>,
  responses: Record<string, unknown>,
  requestState: string | undefined,
): Record<string, unknown> {
  const { inputResponses: _a, requestState: _b, ...base } = original;
  void _a; void _b;
  const out: Record<string, unknown> = { ...base };
  if (Object.keys(responses).length) out.inputResponses = responses;
  if (requestState !== undefined) out.requestState = requestState;
  return out;
}

/** Keys the server asked for that the responses do not answer. */
export function unanswered(requests: InputRequest[], responses: Record<string, unknown>): string[] {
  return requests.filter((r) => !(r.key in responses)).map((r) => r.key);
}

/* ── the loop ────────────────────────────────────────────────────────────── */

export type MrtrOutcome =
  | { status: "complete"; result: unknown; rounds: number }
  | { status: "cancelled"; rounds: number }
  | { status: "invalid"; reason: string; rounds: number }
  | { status: "exhausted"; rounds: number };

/**
 * Drive one request to completion.
 *
 * `send(params, round)` performs one JSON-RPC call (the caller mints a fresh id
 * each time) and returns its `result`. `resolve(requests, round)` gathers the
 * answers — from the user, a model, or the OS — and returns them keyed by the
 * server's keys, or null to abandon the request.
 */
export async function runMrtr(
  method: string,
  params: Record<string, unknown>,
  send: (params: Record<string, unknown>, round: number) => Promise<unknown>,
  resolve: (requests: InputRequest[], round: number) => Promise<Record<string, unknown> | null>,
  opts: { caps: ClientCaps; maxRounds?: number },
): Promise<MrtrOutcome> {
  const max = Math.max(1, opts.maxRounds ?? DEFAULT_MAX_ROUNDS);
  let current = params;
  for (let round = 1; round <= max; round++) {
    const result = await send(current, round);
    const c = classifyResult(method, result, opts.caps);
    if (c.kind === "complete") return { status: "complete", result: c.result, rounds: round };
    if (c.kind === "invalid") return { status: "invalid", reason: c.reason, rounds: round };
    if (round === max) return { status: "exhausted", rounds: round };
    let responses: Record<string, unknown> = {};
    if (c.requests.length) {
      const got = await resolve(c.requests, round);
      if (!got) return { status: "cancelled", rounds: round };
      responses = got;
    }
    current = buildRetryParams(params, responses, c.requestState);
  }
  return { status: "exhausted", rounds: max };
}

/* ── response parsing ────────────────────────────────────────────────────── */

/**
 * The JSON-RPC response in a body that is either JSON or an SSE stream. From a
 * stream, the LAST data frame carrying result or error wins (progress
 * notifications come first).
 */
export function parseRpcBody(contentType: string, raw: string): { result?: unknown; error?: { code: number; message: string } } | null {
  if (contentType.includes("text/event-stream")) {
    type Rpc = { result?: unknown; error?: { code: number; message: string } };
    let found: Rpc | null = null;
    for (const frame of raw.split(/\r?\n\r?\n/)) {
      const data = frame.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (!data) continue;
      try {
        const evt = JSON.parse(data) as Record<string, unknown>;
        if ("result" in evt || "error" in evt) found = evt as Rpc;
      } catch { /* non-JSON frame */ }
    }
    return found;
  }
  if (!raw.trim()) return null;
  try { return JSON.parse(raw) as { result?: unknown; error?: { code: number; message: string } }; } catch { return null; }
}

/** Flatten tool-call content blocks to text, as the rest of the client does. */
export function toolResultText(result: unknown): { ok: boolean; text: string } {
  if (!isObj(result)) return { ok: true, text: "(no output)" };
  const text = (Array.isArray(result.content) ? result.content : [])
    .map((c) => (isObj(c) && c.type === "text" && typeof c.text === "string" ? c.text : isObj(c) ? `[${String(c.type)}]` : ""))
    .join("\n")
    .trim();
  return { ok: result.isError !== true, text: text || "(no output)" };
}
