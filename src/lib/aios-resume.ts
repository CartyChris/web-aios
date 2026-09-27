/* ────────────────────────────────────────────────────────────────────────────
   Resuming an AIOS Chat run after a reload or crash.

   The run writes a checkpoint after every step: the conversation so far, the
   step number, and -- when the model has asked for a tool that has not
   returned yet -- that pending call. After a reload the chat offers "Resume
   from step N", and planResume decides what that means:

   - a pending READ-ONLY tool is simply run again;
   - a pending tool with SIDE EFFECTS is never re-run silently: it goes back
     through the approval prompt, even if it had been approved, because nobody
     can know whether it half-happened before the page went away;
   - otherwise the run continues with the next model turn.

   The checkpoint comes from localStorage, so it is validated like any other
   untrusted input, and a stale one (over a day old) is not offered.

   PURE.
   ──────────────────────────────────────────────────────────────────────────── */

export interface ConvoTurn { role: "user" | "assistant"; content: string }

export interface Checkpoint {
  v: 1;
  prompt: string;
  convo: ConvoTurn[];
  /** The step the run was on (1-based). */
  step: number;
  pending: null | { tool: string; args: Record<string, unknown>; what: string };
  startedAt: number;
  savedAt: number;
}

export const MAX_CHECKPOINT_AGE = 24 * 3_600_000;
const MAX_TURN_CHARS = 60_000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseCheckpoint(v: unknown, now: number): Checkpoint | null {
  if (!isObj(v) || v.v !== 1 || typeof v.prompt !== "string" || !Array.isArray(v.convo)) return null;
  const convo: ConvoTurn[] = [];
  for (const t of v.convo.slice(0, 200)) {
    if (!isObj(t) || (t.role !== "user" && t.role !== "assistant") || typeof t.content !== "string") return null;
    convo.push({ role: t.role, content: t.content.slice(0, MAX_TURN_CHARS) });
  }
  if (!convo.length || convo[0].role !== "user") return null;
  const savedAt = typeof v.savedAt === "number" ? v.savedAt : 0;
  if (!(savedAt > 0) || now - savedAt > MAX_CHECKPOINT_AGE || savedAt > now + 60_000) return null;
  const step = typeof v.step === "number" && Number.isInteger(v.step) && v.step >= 1 && v.step <= 100 ? v.step : 1;
  let pending: Checkpoint["pending"] = null;
  if (isObj(v.pending) && typeof v.pending.tool === "string" && /^[a-z_]{1,40}$/.test(v.pending.tool) && isObj(v.pending.args)) {
    pending = { tool: v.pending.tool, args: v.pending.args, what: typeof v.pending.what === "string" ? v.pending.what.slice(0, 300) : v.pending.tool };
  }
  return { v: 1, prompt: v.prompt.slice(0, 20_000), convo, step, pending, startedAt: typeof v.startedAt === "number" ? v.startedAt : savedAt, savedAt };
}

export type ResumePlan =
  | { kind: "continue"; step: number; convo: ConvoTurn[] }
  | { kind: "rerun-tool"; step: number; convo: ConvoTurn[]; tool: string; args: Record<string, unknown>; what: string }
  | { kind: "ask-again"; step: number; convo: ConvoTurn[]; tool: string; args: Record<string, unknown>; what: string };

export function planResume(cp: Checkpoint, needsApproval: (tool: string) => boolean, maxSteps: number): ResumePlan | null {
  if (cp.step > maxSteps) return null;
  if (cp.pending) {
    const base = { step: cp.step, convo: cp.convo, tool: cp.pending.tool, args: cp.pending.args, what: cp.pending.what };
    return needsApproval(cp.pending.tool) ? { kind: "ask-again", ...base } : { kind: "rerun-tool", ...base };
  }
  // The last turn is the model's reply that was never acted on, or a tool
  // result the model never saw: either way the next model turn picks it up.
  return { kind: "continue", step: cp.step, convo: cp.convo };
}

/** A checkpoint small enough to store: long turns are clipped from the middle. */
export function makeCheckpoint(prompt: string, convo: ConvoTurn[], step: number, pending: Checkpoint["pending"], startedAt: number, now: number): Checkpoint {
  const clipTurn = (s: string) => (s.length <= MAX_TURN_CHARS ? s : `${s.slice(0, MAX_TURN_CHARS / 2)}\n[... clipped ...]\n${s.slice(-MAX_TURN_CHARS / 2)}`);
  return { v: 1, prompt, convo: convo.map((t) => ({ role: t.role, content: clipTurn(t.content) })), step, pending, startedAt, savedAt: now };
}
