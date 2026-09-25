/**
 * dsh-lite turn/step loop. Re-implemented after DeepSeek Harness's
 * docs/architecture.md "Turn flow" (NOT vendored; upstream's agent-loop is
 * bound to Cordis and node:*).
 *
 *   turn/start
 *     agent/pre-step (waterfall)   reject -> turn/end{rejected}, no step
 *     step/start
 *     system/message (only when it changed), user/message (first step only)
 *     derive history FROM THE LOG, then agent/request (waterfall) -> model
 *     assistant/message | assistant/attempt
 *     tool/call* -> tools/pre-execute -> tools/execute -> tools/post-execute -> tool/result*
 *     step/end; tools owe another request -> next step
 *   agent/turn-stopping (serial)
 *   turn/end
 *
 * The model is injected, so this runs with a scripted fake in tests. Pure.
 */

import type { ToolCall, ToolSpec } from "../ai-transport";
import { parseToolArgs } from "../ai-transport";
import type { DshContext } from "./context";
import { deriveMessages, type DshLog } from "./session";

export type ToolRisk = "read" | "write" | "destructive";

export interface DshToolResult { content: string; isError?: boolean }

export interface DshTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  risk: ToolRisk;
  run(args: Record<string, unknown>, env: { signal?: AbortSignal; callId: string }): Promise<string | DshToolResult>;
}

export interface ModelRequest { system: string; messages: ReturnType<typeof deriveMessages>["messages"]; tools: ToolSpec[]; signal?: AbortSignal; /** The log this request was derived from, for plugins that must log (compaction). */ log?: DshLog }
export interface ModelReply {
  text: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
  usage?: { inputTokens: number; outputTokens: number };
  costUsd?: number;
  model?: string;
}
export type ModelFn = (req: ModelRequest, stream?: { onDelta?: (d: string) => void; onReasoning?: (d: string) => void }) => Promise<ModelReply>;

/** Payloads of the waterfalls a plugin can intercept. */
export interface PreStepPayload { input: string; reject?: string }
export interface ToolPipelinePayload {
  call: ToolCall;
  tool?: DshTool;
  args?: Record<string, unknown>;
  /** Set by a pre-execute listener to stop the call with this error. */
  block?: string;
  approval?: "auto" | "approved" | "denied";
}

export class DshCancelled extends Error {
  constructor() { super("cancelled"); this.name = "DshCancelled"; }
}

export interface TurnDeps {
  ctx: DshContext;
  log: DshLog;
  model: ModelFn;
  tools: () => DshTool[];
  system: () => string;
  clock: () => number;
  maxSteps?: number;
  signal?: AbortSignal;
  /** Live stream hooks for the UI. Not durable: the log gets the settled message. */
  onDelta?: (d: string) => void;
  onReasoning?: (d: string) => void;
  /** Model retries after a thrown error, recorded as assistant/attempt. */
  retries?: number;
}

export interface TurnResult { reason: "done" | "max-steps" | "cancelled" | "error" | "rejected"; steps: number; text: string; error?: string }

const check = (signal?: AbortSignal) => { if (signal?.aborted) throw new DshCancelled(); };

export async function runTurn(input: string, d: TurnDeps): Promise<TurnResult> {
  const { ctx, log } = d;
  const maxSteps = d.maxSteps ?? 12;
  log.append("turn/start", { input });
  const pre = await ctx.run<PreStepPayload, PreStepPayload>("agent/pre-step", { input }, async (p) => p);
  if (pre.reject !== undefined || !pre.input.trim()) {
    log.append("turn/end", { reason: "rejected", ...(pre.reject ? { error: pre.reject } : {}) });
    return { reason: "rejected", steps: 0, text: "", ...(pre.reject ? { error: pre.reject } : {}) };
  }
  let step = 0;
  let lastText = "";
  let pending: Array<{ id: string; name: string; args: string }> = [];
  const end = (reason: TurnResult["reason"], error?: string): TurnResult => {
    log.append("turn/end", { reason, ...(error ? { error } : {}) });
    return { reason, steps: step, text: lastText, ...(error ? { error } : {}) };
  };
  try {
    while (true) {
      check(d.signal);
      if (step >= maxSteps) { await ctx.emit("agent/turn-stopping", { reason: "max-steps" }); return end("max-steps"); }
      log.append("step/start", { step });
      const sys = d.system();
      if ((log.last("system/message")?.data.text ?? null) !== sys) log.append("system/message", { text: sys });
      if (step === 0) log.append("user/message", { text: pre.input });
      const derived = deriveMessages(log.events);
      const tools = d.tools();
      const specs: ToolSpec[] = tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));

      let reply: ModelReply | null = null;
      for (let attempt = 0; attempt <= (d.retries ?? 1); attempt++) {
        check(d.signal);
        try {
          reply = await ctx.run<ModelRequest, ModelReply>(
            "agent/request",
            { system: derived.system, messages: derived.messages, tools: specs, signal: d.signal, log },
            (req) => d.model(req, { onDelta: d.onDelta, onReasoning: d.onReasoning }),
          );
          break;
        } catch (e) {
          if (d.signal?.aborted) throw new DshCancelled();
          const msg = e instanceof Error ? e.message : String(e);
          log.append("assistant/attempt", { text: "", reason: attempt < (d.retries ?? 1) ? "retried" : "error", error: msg });
          if (attempt >= (d.retries ?? 1)) { log.append("step/end", { step, toolCalls: 0 }); return end("error", msg); }
        }
      }
      check(d.signal);
      const r = reply!;
      lastText = r.text;
      log.append("assistant/message", {
        text: r.text,
        ...(r.reasoning ? { reasoning: r.reasoning } : {}),
        ...(r.toolCalls?.length ? { toolCalls: r.toolCalls } : {}),
        ...(r.usage ? { usage: r.usage } : {}),
        ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
        ...(r.model ? { model: r.model } : {}),
      });
      const calls = r.toolCalls ?? [];
      pending = [...calls];
      for (const call of calls) {
        check(d.signal);
        log.append("tool/call", { callId: call.id, name: call.name, args: call.args });
        const started = d.clock();
        const res = await runToolPipeline(ctx, call, tools, d.signal);
        pending = pending.filter((c) => c.id !== call.id);
        log.append("tool/result", { callId: call.id, name: call.name, content: res.content, isError: !!res.isError, ms: Math.max(0, d.clock() - started), ...(res.approval ? { approval: res.approval } : {}) });
      }
      log.append("step/end", { step, toolCalls: calls.length });
      step++;
      if (!calls.length) {
        await ctx.emit("agent/turn-stopping", { reason: "done" });
        return end("done");
      }
    }
  } catch (e) {
    // Every call the model made must be answered, or providers reject the
    // whole session from the next request on ("tool_use ids without
    // tool_result"). Unanswered calls get an explicit cancelled result.
    for (const call of pending) {
      if (!log.events.some((x) => x.type === "tool/call" && x.data.callId === call.id)) log.append("tool/call", { callId: call.id, name: call.name, args: call.args });
      log.append("tool/result", { callId: call.id, name: call.name, content: e instanceof DshCancelled ? "Cancelled before it finished." : `Not run: ${e instanceof Error ? e.message : String(e)}`, isError: true, ms: 0 });
    }
    if (e instanceof DshCancelled) {
      log.append("assistant/attempt", { text: "", reason: "cancelled" });
      return end("cancelled");
    }
    return end("error", e instanceof Error ? e.message : String(e));
  }
}

