"use client";

import { useState } from "react";
import type { McpServer } from "@/lib/mcp";
import { buildRequest, isStateless, type ProtocolVersion } from "@/lib/mcp-wire";
import {
  specMeta, parseRpcBody, samplingToChat, samplingResult, coerceElicit, elicitAccept, elicitDecline, elicitCancel, rootsResult,
  type ClientCaps, type InputRequest,
} from "@/lib/mcp-mrtr";
import { ask } from "@/lib/useAI";
import { useSettings } from "@/kernel/settings";
import { Icon } from "@/shell/icons";

/* ────────────────────────────────────────────────────────────────────────────
   MCP Hub's MRTR transport and the panel that answers a server's questions.

   The decisions live in lib/mcp-mrtr.ts (pure, tested). This file does the
   two things that cannot be pure: one JSON-RPC round trip over fetch, and a
   form a person fills in. Every answer is the user's: a sampling request is
   never sent to a model without a click, and roots are never shared silently.
   ──────────────────────────────────────────────────────────────────────────── */

export const MRTR_CAPS: ClientCaps = { elicitation: true, sampling: true, roots: true };
const CLIENT = { name: "Web-AIOS", version: "2.0.0" };

const isLocal = (url: string) => {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]" || h.endsWith(".local");
  } catch { return false; }
};

let rpcSeq = 1;

/**
 * One JSON-RPC call that returns the raw `result` (so an input_required
 * result is visible to the caller) and mints a NEW id every time, which the
 * spec requires of a retry. On a 2026-07-28 server the request carries the
 * spec's `_meta` keys, including the capabilities that permit a server to ask.
 */
export async function rpcRaw(
  server: McpServer, method: string, params: Record<string, unknown>, sessionId: string | undefined,
  protocol: ProtocolVersion, signal?: AbortSignal,
): Promise<unknown> {
  const id = rpcSeq++;
  const wire = buildRequest(method, params, { protocol, client: CLIENT, sessionId, token: server.token, id });
  let body = wire.body;
  if (isStateless(protocol)) {
    const parsed = JSON.parse(body) as { params?: Record<string, unknown> };
    const p = parsed.params ?? {};
    const meta = (p._meta && typeof p._meta === "object" ? p._meta : {}) as Record<string, unknown>;
    parsed.params = { ...p, _meta: { ...meta, ...specMeta(protocol, CLIENT, MRTR_CAPS) } };
    body = JSON.stringify(parsed);
  }
  const relay = server.viaRelay && !isLocal(server.url);
  const res = relay
    ? await fetch("/api/mcp", { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ url: server.url, headers: wire.headers, body }) })
    : await fetch(server.url, { method: "POST", headers: wire.headers, body, signal });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 300)}` : ""}`);
  }
  const payload = parseRpcBody(res.headers.get("content-type") ?? "", await res.text());
  if (!payload) throw new Error("The server returned no JSON-RPC response.");
  if (payload.error) throw new Error(`${payload.error.message} (code ${payload.error.code})`);
  return payload.result;
}

export interface PendingInput {
  requests: InputRequest[];
  round: number;
}

