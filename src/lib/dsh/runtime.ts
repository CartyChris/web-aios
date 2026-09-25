"use client";

/**
 * dsh-lite runtime: the impure half. Wires the pure core (context, session
 * log, loop, policy) to the OS: the model via ask() with native tools, the
 * VFS for sessions/skills/todos, the live-jobs kernel for approvals, AIOS
 * Chat's OS actions, and the vendored DeepSeek Harness code for schema
 * validation, token estimation, pruning budgets, compaction thresholds and
 * timestamps.
 *
 * Exposed for verification as window.__dsh (and window.__aios.dsh when that
 * surface exists).
 */

import { create } from "zustand";
import { ask } from "../useAI";
import { getProvider } from "../providers";
import { useVFS } from "@/kernel/vfs";
import { useJobs } from "@/kernel/jobs";
import { bus } from "@/kernel/bus";
import { useSettings } from "@/kernel/settings";
import { execTool } from "@/shell/AiosChat";
import { DshContext, type DshPlugin } from "./context";
import { DshLog, deriveMessages, forkSeed, repairTail, toJsonl, fromJsonl, turnBounds, type DshSessionMeta } from "./session";
import { runTurn, jsonProtocolSystem, flattenForJsonProtocol, parseJsonProtocolReply, type DshTool, type ModelFn, type TurnResult } from "./loop";
import { approvalPlugin, validationPlugin, compactionPlugin, skillsPlugin, runGoal, runRalph, parseVerdict, roundEvidence, type PermissionPreset, type GoalVerdict } from "./policy";
// Vendored DeepSeek Harness code (MIT, verbatim; see src/vendor/dsh/NOTICE.md).
import { validateJsonSchemaValue, assertSupportedJsonSchema } from "@/vendor/dsh/packages/core/tools/src/json-schema.ts";
import { estimateContent, ROLE_OVERHEAD } from "@/vendor/dsh/packages/llm/token-meter/src/estimate.ts";
import { DEFAULTS as PRUNE_DEFAULTS, PRUNE_MARKER } from "@/vendor/dsh/packages/compaction/compaction-tool-result-pruner/src/config.ts";
import { resolveConfig as resolveCompactionConfig } from "@/vendor/dsh/packages/compaction/compaction-basic/src/config.ts";
import { createTimestampFormatter, formatTimestamp } from "@/vendor/dsh/packages/context/time-context/src/timestamp.ts";

export const DSH_ROOT = "/dsh";
const SESSIONS_DIR = `${DSH_ROOT}/sessions`;
const SKILLS_DIR = `${DSH_ROOT}/skills`;
const APPROVAL_TIMEOUT_MS = 120_000;

/* ── UI state ─────────────────────────────────────────────────────────── */

export interface PendingApproval { callId: string; name: string; args: string; risk: string; jobId: string }
export interface PendingQuestion { callId: string; question: string }

interface DshUiState {
  version: number;
  sessions: DshSessionMeta[];
  activeId: string | null;
  running: boolean;
  streamText: string;
  streamReasoning: string;
  preset: PermissionPreset;
  toolMode: "native" | "json";
  provider: string;
  model: string;
  judgeProvider: string;
  judgeModel: string;
  approvals: PendingApproval[];
  questions: PendingQuestion[];
  goalStatus: string;
  set: (p: Partial<Omit<DshUiState, "set">>) => void;
}

export const useDsh = create<DshUiState>()((set) => ({
  version: 0,
  sessions: [],
  activeId: null,
  running: false,
  streamText: "",
  streamReasoning: "",
  preset: "auto-read",
  toolMode: "native",
  provider: "",
  model: "",
  judgeProvider: "",
  judgeModel: "",
  approvals: [],
  questions: [],
  goalStatus: "",
  set: (p) => set(p),
}));

const bump = () => useDsh.getState().set({ version: useDsh.getState().version + 1 });
const now = () => Date.now();
const rid = (p: string) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));

/* ── estimates (vendored token-meter heuristic) ───────────────────────── */

export function estimateTokens(system: string, messages: ReturnType<typeof deriveMessages>["messages"]): number {
  let n = system ? estimateContent([{ type: "text", text: system }]) + ROLE_OVERHEAD : 0;
  for (const m of messages) {
    const text = typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "")).join("");
    const calls = (m.toolCalls ?? []).map((c) => `${c.name}${c.args}`).join("");
    n += estimateContent([{ type: "text", text: text + calls }]) + ROLE_OVERHEAD;
  }
  return n;
}

