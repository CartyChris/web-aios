/**
 * dsh-lite plugins and drivers: approval presets, argument validation,
 * compaction, goals and the Ralph loop. Re-implemented after the upstream
 * subsystem docs (approval, permission-presets, compaction, goal,
 * tool-ralph); NOT vendored. Every seam is injected so tests run it with a
 * scripted model and no clock. Pure.
 */

import type { ChatMessage } from "../ai-transport";
import { messageText } from "../ai-transport";
import type { DshContext, DshPlugin } from "./context";
import type { DshTool, ModelRequest, ModelReply, PreStepPayload, ToolPipelinePayload, TurnResult } from "./loop";
import { deriveMessages, turnBounds, type DshLog } from "./session";

/* ── Approval ─────────────────────────────────────────────────────────── */

/** ask: every tool asks. auto-read: reads run, writes and destructive ask.
 *  auto-all: every tool runs without asking (upstream's "never" policy). */
export type PermissionPreset = "ask" | "auto-read" | "auto-all";
export const PERMISSION_PRESETS: Array<{ id: PermissionPreset; label: string; description: string }> = [
  { id: "ask", label: "Ask", description: "Every tool call waits for your Approve." },
  { id: "auto-read", label: "Auto-read", description: "Reads run; writes and destructive calls wait for Approve." },
  { id: "auto-all", label: "Auto-all", description: "Every tool runs without asking. Use with care." },
];

export function needsApproval(preset: PermissionPreset, tool: Pick<DshTool, "risk" | "name">): boolean {
  if (tool.name === "ask_user") return true; // the question IS the approval prompt
  if (preset === "auto-all") return false;
  if (preset === "auto-read") return tool.risk !== "read";
  return true;
}

export function approvalPlugin(opts: {
  preset: () => PermissionPreset;
  approve: (p: { callId: string; name: string; args: Record<string, unknown>; risk: DshTool["risk"] }) => Promise<boolean>;
}): DshPlugin {
  return {
    name: "approval",
    description: "Permission presets: gates tool calls through tools/pre-execute and the live-jobs Approve/Deny.",
    apply(ctx) {
      ctx.waterfall<ToolPipelinePayload, ToolPipelinePayload>("tools/pre-execute", async (p, next) => {
        if (p.block !== undefined || !p.tool) return next(p);
        if (p.tool.name === "ask_user") return next({ ...p, approval: "approved" }); // the tool itself asks
        if (!needsApproval(opts.preset(), p.tool)) return next({ ...p, approval: "auto" });
        const ok = await opts.approve({ callId: p.call.id, name: p.tool.name, args: p.args ?? {}, risk: p.tool.risk });
        if (!ok) return next({ ...p, approval: "denied", block: `The user denied ${p.tool.name}. Do not retry it; ask or choose another approach.` });
        return next({ ...p, approval: "approved" });
      });
    },
  };
}

/** Argument validation against each tool's JSON Schema. The validator is
 *  injected: the app passes the vendored dsh `validateJsonSchemaValue`. */
export function validationPlugin(validate: (schema: Record<string, unknown>, value: unknown) => string[]): DshPlugin {
  return {
    name: "tool-validation",
    description: "Validates tool arguments against the tool's JSON Schema before execution (vendored dsh json-schema).",
    required: true,
    apply(ctx) {
      ctx.waterfall<ToolPipelinePayload, ToolPipelinePayload>("tools/pre-execute", async (p, next) => {
        if (!p.tool) return next(p);
        const errors = validate(p.tool.parameters, p.args ?? {});
        if (errors.length) return next({ ...p, block: `Invalid arguments for ${p.tool.name}: ${errors.join("; ")}` });
        return next(p);
      });
    },
  };
}

/* ── Compaction ───────────────────────────────────────────────────────── */

export interface PruneConfig { thresholdChars: number; headChars: number; tailChars: number; keepRecent: number; marker: string }

/** Middle-prune old, long tool results (after upstream's
 *  compaction-tool-result-pruner). Returns the replacements, never mutates. */
export function planPrune(log: DshLog, cfg: PruneConfig): { replacements: Array<{ seq: number; content: string }>; savedChars: number } {
  const done = new Set<number>();
  for (const e of log.events) if (e.type === "compaction/prune") for (const r of e.data.replacements) done.add(r.seq);
  const results = log.events.filter((e) => e.type === "tool/result");
  const old = results.slice(0, Math.max(0, results.length - cfg.keepRecent));
  const replacements: Array<{ seq: number; content: string }> = [];
  let savedChars = 0;
  for (const e of old) {
    if (e.type !== "tool/result" || done.has(e.seq)) continue;
    const cps = Array.from(e.data.content);
    if (cps.length <= cfg.thresholdChars) continue;
    const content = cps.slice(0, cfg.headChars).join("") + cfg.marker + cps.slice(cps.length - cfg.tailChars).join("");
    savedChars += cps.length - Array.from(content).length;
    replacements.push({ seq: e.seq, content });
  }
  return { replacements, savedChars };
}

