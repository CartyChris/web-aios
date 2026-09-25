/* Subagent context modes for the Swarm — pure.

   Two ways to start a subagent, as the 2026 harness literature names them:

   - isolated: a fresh context. The agent sees the question and ONLY the
     upstream outputs it declared it depends on. Cheap, independent, and the
     reason a panel disagrees usefully.
   - forked:   the agent inherits the supervisor's context: the supervisor's
     notes plus every output the run has produced so far, whether declared or
     not. More expensive, converges faster, loses independence.

   Nothing else in the swarm changes; this decides the user message and how
   much of it was inherited, so the UI can show a real character count. */

export type ContextMode = "isolated" | "forked";

export interface PriorOutput {
  agentId: string;
  agentName: string;
  role: string;
  text: string;
}

export interface ContextInput {
  mode: ContextMode;
  question: string;
  /** The supervisor's own notes / brief. Only a forked agent sees them. */
  supervisor: string;
  /** Outputs this agent declared it depends on, already formatted. */
  declaredBlock: string;
  /** Every output finished so far in this run, in completion order. */
  allPrior: PriorOutput[];
  /** Ids this agent declared, so a forked block does not repeat them. */
  declaredIds: string[];
  /** Cap on inherited characters for a forked agent. */
  maxInherited?: number;
}

export interface BuiltContext {
  user: string;
  /** A sentence appended to the agent's system prompt describing its context. */
  systemNote: string;
  inheritedChars: number;
}

export const FORK_MAX_CHARS = 24_000;

export function buildAgentContext(c: ContextInput): BuiltContext {
  if (c.mode === "isolated") {
    const user = c.declaredBlock ? `${c.question}\n\n${c.declaredBlock}` : c.question;
    return {
      user,
      systemNote: c.declaredBlock
        ? "Agents before you have already worked on this and their output is in the message. Advance it."
        : "You start with a fresh context. Stay in your lane — another agent covers the other angles.",
      inheritedChars: c.declaredBlock.length,
    };
  }
  const max = c.maxInherited ?? FORK_MAX_CHARS;
  const parts: string[] = [];
  if (c.supervisor.trim()) parts.push(`Supervisor context:\n${c.supervisor.trim()}`);
  if (c.declaredBlock) parts.push(c.declaredBlock);
  const others = c.allPrior.filter((p) => !c.declaredIds.includes(p.agentId));
  if (others.length) {
    parts.push(
      "Other work in this run so far (inherited from the supervisor):\n\n" +
        others.map((p) => `### ${p.agentName} (${p.role})\n${p.text}`).join("\n\n"),
    );
  }
  let inherited = parts.join("\n\n---\n\n");
  if (inherited.length > max) {
    // Keep the newest material: the tail is what the supervisor knows latest.
    inherited = `[... ${inherited.length - max} earlier characters of inherited context dropped]\n${inherited.slice(inherited.length - max)}`;
  }
  return {
    user: inherited ? `${c.question}\n\n${inherited}` : c.question,
    systemNote: "You are forked from the supervisor and inherit its context, which is in the message. Build on it; do not repeat it.",
    inheritedChars: inherited.length,
  };
}