function validate(schema: Record<string, unknown>, value: unknown): string[] {
  assertSupportedJsonSchema(schema);
  return validateJsonSchemaValue(schema, value, "args");
}

/* ── the runtime ──────────────────────────────────────────────────────── */

class DshRuntime {
  ctx = new DshContext();
  /** The UI store, exposed so window.__dsh can drive the app in verification. */
  readonly ui = useDsh;
  private logs = new Map<string, DshLog>();
  private meta = new Map<string, DshSessionMeta>();
  private abort: AbortController | null = null;
  private settles = new Map<string, (ok: boolean) => void>();
  private answers = new Map<string, (text: string | null) => void>();
  private tsFormatter = createTimestampFormatter();
  readonly compaction = resolveCompactionConfig({ thresholdRatio: 0.8 });
  private booted = false;

  boot(): void {
    if (this.booted) return;
    this.booted = true;
    const s = useSettings.getState();
    const ui = useDsh.getState();
    if (!ui.provider) ui.set({ provider: s.ai.provider, model: s.ai.model, judgeProvider: s.ai.provider, judgeModel: s.ai.model });
    for (const p of this.allPlugins()) this.ctx.plugin(p);
    this.loadSessions();
    this.ensureDefaultSkill();
  }

  /** Every plugin dsh-lite ships. Order = registration order. */
  allPlugins(): DshPlugin[] {
    return [
      { name: "session-log", description: "Append-only session event log, persisted as JSONL in /dsh/sessions.", required: true, apply: (c) => { c.provide("sessions", this); } },
      { name: "tool-registry", description: "Scoped tool registry: files, grep, run_js, web_fetch, OS actions, subagent, todo, ask_user.", required: true, apply: (c) => { c.provide("tools", () => this.tools()); } },
      validationPlugin(validate),
      approvalPlugin({ preset: () => useDsh.getState().preset, approve: (p) => this.requestApproval(p) }),
      compactionPlugin({
        log: () => this.activeLog(),
        prune: { thresholdChars: PRUNE_DEFAULTS.thresholdChars, headChars: PRUNE_DEFAULTS.headChars, tailChars: PRUNE_DEFAULTS.tailChars, keepRecent: 2, marker: PRUNE_MARKER },
        estimate: estimateTokens,
        window: () => 128_000,
        thresholdRatio: this.compaction.thresholdRatio,
        summarize: (tx) => this.summarize(tx),
      }),
      skillsPlugin(() => this.skills()),
      {
        name: "time-context",
        description: "Adds the current time to the system prompt (vendored dsh time-context formatter).",
        apply: (c) => {
          c.provide("time-context", () => formatTimestamp(now(), this.tsFormatter, Intl.DateTimeFormat().resolvedOptions().timeZone));
        },
      },
      {
        name: "stream-meter",
        description: "Counts assistant/request calls live (a serial agent/turn-stopping listener), shown in the meter.",
        apply: (c) => {
          c.provide("stream-meter", { turns: 0 });
          c.on("agent/turn-stopping", () => { const m = c.get<{ turns: number }>("stream-meter"); if (m) m.turns++; });
        },
      },
    ];
  }

  togglePlugin(name: string): void {
    if (this.ctx.isLoaded(name)) {
      const p = this.ctx.loaded().find((x) => x.name === name);
      if (p?.required) return;
      this.ctx.unload(name);
    } else {
      const p = this.allPlugins().find((x) => x.name === name);
      if (p) this.ctx.plugin(p);
    }
    bump();
  }

  /* sessions */

  private file(id: string) { return `${SESSIONS_DIR}/${id}.jsonl`; }

  private loadSessions(): void {
    const vfs = useVFS.getState();
    const metas: DshSessionMeta[] = [];
    for (const n of vfs.list(SESSIONS_DIR)) {
      if (n.kind !== "file" || !n.path.endsWith(".jsonl")) continue;
      try {
        const { meta, events } = fromJsonl(n.content);
        const log = new DshLog(now, events);
        // Resume reads the LOG: close whatever a reload interrupted.
        const fixes = repairTail(log.events);
        for (const f of fixes) log.append(f.type, f.data as never);
        this.logs.set(meta.id, log);
        this.meta.set(meta.id, meta);
        metas.push(meta);
        if (fixes.length) this.persist(meta.id);
      } catch { /* a corrupt file is skipped, never deleted */ }
    }
    metas.sort((a, b) => b.created - a.created);
    useDsh.getState().set({ sessions: metas, activeId: metas.find((m) => !m.archived)?.id ?? null });
  }