export function compactionPlugin(opts: {
  log: () => DshLog;
  prune: PruneConfig;
  estimate: (system: string, messages: ChatMessage[]) => number;
  /** Tokens in the model's window, and the fraction that triggers a summary. */
  window: () => number;
  thresholdRatio: number;
  summarize: (transcript: string) => Promise<string>;
}): DshPlugin {
  return {
    name: "compaction",
    description: "Prunes old tool-result middles and summarizes history past the context threshold, logged as compaction/* events.",
    apply(ctx) {
      ctx.waterfall<ModelRequest, ModelReply>("agent/request", async (req, next) => {
        const log = req.log ?? opts.log();
        let changed = false;
        const plan = planPrune(log, opts.prune);
        if (plan.replacements.length) { log.append("compaction/prune", plan); changed = true; }
        let d = changed ? deriveMessages(log.events) : { system: req.system, messages: req.messages };
        const before = opts.estimate(d.system, d.messages);
        if (before > opts.window() * opts.thresholdRatio) {
          // Cut at the start of the current turn: a turn boundary never splits
          // a tool call from its result, so the summary keeps pairs balanced.
          const current = log.last("turn/start");
          const closed = turnBounds(log.events);
          if (current && closed.length) {
            const prior = deriveMessages(log.events.filter((e) => e.seq < current.seq)).messages;
            const text = await opts.summarize(prior.map((m) => `${m.role.toUpperCase()}: ${messageText(m)}`).join("\n\n"));
            log.append("compaction/summary", { uptoSeq: current.seq, text, beforeTokens: before });
            d = deriveMessages(log.events);
            changed = true;
          }
        }
        return next(changed ? { ...req, system: d.system, messages: d.messages } : req);
      });
    },
  };
}

/* ── Goals: the harness judges, never the model ───────────────────────── */

export interface GoalVerdict { met: boolean; note: string }

/** Evidence for one goal round, read from the LOG (not chat memory): every
 *  tool result and the final assistant text since `fromSeq`. */
export function roundEvidence(log: DshLog, fromSeq: number, maxChars = 6000): string {
  const parts: string[] = [];
  for (const e of log.events) {
    if (e.seq < fromSeq) continue;
    if (e.type === "tool/result") parts.push(`[tool ${e.data.name}${e.data.isError ? " ERROR" : ""}] ${e.data.content.slice(0, 800)}`);
    if (e.type === "assistant/message" && e.data.text.trim()) parts.push(`[assistant] ${e.data.text.slice(0, 800)}`);
  }
  const s = parts.join("\n");
  return s.length > maxChars ? s.slice(s.length - maxChars) : s;
}

export function continuationPrompt(objective: string, round: number, maxRounds: number, last?: { note: string; failures: number }): string {
  return [
    `GOAL (immutable): ${objective}`,
    `Round ${round + 1} of ${maxRounds}. Do exactly one concrete unit of work toward the goal this round, using tools, then stop.`,
    last ? `The harness judged the previous round NOT met (attempt ${last.failures}). Judge's note: ${last.note}` : "",
    "You do not decide whether the goal is met. The harness judges from the tool results you produce, so make the evidence observable (write the file, read it back).",
  ].filter(Boolean).join("\n");
}

export async function runGoal(opts: {
  log: DshLog;
  objective: string;
  maxRounds: number;
  turn: (input: string) => Promise<TurnResult>;
  judge: (objective: string, evidence: string) => Promise<GoalVerdict>;
  judgeName: string;
  signal?: AbortSignal;
}): Promise<{ status: "met" | "exhausted" | "cancelled"; rounds: number }> {
  const { log } = opts;
  log.append("goal/set", { objective: opts.objective, maxRounds: opts.maxRounds });
  let last: { note: string; failures: number } | undefined;
  for (let round = 0; round < opts.maxRounds; round++) {
    if (opts.signal?.aborted) { log.append("goal/end", { status: "cancelled" }); return { status: "cancelled", rounds: round }; }
    const from = log.length;
    const r = await opts.turn(continuationPrompt(opts.objective, round, opts.maxRounds, last));
    if (r.reason === "cancelled") { log.append("goal/end", { status: "cancelled" }); return { status: "cancelled", rounds: round + 1 }; }
    const evidence = roundEvidence(log, from);
    const v = evidence.trim()
      ? await opts.judge(opts.objective, evidence)
      : { met: false, note: "No observable evidence was produced this round." };
    log.append("goal/verdict", { round, met: v.met, evidence: evidence.slice(0, 2000), note: v.note, judge: opts.judgeName });
    log.append("note", { text: `goal round ${round + 1}: ${v.met ? "MET" : "not met"} - ${v.note}` });
    if (v.met) { log.append("goal/end", { status: "met" }); return { status: "met", rounds: round + 1 }; }
    last = { note: v.note, failures: (last?.failures ?? 0) + 1 };
  }
  log.append("goal/end", { status: "exhausted" });
  return { status: "exhausted", rounds: opts.maxRounds };
}

