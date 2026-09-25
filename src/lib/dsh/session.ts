/**
 * dsh-lite session log. Re-implemented (not vendored) after DeepSeek Harness's
 * core/session: an append-only list of durable events from which the model's
 * history is *derived*. "Model-visible means logged": nothing reaches a model
 * request unless an event below put it there, so resume, fork and the
 * inspector all read the same truth.
 *
 * Event type names match upstream's durable types (turn/start, step/start,
 * system/message, user/message, assistant/message, assistant/attempt,
 * tool/call, tool/result, step/end, turn/end). goal/*, compaction/* and
 * note are dsh-lite additions, kept in the same log for the same reason.
 *
 * Pure: time comes from the caller.
 */

import type { ChatMessage, ToolCall } from "../ai-transport";

export interface DshEventMap {
  "turn/start": { input: string };
  "step/start": { step: number };
  "system/message": { text: string };
  "user/message": { text: string };
  "assistant/message": { text: string; reasoning?: string; toolCalls?: ToolCall[]; usage?: { inputTokens: number; outputTokens: number }; costUsd?: number; model?: string };
  /** A settled attempt that did NOT become history: error, cancellation, retry. */
  "assistant/attempt": { text: string; reason: "error" | "cancelled" | "retried"; error?: string };
  "tool/call": { callId: string; name: string; args: string };
  "tool/result": { callId: string; name: string; content: string; isError: boolean; ms: number; approval?: "auto" | "approved" | "denied" };
  "step/end": { step: number; toolCalls: number };
  "turn/end": { reason: "done" | "max-steps" | "cancelled" | "error" | "rejected" | "interrupted"; error?: string };
  /** Replaces model history before `uptoSeq` with one summary message. */
  "compaction/summary": { uptoSeq: number; text: string; beforeTokens: number };
  /** Replaces the content of old tool results (pruned middles). */
  "compaction/prune": { replacements: Array<{ seq: number; content: string }>; savedChars: number };
  "goal/set": { objective: string; maxRounds: number };
  "goal/verdict": { round: number; met: boolean; evidence: string; note: string; judge: string };
  "goal/end": { status: "met" | "exhausted" | "cleared" | "cancelled" };
  /** Harness progress note: append-only, never model-visible. */
  note: { text: string };
}
export type DshEventType = keyof DshEventMap;
export type DshEvent<T extends DshEventType = DshEventType> = { [K in T]: { seq: number; time: number; type: K; data: DshEventMap[K] } }[T];

export interface DshSessionMeta {
  id: string;
  title: string;
  created: number;
  parent?: { session: string; turn: number };
  archived?: boolean;
  model?: { provider: string; model: string };
}

export class DshLog {
  private list: DshEvent[] = [];
  constructor(private clock: () => number, seed: readonly DshEvent[] = []) {
    for (const e of seed) this.list.push({ ...e, seq: this.list.length } as DshEvent);
  }
  append<T extends DshEventType>(type: T, data: DshEventMap[T]): DshEvent<T> {
    const e = { seq: this.list.length, time: this.clock(), type, data } as DshEvent<T>;
    this.list.push(e as DshEvent);
    return e;
  }
  get events(): readonly DshEvent[] { return this.list; }
  get length(): number { return this.list.length; }
  at(seq: number): DshEvent | undefined { return this.list[seq]; }
  last<T extends DshEventType>(type: T): DshEvent<T> | undefined {
    for (let i = this.list.length - 1; i >= 0; i--) if (this.list[i].type === type) return this.list[i] as DshEvent<T>;
    return undefined;
  }
}

/** Model history from the log. The system prompt is returned separately
 *  (the transport sends it as the system field). Attempts never appear. */