  persist(id: string): void {
    const log = this.logs.get(id);
    const meta = this.meta.get(id);
    if (!log || !meta) return;
    useVFS.getState().write(this.file(id), toJsonl(meta, log.events), { mime: "application/jsonl" });
  }

  private publish(): void {
    const metas = [...this.meta.values()].sort((a, b) => b.created - a.created);
    useDsh.getState().set({ sessions: metas });
    bump();
  }

  newSession(title = "New session", seed?: { events: DshLog["events"]; parent: DshSessionMeta["parent"] }): string {
    const id = rid("s");
    const ui = useDsh.getState();
    const meta: DshSessionMeta = { id, title, created: now(), ...(seed?.parent ? { parent: seed.parent } : {}), model: { provider: ui.provider, model: ui.model } };
    this.logs.set(id, new DshLog(now, seed?.events ?? []));
    this.meta.set(id, meta);
    this.persist(id);
    useDsh.getState().set({ activeId: id });
    this.publish();
    return id;
  }

  forkAt(id: string, turn: number): string {
    const log = this.logs.get(id);
    if (!log) throw new Error(`no session ${id}`);
    const src = this.meta.get(id)!;
    return this.newSession(`${src.title} (fork @${turn + 1})`, { events: forkSeed(log.events, turn), parent: { session: id, turn } });
  }

  /** Sessions are archived, never deleted (the file stays in /dsh/sessions). */
  archive(id: string, archived = true): void {
    const m = this.meta.get(id);
    if (!m) return;
    this.meta.set(id, { ...m, archived });
    this.persist(id);
    if (useDsh.getState().activeId === id && archived) useDsh.getState().set({ activeId: null });
    this.publish();
  }

  select(id: string): void { useDsh.getState().set({ activeId: id }); bump(); }
  log(id: string): DshLog | undefined { return this.logs.get(id); }
  metaOf(id: string): DshSessionMeta | undefined { return this.meta.get(id); }
  turns(id: string) { const l = this.logs.get(id); return l ? turnBounds(l.events) : []; }

  activeLog(): DshLog {
    let id = useDsh.getState().activeId;
    if (!id || !this.logs.has(id)) id = this.newSession();
    return this.logs.get(id)!;
  }

  /* skills + todos */

  skills(): Array<{ name: string; body: string }> {
    return useVFS.getState().list(SKILLS_DIR)
      .filter((n) => n.kind === "file" && n.path.endsWith(".md"))
      .map((n) => ({ name: n.path.split("/").pop()!.replace(/\.md$/, ""), body: n.content }));
  }

  private ensureDefaultSkill(): void {
    const vfs = useVFS.getState();
    if (vfs.read(`${SKILLS_DIR}/verify.md`)) return;
    vfs.write(`${SKILLS_DIR}/verify.md`, "After every file you write, read it back with read_file and quote the first line, so the harness can see the evidence.\n");
  }

  /* model */

  private system(): string {
    const time = this.ctx.get<() => string>("time-context");
    return [
      "You are DeepSeek Harness (dsh-lite), an agent running inside Web-AIOS, a web desktop.",
      "Use tools to act. Files live in a virtual file system rooted at /. Prefer small, verifiable steps.",
      "Never claim work is finished without tool evidence; the harness judges goals from tool results, not from your words.",
      time ? `Current time: ${time()}` : "",
    ].filter(Boolean).join("\n");
  }

  private modelFn(provider: string, model: string, onDelta?: (d: string) => void, onReasoning?: (d: string) => void): ModelFn {
    return async (req) => {
      const json = useDsh.getState().toolMode === "json";
      let full = "";
      const res = await ask({
        provider, model, persona: false, rescueEmpty: !json && req.tools.length === 0,
        system: json ? jsonProtocolSystem(req.system, req.tools) : req.system,
        messages: json ? flattenForJsonProtocol(req.messages) : req.messages,
        ...(json || !req.tools.length ? {} : { tools: req.tools }),
        signal: req.signal,
        onDelta: (d) => { full += d; onDelta?.(d); },
        onReasoning: (d) => onReasoning?.(d),
        trace: { role: "dsh", name: `dsh · ${model}` },
      });
      const base = { costUsd: res.costUsd, model, ...(res.reasoning ? { reasoning: res.reasoning } : {}) };
      if (json) return { ...base, ...parseJsonProtocolReply(res.text || full, rid("j")) };
      return { ...base, text: res.text, ...(res.toolCalls?.length ? { toolCalls: res.toolCalls } : {}) };
    };
  }