/** Parse a judge reply of the form {"met":bool,"note":"..."}; anything else
 *  is a NOT met, because an unreadable verdict is not evidence of success. */
export function parseVerdict(text: string): GoalVerdict {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return { met: false, note: "judge reply was not JSON" };
  try {
    const v = JSON.parse(m[0]) as { met?: unknown; note?: unknown };
    return { met: v.met === true, note: typeof v.note === "string" ? v.note : "" };
  } catch {
    return { met: false, note: "judge reply was not valid JSON" };
  }
}

/* ── Ralph: fresh agent per round, bounded handoff ────────────────────── */

export interface RalphReport { status: "continue" | "complete" | "blocked"; summary: string; evidence: string; next: string }

export function parseRalphReport(text: string): RalphReport {
  const m = /\{[\s\S]*\}/.exec(text);
  try {
    const v = m ? (JSON.parse(m[0]) as Partial<RalphReport>) : {};
    const status = v.status === "complete" || v.status === "blocked" ? v.status : "continue";
    return { status, summary: String(v.summary ?? text.slice(0, 500)), evidence: String(v.evidence ?? ""), next: String(v.next ?? "") };
  } catch {
    return { status: "continue", summary: text.slice(0, 500), evidence: "", next: "" };
  }
}

export function ralphPrompt(objective: string, round: number, maxRounds: number, prev: RalphReport | null, maxHandoff = 4000): string {
  const handoff = prev ? JSON.stringify(prev).slice(0, maxHandoff) : "none (first round)";
  return [
    `OBJECTIVE (immutable): ${objective}`,
    `Round ${round + 1} of ${maxRounds}. You are a fresh agent: you have NO memory of earlier rounds except the handoff below. The shared files are the source of truth; read them first.`,
    `Previous handoff: ${handoff}`,
    `Do one bounded piece of work with tools, then end your reply with ONE JSON object: {"status":"continue|complete|blocked","summary":"...","evidence":"...","next":"..."}.`,
  ].join("\n");
}

/** A worker claiming "complete" is re-checked by the judge; only the judge
 *  can end the loop as complete (upstream Ralph does not verify reports). */
export async function runRalph(opts: {
  objective: string;
  maxRounds: number;
  round: (prompt: string, round: number) => Promise<{ text: string; evidence: string }>;
  judge: (objective: string, evidence: string) => Promise<GoalVerdict>;
  signal?: AbortSignal;
  onRound?: (round: number, report: RalphReport, verdict?: GoalVerdict) => void;
}): Promise<{ status: "complete" | "blocked" | "budget-limited" | "cancelled"; rounds: number; last: RalphReport | null }> {
  let prev: RalphReport | null = null;
  for (let r = 0; r < opts.maxRounds; r++) {
    if (opts.signal?.aborted) return { status: "cancelled", rounds: r, last: prev };
    const out = await opts.round(ralphPrompt(opts.objective, r, opts.maxRounds, prev), r);
    const rep = parseRalphReport(out.text);
    if (rep.status === "blocked") { opts.onRound?.(r, rep); return { status: "blocked", rounds: r + 1, last: rep }; }
    if (rep.status === "complete") {
      const v = await opts.judge(opts.objective, `${out.evidence}\n[worker report] ${rep.summary}\n${rep.evidence}`);
      opts.onRound?.(r, rep, v);
      if (v.met) return { status: "complete", rounds: r + 1, last: rep };
      prev = { ...rep, status: "continue", next: `Harness judge rejected "complete": ${v.note}. ${rep.next}` };
      continue;
    }
    opts.onRound?.(r, rep);
    prev = rep;
  }
  return { status: "budget-limited", rounds: opts.maxRounds, last: prev };
}

/** Pre-step skill expansion: "/skill-name rest" prepends that skill's body. */
export function skillsPlugin(list: () => Array<{ name: string; body: string }>): DshPlugin {
  return {
    name: "skills",
    description: "Expands /skill-name at the start of a message into that skill's instructions (skills live in /dsh/skills/*.md).",
    apply(ctx: DshContext) {
      ctx.waterfall<PreStepPayload, PreStepPayload>("agent/pre-step", async (p, next) => {
        const m = /^\/([\w-]+)\s*([\s\S]*)$/.exec(p.input.trim());
        if (!m) return next(p);
        const skill = list().find((s) => s.name === m[1]);
        if (!skill) return next({ ...p, reject: `No skill named "${m[1]}". Skills: ${list().map((s) => s.name).join(", ") || "none"}` });
        return next({ ...p, input: `[Skill: ${skill.name}]\n${skill.body}\n\n[Task]\n${m[2] || "(apply the skill)"}` });
      });
    },
  };
}