/** tools/pre-execute -> tools/execute -> tools/post-execute. Unknown tools and
 *  bad JSON become error results the model can read and correct. */
export async function runToolPipeline(ctx: DshContext, call: ToolCall, tools: DshTool[], signal?: AbortSignal): Promise<DshToolResult & { approval?: ToolPipelinePayload["approval"] }> {
  const tool = tools.find((t) => t.name === call.name);
  if (!tool) return { content: `Unknown tool "${call.name}". Available: ${tools.map((t) => t.name).join(", ")}`, isError: true };
  const parsed = parseToolArgs(call.args);
  if (!parsed.ok) return { content: `Tool "${call.name}": ${parsed.error}`, isError: true };
  const pre = await ctx.run<ToolPipelinePayload, ToolPipelinePayload>("tools/pre-execute", { call, tool, args: parsed.value }, async (p) => p);
  if (pre.block !== undefined) return { content: pre.block, isError: true, ...(pre.approval ? { approval: pre.approval } : {}) };
  const exec = await ctx.run<ToolPipelinePayload, DshToolResult>("tools/execute", pre, async (p) => {
    try {
      const out = await p.tool!.run(p.args ?? {}, { signal, callId: call.id });
      return typeof out === "string" ? { content: out } : out;
    } catch (e) {
      return { content: `Tool "${call.name}" failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
    }
  });
  const post = await ctx.run<{ call: ToolCall; result: DshToolResult }, { call: ToolCall; result: DshToolResult }>("tools/post-execute", { call, result: exec }, async (p) => p);
  return { ...post.result, ...(pre.approval ? { approval: pre.approval } : {}) };
}

/* ── JSON tool protocol fallback ──────────────────────────────────────────
   For a model without native tool calling: the tools are described in the
   system prompt, the model answers with {"tool","args"} or {"final"}, and the
   tool-shaped history is flattened to plain turns such a model can read. */

export function jsonProtocolSystem(system: string, tools: ToolSpec[]): string {
  return [
    system,
    "",
    "TOOL PROTOCOL: reply with EXACTLY ONE JSON object and nothing else. Either call one tool:",
    '{"tool": "<name>", "args": { ... }}',
    'or finish: {"final": "<answer for the user>"}',
    "Tools (name: description; JSON Schema of args):",
    ...tools.map((t) => `- ${t.name}: ${t.description}; ${JSON.stringify(t.parameters)}`),
  ].join("\n");
}

export function flattenForJsonProtocol(messages: ModelRequest["messages"]): ModelRequest["messages"] {
  return messages.map((m) => {
    if (m.role === "tool") return { role: "user" as const, content: `Tool result (${m.toolName ?? "tool"}):\n${typeof m.content === "string" ? m.content : ""}` };
    if (m.role === "assistant" && m.toolCalls?.length) {
      const c = m.toolCalls[0];
      return { role: "assistant" as const, content: JSON.stringify({ tool: c.name, args: parseToolArgs(c.args).ok ? JSON.parse(c.args || "{}") : {} }) };
    }
    return m;
  });
}

/** First balanced {...} in a reply, respecting strings. */
function firstJsonObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

/** Read a JSON-protocol reply into the same shape a native reply has. Prose
 *  with no JSON is a final answer; `callId` comes from the caller (no clock). */
export function parseJsonProtocolReply(text: string, callId: string): Pick<ModelReply, "text" | "toolCalls"> {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const cand = firstJsonObject(fenced ? fenced[1] : text);
  if (!cand) return { text: text.trim() };
  try {
    const o = JSON.parse(cand) as { tool?: unknown; args?: unknown; final?: unknown };
    if (typeof o.final === "string") return { text: o.final };
    if (typeof o.tool === "string") return { text: "", toolCalls: [{ id: callId, name: o.tool, args: JSON.stringify(o.args ?? {}) }] };
  } catch { /* fall through */ }
  return { text: text.trim() };
}