  private async summarize(transcript: string): Promise<string> {
    const ui = useDsh.getState();
    const r = await ask({
      provider: ui.provider, model: ui.model, persona: false,
      system: "Summarize this agent conversation for the agent itself: goals, decisions, files touched, open problems. Under 300 words.",
      messages: [{ role: "user", content: transcript.slice(-60_000) }],
    });
    return r.text || "(summary unavailable)";
  }

  async judge(objective: string, evidence: string): Promise<GoalVerdict> {
    const ui = useDsh.getState();
    const r = await ask({
      provider: ui.judgeProvider || ui.provider, model: ui.judgeModel || ui.model, persona: false, rescueEmpty: true,
      system: 'You are a strict judge separate from the agent. Decide ONLY from the evidence (tool results) whether the goal is met. A claim of completion with no supporting tool result is NOT met. Reply with one JSON object: {"met": true|false, "note": "<one sentence>"}.',
      messages: [{ role: "user", content: `GOAL: ${objective}\n\nEVIDENCE:\n${evidence}` }],
    });
    return parseVerdict(r.text);
  }

  /* approval, wired to the live-jobs kernel */

  private requestApproval(p: { callId: string; name: string; args: Record<string, unknown>; risk: string }): Promise<boolean> {
    return new Promise((resolve) => {
      const what = `${p.name}(${JSON.stringify(p.args).slice(0, 140)})`;
      const jobId = useJobs.getState().start({ title: "DeepSeek Harness needs your OK", detail: what, kind: "agent", status: "blocked", target: { appId: "deepseek-harness" } });
      let done = false;
      const settle = (ok: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.settles.delete(p.callId);
        useDsh.getState().set({ approvals: useDsh.getState().approvals.filter((a) => a.callId !== p.callId) });
        useJobs.getState().finish(jobId, "done", ok ? `Approved: ${what}` : `Denied: ${what}`);
        resolve(ok);
      };
      const timer = setTimeout(() => settle(false), APPROVAL_TIMEOUT_MS);
      this.settles.set(p.callId, settle);
      useJobs.getState().update(jobId, {
        actions: [
          { id: "approve", label: "Approve", run: () => settle(true) },
          { id: "deny", label: "Deny", run: () => settle(false) },
        ],
      });
      useDsh.getState().set({ approvals: [...useDsh.getState().approvals, { callId: p.callId, name: p.name, args: JSON.stringify(p.args), risk: p.risk, jobId }] });
      bus.emit("notify", { title: "DeepSeek Harness needs your OK", body: what, kind: "warn", jobId });
    });
  }

  settle(callId: string, ok: boolean): void { this.settles.get(callId)?.(ok); }
  answer(callId: string, text: string | null): void { this.answers.get(callId)?.(text); }

  /* tools */