export function deriveMessages(events: readonly DshEvent[]): { system: string; messages: ChatMessage[] } {
  let system = "";
  const pruned = new Map<number, string>();
  let summaryUpTo = -1;
  let summary = "";
  for (const e of events) {
    if (e.type === "compaction/prune") for (const r of e.data.replacements) pruned.set(r.seq, r.content);
    if (e.type === "compaction/summary") { summaryUpTo = e.data.uptoSeq; summary = e.data.text; }
  }
  const messages: ChatMessage[] = [];
  if (summaryUpTo >= 0) messages.push({ role: "user", content: `[Summary of the earlier conversation, written by the harness when history grew too long]\n${summary}` });
  for (const e of events) {
    if (e.type === "system/message") { system = e.data.text; continue; }
    if (e.seq < summaryUpTo) continue;
    switch (e.type) {
      case "user/message": messages.push({ role: "user", content: e.data.text }); break;
      case "assistant/message":
        messages.push({ role: "assistant", content: e.data.text, ...(e.data.toolCalls?.length ? { toolCalls: e.data.toolCalls } : {}) });
        break;
      case "tool/result":
        messages.push({ role: "tool", content: pruned.get(e.seq) ?? e.data.content, toolCallId: e.data.callId, toolName: e.data.name });
        break;
      default: break;
    }
  }
  return { system, messages };
}

/** Turn boundaries: [startSeq, endSeq] of each closed turn, in order. */
export function turnBounds(events: readonly DshEvent[]): Array<{ turn: number; start: number; end: number; input: string }> {
  const out: Array<{ turn: number; start: number; end: number; input: string }> = [];
  let open: { start: number; input: string } | null = null;
  for (const e of events) {
    if (e.type === "turn/start") open = { start: e.seq, input: e.data.input };
    if (e.type === "turn/end" && open) { out.push({ turn: out.length, start: open.start, end: e.seq, input: open.input }); open = null; }
  }
  return out;
}

/** Seed for a fork at the end of `turn` (0-based): every event up to and
 *  including that turn's turn/end. Forks happen only at turn boundaries. */
export function forkSeed(events: readonly DshEvent[], turn: number): DshEvent[] {
  const b = turnBounds(events)[turn];
  if (!b) throw new Error(`no closed turn ${turn} to fork at`);
  return events.slice(0, b.end + 1).map((e) => ({ ...e }) as DshEvent);
}

/** Close whatever a crash left open, the way upstream's repair.ts does:
 *  every tool/call without a result gets an "outcome unknown" error result,
 *  and an unclosed turn gets turn/end{interrupted}. Returns what to append. */
export function repairTail(events: readonly DshEvent[]): Array<{ type: DshEventType; data: DshEventMap[DshEventType] }> {
  const fixes: Array<{ type: DshEventType; data: DshEventMap[DshEventType] }> = [];
  let inTurn = false;
  const pending = new Map<string, string>();
  for (const e of events) {
    if (e.type === "turn/start") { inTurn = true; pending.clear(); }
    if (e.type === "tool/call") pending.set(e.data.callId, e.data.name);
    if (e.type === "tool/result") pending.delete(e.data.callId);
    if (e.type === "turn/end") inTurn = false;
  }
  if (!inTurn) return fixes;
  for (const [callId, name] of pending) {
    fixes.push({ type: "tool/result", data: { callId, name, content: "Tool outcome unknown: the session was interrupted while this call was running.", isError: true, ms: 0 } });
  }
  fixes.push({ type: "turn/end", data: { reason: "interrupted" } });
  return fixes;
}

export function toJsonl(meta: DshSessionMeta, events: readonly DshEvent[]): string {
  return [JSON.stringify({ header: "dsh-lite/1", ...meta }), ...events.map((e) => JSON.stringify(e))].join("\n") + "\n";
}

export function fromJsonl(text: string): { meta: DshSessionMeta; events: DshEvent[] } {
  const lines = text.split("\n").filter((l) => l.trim());
  if (!lines.length) throw new Error("empty session file");
  const head = JSON.parse(lines[0]) as DshSessionMeta & { header?: string };
  if (head.header !== "dsh-lite/1") throw new Error(`unknown session header ${String(head.header)}`);
  const { header: _h, ...meta } = head;
  void _h;
  const events = lines.slice(1).map((l) => JSON.parse(l) as DshEvent);
  events.forEach((e, i) => { if (e.seq !== i) throw new Error(`session file seq gap at line ${i + 2}`); });
  return { meta, events };
}