/** The form for one round of server questions. `onDone(null)` abandons the call. */
export function MrtrPanel({ pending, serverName, onDone }: {
  pending: PendingInput;
  serverName: string;
  onDone: (responses: Record<string, unknown> | null) => void;
}) {
  const [values, setValues] = useState<Record<string, Record<string, string | boolean>>>({});
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, Record<string, string>>>({});
  const [sampling, setSampling] = useState<Record<string, { busy: boolean; text?: string; error?: string }>>({});
  const model = useSettings((s) => s.ai.model);

  const set = (key: string, name: string, v: string | boolean) =>
    setValues((all) => ({ ...all, [key]: { ...(all[key] ?? {}), [name]: v } }));

  const answer = (key: string, value: unknown) => setAnswers((a) => ({ ...a, [key]: value }));

  const acceptForm = (r: InputRequest) => {
    const c = coerceElicit(r.fields ?? [], values[r.key] ?? {});
    if (!c.ok) { setErrors((e) => ({ ...e, [r.key]: c.errors })); return; }
    setErrors((e) => ({ ...e, [r.key]: {} }));
    answer(r.key, elicitAccept(c.content));
  };

  const runSampling = async (r: InputRequest) => {
    setSampling((s) => ({ ...s, [r.key]: { busy: true } }));
    try {
      const chat = samplingToChat(r.params);
      if (!chat.messages.length) throw new Error("The request has no text messages to answer.");
      const res = await ask({ messages: chat.messages, ...(chat.system ? { system: chat.system } : {}), maxTokens: chat.maxTokens, persona: false });
      setSampling((s) => ({ ...s, [r.key]: { busy: false, text: res.text } }));
      answer(r.key, samplingResult(res.text, model, res.finish === "length"));
    } catch (e) {
      setSampling((s) => ({ ...s, [r.key]: { busy: false, error: e instanceof Error ? e.message : "Model call failed." } }));
    }
  };

  const answeredAll = pending.requests.every((r) => r.key in answers);

  return (
    <div className="os-card mt-2.5 !p-2.5" style={{ borderColor: "var(--accent)" }} role="region" aria-label="Server needs input">
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        <Icon name="info" size={13} />
        <span className="text-[11.5px] font-medium">{serverName} needs input to finish this call</span>
        <span className="text-[10px] text-[var(--muted)]">round {pending.round} · {Object.keys(answers).length}/{pending.requests.length} answered</span>
      </div>
      <p className="mb-2 text-[10.5px] leading-snug text-[var(--muted)]">
        MCP 2026-07-28 multi round-trip request: the server returned <code>input_required</code>. Your answers are sent back
        with a retry of the same call. Nothing is answered for you.
      </p>
      <div className="space-y-2">
        {pending.requests.map((r) => {
          const done = r.key in answers;
          return (
            <div key={r.key} className="rounded border border-[var(--border)] p-2">
              <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className="os-chip !text-[10px]">{r.kind === "sampling" ? "model request" : r.kind === "roots" ? "roots" : "question"}</span>
                <span className="font-mono text-[10px] text-[var(--muted)]">{r.key}</span>
                {done && <span className="flex items-center gap-0.5 text-[10px]" style={{ color: "var(--ok)" }}><Icon name="check" size={10} /> answered</span>}
              </div>
              {r.message && <p className="mb-1.5 whitespace-pre-wrap text-[11.5px]">{r.message}</p>}

              {r.kind === "elicit-form" && (
                <>
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {(r.fields ?? []).map((f) => (
                      <label key={f.name} className="block">
                        <span className="os-label mb-0.5 block">{f.title ?? f.name}{f.required && <span className="ml-1 text-[var(--accent)]">required</span>}</span>
                        {f.type === "boolean" ? (
                          <input type="checkbox" checked={Boolean(values[r.key]?.[f.name] ?? f.default)} onChange={(e) => set(r.key, f.name, e.target.checked)} disabled={done} />
                        ) : f.options && f.options.length ? (
                          <select className="os-input w-full text-[11.5px]" value={String(values[r.key]?.[f.name] ?? f.default ?? "")} onChange={(e) => set(r.key, f.name, e.target.value)} disabled={done}>
                            <option value="">Choose…</option>
                            {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                          </select>
                        ) : (
                          <input
                            className="os-input w-full text-[11.5px]"
                            inputMode={f.type === "string" ? undefined : "decimal"}
                            placeholder={f.description ?? f.type}
                            value={String(values[r.key]?.[f.name] ?? (f.default ?? ""))}
                            onChange={(e) => set(r.key, f.name, e.target.value)}
                            disabled={done}
                            style={{ fontSize: 16 }}
                          />
                        )}
                        {errors[r.key]?.[f.name] && <span className="text-[10px] text-[var(--danger)]">{errors[r.key][f.name]}</span>}
                      </label>
                    ))}
                  </div>
                  {!done && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      <button className="os-btn !py-0.5 text-[11px]" data-variant="primary" onClick={() => acceptForm(r)}>Submit</button>
                      <button className="os-btn !py-0.5 text-[11px]" onClick={() => answer(r.key, elicitDecline())}>Decline</button>
                      <button className="os-btn !py-0.5 text-[11px]" onClick={() => answer(r.key, elicitCancel())}>Dismiss</button>
                    </div>
                  )}
                </>
              )}

              {r.kind === "elicit-url" && r.url && !done && (
                <div className="flex flex-wrap items-center gap-1">
                  <a className="os-btn !py-0.5 text-[11px]" href={r.url} target="_blank" rel="noopener noreferrer"><Icon name="external" size={11} /> Open {new URL(r.url).hostname}</a>
                  <button className="os-btn !py-0.5 text-[11px]" data-variant="primary" onClick={() => answer(r.key, elicitAccept({}))}>I have done it</button>
                  <button className="os-btn !py-0.5 text-[11px]" onClick={() => answer(r.key, elicitDecline())}>Decline</button>
                </div>
              )}

              {r.kind === "sampling" && (
                <div>
                  {sampling[r.key]?.text && <pre className="mb-1 max-h-40 overflow-auto whitespace-pre-wrap text-[11px]">{sampling[r.key]!.text}</pre>}
                  {sampling[r.key]?.error && <p className="mb-1 text-[11px] text-[var(--danger)]">{sampling[r.key]!.error}</p>}
                  {!done && (
                    <button className="os-btn !py-0.5 text-[11px]" onClick={() => void runSampling(r)} disabled={sampling[r.key]?.busy}>
                      <Icon name="spark" size={11} /> {sampling[r.key]?.busy ? "Asking your model…" : `Answer with ${model}`}
                    </button>
                  )}
                  <p className="mt-1 text-[10px] text-[var(--muted)]">Uses your own model and budget. To refuse, cancel the call below.</p>
                </div>
              )}

              {r.kind === "roots" && !done && (
                <div className="flex flex-wrap items-center gap-1">
                  <button className="os-btn !py-0.5 text-[11px]" onClick={() => answer(r.key, rootsResult([]))}>Share no roots</button>
                  <span className="text-[10px] text-[var(--muted)]">This OS&apos;s files live in the browser and have no file:// roots to offer.</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button className="os-btn !py-1 text-[11px]" data-variant="primary" disabled={!answeredAll} onClick={() => onDone(answers)}>
          <Icon name="play" size={11} /> Send answers and retry
        </button>
        <button className="os-btn !py-1 text-[11px]" onClick={() => onDone(null)}>Cancel the call</button>
      </div>
    </div>
  );
}