  tools(): DshTool[] {
    const vfs = () => useVFS.getState();
    const os = (name: string) => async (args: Record<string, unknown>) => (await execTool(name, args)).text;
    return [
      { name: "read_file", risk: "read", description: "Read a text file from the virtual file system.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        run: async (a) => { const n = vfs().read(str(a.path)); if (!n) return { content: `No file at ${str(a.path)}`, isError: true }; if (n.kind === "dir") return { content: `${n.path} is a folder`, isError: true }; return n.content.slice(0, 20_000); } },
      { name: "write_file", risk: "write", description: "Create or overwrite a text file.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
        run: async (a) => { const n = vfs().write(str(a.path), str(a.content)); return `Wrote ${n.path} (${n.size} bytes).`; } },
      { name: "list_files", risk: "read", description: "List a folder.", parameters: { type: "object", properties: { dir: { type: "string" } } },
        run: async (a) => vfs().list(str(a.dir) || "/").slice(0, 200).map((n) => `${n.path}${n.kind === "dir" ? "/" : ` ${n.size}b`}`).join("\n") || "Empty." },
      { name: "grep", risk: "read", description: "Search file contents with a regular expression.", parameters: { type: "object", properties: { pattern: { type: "string" }, dir: { type: "string" } }, required: ["pattern"] },
        run: async (a) => {
          let re: RegExp;
          try { re = new RegExp(str(a.pattern), "i"); } catch (e) { return { content: `Bad pattern: ${(e as Error).message}`, isError: true }; }
          const root = str(a.dir) || "/";
          const hits: string[] = [];
          for (const n of Object.values(vfs().nodes)) {
            if (n.kind !== "file" || !n.path.startsWith(root)) continue;
            n.content.split("\n").forEach((line, i) => { if (hits.length < 100 && re.test(line)) hits.push(`${n.path}:${i + 1}: ${line.slice(0, 200)}`); });
          }
          return hits.join("\n") || "No matches.";
        } },
      { name: "run_js", risk: "write", description: "Run JavaScript in a sandboxed Web Worker (no DOM, no network, 5s timeout). The value of the last `return` is the result; console.log output is captured.", parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
        run: async (a) => runInWorker(str(a.code)) },
      { name: "web_fetch", risk: "read", description: "Fetch a public web page as plain text.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
        run: async (a) => {
          const r = await fetch(`/api/proxy?mode=text&url=${encodeURIComponent(str(a.url))}`);
          const j = (await r.json()) as { text?: string; title?: string; error?: string; status?: number };
          if (j.error) return { content: j.error, isError: true };
          return `${j.title ?? ""} (HTTP ${j.status})\n${(j.text ?? "").slice(0, 12_000)}`;
        } },
      { name: "read_os", risk: "read", description: "Summary of the desktop: open windows, apps, files.", parameters: { type: "object", properties: {} }, run: os("read_os") },
      { name: "list_apps", risk: "read", description: "Every app id you can open.", parameters: { type: "object", properties: {} }, run: os("list_apps") },
      { name: "open_app", risk: "read", description: "Open an app by id.", parameters: { type: "object", properties: { appId: { type: "string" } }, required: ["appId"] }, run: os("open_app") },
      { name: "close_window", risk: "destructive", description: "Close a window by id.", parameters: { type: "object", properties: { windowId: { type: "string" } }, required: ["windowId"] }, run: os("close_window") },
      { name: "set_theme", risk: "write", description: "Switch the desktop theme.", parameters: { type: "object", properties: { themeId: { type: "string" } }, required: ["themeId"] }, run: os("set_theme") },
      { name: "notify", risk: "read", description: "Show the user a notification.", parameters: { type: "object", properties: { title: { type: "string" }, body: { type: "string" } }, required: ["title"] }, run: os("notify") },
      { name: "todo_write", risk: "read", description: "Replace this session's todo list. Items: [{text, done}].", parameters: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { text: { type: "string" }, done: { type: "boolean" } }, required: ["text"] } } }, required: ["items"] },
        run: async (a) => {
          const items = (a.items as Array<{ text: string; done?: boolean }>) ?? [];
          const id = useDsh.getState().activeId ?? "none";
          vfs().write(`${DSH_ROOT}/todos/${id}.json`, JSON.stringify(items, null, 2));
          return items.map((i) => `[${i.done ? "x" : " "}] ${i.text}`).join("\n") || "(empty)";
        } },
      { name: "spawn_subagent", risk: "read", description: "Run a task in a child session (a fork of this one at its last finished turn when fork=true, else fresh) and return its final answer.", parameters: { type: "object", properties: { task: { type: "string" }, fork: { type: "boolean" } }, required: ["task"] },
        run: async (a, env) => this.subagent(str(a.task), a.fork === true, env.signal) },
      { name: "ask_user", risk: "read", description: "Ask the user a question and wait for the typed answer.", parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
        run: async (a, env) => {
          const q = { callId: env.callId, question: str(a.question) };
          useDsh.getState().set({ questions: [...useDsh.getState().questions, q] });
          const jobId = useJobs.getState().start({ title: "DeepSeek Harness asks", detail: q.question, kind: "agent", status: "blocked", target: { appId: "deepseek-harness" } });
          bus.emit("notify", { title: "DeepSeek Harness asks", body: q.question, kind: "info", jobId });
          const text = await new Promise<string | null>((resolve) => {
            const t = setTimeout(() => resolve(null), APPROVAL_TIMEOUT_MS);
            this.answers.set(env.callId, (v) => { clearTimeout(t); resolve(v); });
          });
          this.answers.delete(env.callId);
          useJobs.getState().finish(jobId, "done");
          useDsh.getState().set({ questions: useDsh.getState().questions.filter((x) => x.callId !== env.callId) });
          return text === null ? { content: "The user did not answer.", isError: true } : `User answered: ${text}`;
        } },
    ];
  }

  private async subagent(task: string, fork: boolean, signal?: AbortSignal): Promise<string> {
    const parentId = useDsh.getState().activeId;
    const parentLog = parentId ? this.logs.get(parentId) : undefined;
    const turns = parentLog ? turnBounds(parentLog.events) : [];
    const id = rid("s");
    const events = fork && parentLog && turns.length ? forkSeed(parentLog.events, turns.length - 1) : [];
    const log = new DshLog(now, events);
    const ui = useDsh.getState();
    this.logs.set(id, log);
    this.meta.set(id, { id, title: `subagent: ${task.slice(0, 40)}`, created: now(), ...(parentId ? { parent: { session: parentId, turn: Math.max(0, turns.length - 1) } } : {}), model: { provider: ui.provider, model: ui.model } });
    const r = await runTurn(task, {
      ctx: this.ctx, log, model: this.modelFn(ui.provider, ui.model),
      tools: () => this.tools().filter((t) => t.name !== "spawn_subagent"), // no recursive fan-out
      system: () => `${this.system()}\nYou are a subagent. Do the task and reply with the result only.`,
      clock: now, maxSteps: 8, signal,
    });
    this.persist(id);
    this.publish();
    return `[subagent session ${id}: ${r.reason}] ${r.text || r.error || ""}`;
  }

  /* running */

  private deps(log: DshLog, signal: AbortSignal) {
    const ui = useDsh.getState();
    return {
      ctx: this.ctx, log, clock: now, signal,
      model: this.modelFn(ui.provider, ui.model,
        (d) => useDsh.getState().set({ streamText: useDsh.getState().streamText + d }),
        (d) => useDsh.getState().set({ streamReasoning: useDsh.getState().streamReasoning + d })),
      tools: () => (this.ctx.isLoaded("tool-registry") ? this.tools() : []),
      system: () => this.system(),
    };
  }

  private async guard<T>(fn: (log: DshLog, signal: AbortSignal) => Promise<T>): Promise<T | null> {
    if (useDsh.getState().running) return null;
    const log = this.activeLog();
    const id = useDsh.getState().activeId!;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    useDsh.getState().set({ running: true, streamText: "", streamReasoning: "" });
    // Persist after every durable append, so a reload resumes from the log.
    const tick = setInterval(() => { this.persist(id); bump(); }, 400);
    try {
      return await fn(log, signal);
    } finally {
      clearInterval(tick);
      this.persist(id);
      const m = this.meta.get(id);
      if (m && m.title === "New session") {
        const first = log.events.find((e) => e.type === "turn/start");
        if (first && first.type === "turn/start") this.meta.set(id, { ...m, title: first.data.input.slice(0, 48) });
        this.persist(id);
      }
      useDsh.getState().set({ running: false, streamText: "", streamReasoning: "" });
      this.publish();
    }
  }

  send(input: string): Promise<TurnResult | null> {
    return this.guard((log, signal) => runTurn(input, this.deps(log, signal)));
  }

  goal(objective: string, maxRounds = 4) {
    return this.guard(async (log, signal) => {
      useDsh.getState().set({ goalStatus: `running: ${objective}` });
      const r = await runGoal({
        log, objective, maxRounds, signal, judgeName: `${useDsh.getState().judgeProvider}/${useDsh.getState().judgeModel}`,
        turn: (input) => runTurn(input, this.deps(log, signal)),
        judge: (o, ev) => this.judge(o, ev),
      });
      useDsh.getState().set({ goalStatus: `${r.status} after ${r.rounds} round${r.rounds === 1 ? "" : "s"}` });
      return r;
    });
  }

  /** Ralph: every round is a FRESH child session; only the bounded report
   *  crosses rounds, and a worker's "complete" is re-checked by the judge. */
  ralph(objective: string, maxRounds = 4) {
    return this.guard(async (log, signal) => {
      log.append("note", { text: `ralph started: ${objective}` });
      const ui = useDsh.getState();
      const r = await runRalph({
        objective, maxRounds, signal,
        round: async (prompt, round) => {
          const child = new DshLog(now);
          const res = await runTurn(prompt, { ...this.deps(child, signal), model: this.modelFn(ui.provider, ui.model) });
          const cid = rid("s");
          this.logs.set(cid, child);
          this.meta.set(cid, { id: cid, title: `ralph round ${round + 1}`, created: now(), parent: { session: useDsh.getState().activeId ?? "", turn: 0 } });
          this.persist(cid);
          return { text: res.text, evidence: roundEvidence(child, 0) };
        },
        judge: (o, ev) => this.judge(o, ev),
        onRound: (round, rep, v) => log.append("note", { text: `ralph round ${round + 1}: ${rep.status}${v ? ` (judge: ${v.met ? "met" : "not met"} - ${v.note})` : ""} - ${rep.summary.slice(0, 200)}` }),
      });
      log.append("note", { text: `ralph ended: ${r.status} after ${r.rounds} rounds` });
      return r;
    });
  }

  cancel(): void {
    this.abort?.abort();
    for (const s of [...this.settles.values()]) s(false);
    for (const a of [...this.answers.values()]) a(null);
  }

  /** Totals for the meter, from the log (the vendored heuristic for context). */
  meter(id: string) {
    const log = this.logs.get(id);
    if (!log) return { contextTokens: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, requests: 0 };
    const d = deriveMessages(log.events);
    let inputTokens = 0, outputTokens = 0, costUsd = 0, requests = 0;
    for (const e of log.events) {
      if (e.type !== "assistant/message") continue;
      requests++;
      costUsd += e.data.costUsd ?? 0;
      inputTokens += e.data.usage?.inputTokens ?? 0;
      outputTokens += e.data.usage?.outputTokens ?? 0;
    }
    return { contextTokens: estimateTokens(d.system, d.messages), inputTokens, outputTokens, costUsd, requests };
  }

  providerSupportsNative(provider: string): boolean {
    return !!getProvider(provider);
  }
}

/** Run code in a throwaway worker with network and DOM-ish globals removed. */
function runInWorker(code: string, timeoutMs = 5000): Promise<string | { content: string; isError: boolean }> {
  const src = `
    const logs = [];
    self.console = { log: (...a) => logs.push(a.map(String).join(" ")), error: (...a) => logs.push("error: " + a.map(String).join(" ")), warn: (...a) => logs.push("warn: " + a.map(String).join(" ")) };
    for (const k of ["fetch", "XMLHttpRequest", "WebSocket", "importScripts", "EventSource", "indexedDB", "caches", "BroadcastChannel"]) { try { self[k] = undefined; } catch (e) {} }
    self.onmessage = async (ev) => {
      try {
        const fn = new Function(ev.data);
        const value = await fn();
        self.postMessage({ ok: true, value: value === undefined ? undefined : JSON.stringify(value), logs });
      } catch (e) {
        self.postMessage({ ok: false, error: String(e && e.message || e), logs });
      }
    };`;
  return new Promise((resolve) => {
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    const w = new Worker(url);
    const t = setTimeout(() => { w.terminate(); URL.revokeObjectURL(url); resolve({ content: `Timed out after ${timeoutMs}ms.`, isError: true }); }, timeoutMs);
    w.onmessage = (ev: MessageEvent<{ ok: boolean; value?: string; error?: string; logs: string[] }>) => {
      clearTimeout(t); w.terminate(); URL.revokeObjectURL(url);
      const out = [...ev.data.logs, ev.data.ok ? `=> ${ev.data.value ?? "undefined"}` : `Error: ${ev.data.error}`].join("\n");
      resolve(ev.data.ok ? out : { content: out, isError: true });
    };
    w.postMessage(code);
  });
}

let runtime: DshRuntime | null = null;
export function dsh(): DshRuntime {
  if (!runtime) {
    runtime = new DshRuntime();
    runtime.boot();
    if (typeof window !== "undefined") {
      const w = window as unknown as { __dsh?: DshRuntime; __aios?: Record<string, unknown> };
      w.__dsh = runtime;
      if (w.__aios) w.__aios.dsh = runtime;
    }
  }
  return runtime;
}
export type { DshRuntime };
