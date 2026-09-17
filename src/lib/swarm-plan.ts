/* ────────────────────────────────────────────────────────────────────────────
   Planning a swarm: who runs, on what model, and in what order.

   The original swarm was a flat fan-out — N agents, same model, all at once,
   one reconciliation at the end. That is the right shape for "ask the same
   question several ways" and the wrong one for almost everything else, because
   real work has structure: a critic needs something to criticise, a synthesiser
   needs the pieces, and an implementer needs the design.

   So an agent may now declare what it DEPENDS ON, and this module turns those
   declarations into waves. Everything inside a wave runs in parallel;
   the next wave starts when the previous finishes. A flat swarm is the special
   case where nothing depends on anything — one wave, exactly the old
   behaviour.

   Model assignment is a separate axis. An agent with no model named uses the
   swarm default, so "run them all on one DeepSeek model" is the empty case;
   an agent that names one overrides it, so a panel can put a cheap model on
   the wide search and an expensive one on the judgement.

   And the router is a third: a small model that reads the question first and
   proposes the assignment. Its output is untrusted text, so `parseRouterPlan`
   validates every field against what actually exists and reports what it threw
   away. A router whose bad suggestion is silently accepted is worse than no
   router, because the run then fails for a reason nothing recorded.

   PURE. No model calls, no clock, no storage.
   ──────────────────────────────────────────────────────────────────────────── */

export interface AgentSpec {
  id: string;
  name: string;
  /** The brief. What this agent is for. */
  role: string;
  /** Undefined means "use the swarm default" — that is how one-model-for-all
   *  works without a separate flag. */
  provider?: string;
  model?: string;
  /** Per-agent override of the swarm ceiling. */
  maxTokens?: number;
  temperature?: number;
  /** Agent ids whose output this one needs before it starts. */
  dependsOn: string[];
  enabled: boolean;
}

/** The ceiling the UI offers. Providers clamp their own limits below this; the
 *  old 4,000 was a slider bound with nothing behind it, and it truncated any
 *  agent asked to actually write something. */
export const MAX_TOKENS_CEILING = 64_000;
export const MIN_TOKENS = 256;
/** A multiple of the 256 slider step above MIN_TOKENS, so the thumb lands
 *  exactly on the default. 4,000 is not: the browser snapped the input to
 *  4,096 while React still held 4,000, and the number beside the label
 *  disagreed with where the handle sat. */
export const DEFAULT_MAX_TOKENS = 4_096;

export function clampTokens(n: number | undefined, fallback = DEFAULT_MAX_TOKENS): number {
  if (n === undefined || !Number.isFinite(n)) return fallback;
  return Math.max(MIN_TOKENS, Math.min(MAX_TOKENS_CEILING, Math.floor(n)));
}

/* ── model resolution ────────────────────────────────────────────────────── */

export interface SwarmDefaults {
  provider: string;
  model: string;
  maxTokens: number;
  temperature: number;
}

export interface ResolvedModel {
  provider: string;
  model: string;
  maxTokens: number;
  temperature: number;
  /** True when this agent took the swarm default rather than naming its own.
   *  The UI shows it, so "they are all on the same model" is visible rather
   *  than assumed. */
  inherited: boolean;
}

export function resolveModel(agent: AgentSpec, defaults: SwarmDefaults): ResolvedModel {
  // A model without a provider is unusable — nothing knows where to send it —
  // so a half-specified agent falls back rather than erroring at request time.
  const named = Boolean(agent.provider && agent.model);
  return {
    provider: named ? (agent.provider as string) : defaults.provider,
    model: named ? (agent.model as string) : defaults.model,
    maxTokens: clampTokens(agent.maxTokens, defaults.maxTokens),
    temperature: agent.temperature ?? defaults.temperature,
    inherited: !named,
  };
}

/** How many distinct models this roster will actually use. One means a
 *  single-model swarm, whatever the per-agent fields happen to say. */
export function modelSpread(agents: AgentSpec[], defaults: SwarmDefaults): string[] {
  const set = new Set<string>();
  for (const a of agents) {
    if (!a.enabled) continue;
    const r = resolveModel(a, defaults);
    set.add(`${r.provider}/${r.model}`);
  }
  return [...set].sort();
}

/* ── wave planning ───────────────────────────────────────────────────────── */

export type PlanResult =
  | { ok: true; waves: string[][]; warnings: string[] }
  | { ok: false; reason: string; cycle?: string[] };

/**
 * Topological levels over the dependency graph.
 *
 * Every id in a wave can run concurrently; wave N+1 starts when wave N is
 * done. Kahn's algorithm, with three refusals that each exist because the
 * alternative is a swarm that hangs and never says why:
 *
 * - A cycle. Named, with the members listed, because "nothing started" is the
 *   least debuggable output a planner can produce.
 * - A dependency on an id that does not exist.
 * - A dependency on a DISABLED agent. This is the subtle one: the graph is
 *   perfectly acyclic and every id resolves, so a naive planner accepts it and
 *   the dependent agent simply waits forever for output that will never come.
 */
export function planWaves(agents: AgentSpec[]): PlanResult {
  const enabled = agents.filter((a) => a.enabled);
  if (enabled.length === 0) return { ok: false, reason: "No agents are enabled." };

  const byId = new Map(enabled.map((a) => [a.id, a]));
  const allIds = new Set(agents.map((a) => a.id));
  const warnings: string[] = [];

  // Validate edges before planning, so a bad edge is a message rather than a
  // silently unreachable node.
  for (const a of enabled) {
    for (const dep of a.dependsOn) {
      if (dep === a.id) {
        return { ok: false, reason: `"${a.name}" depends on itself, so it could never start.`, cycle: [a.id] };
      }
      if (!allIds.has(dep)) {
        return { ok: false, reason: `"${a.name}" depends on ${dep}, which is not an agent in this swarm.` };
      }
      if (!byId.has(dep)) {
        const name = agents.find((x) => x.id === dep)?.name ?? dep;
        return {
          ok: false,
          reason: `"${a.name}" depends on "${name}", which is switched off. It would wait forever for output that never arrives.`,
        };
      }
    }
  }

  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const a of enabled) {
    indegree.set(a.id, a.dependsOn.length);
    for (const dep of a.dependsOn) {
      dependents.set(dep, [...(dependents.get(dep) ?? []), a.id]);
    }
  }

  const waves: string[][] = [];
  let frontier = enabled.filter((a) => (indegree.get(a.id) ?? 0) === 0).map((a) => a.id);
  let placed = 0;

  while (frontier.length > 0) {
    // Sorted, so the same roster always plans to the same waves. A plan whose
    // order changes run to run cannot be compared between runs.
    const wave = [...frontier].sort();
    waves.push(wave);
    placed += wave.length;

    const next: string[] = [];
    for (const id of wave) {
      for (const child of dependents.get(id) ?? []) {
        const left = (indegree.get(child) ?? 0) - 1;
        indegree.set(child, left);
        if (left === 0) next.push(child);
      }
    }
    frontier = next;
  }

  if (placed < enabled.length) {
    const stuck = enabled.filter((a) => (indegree.get(a.id) ?? 0) > 0).map((a) => a.id).sort();
    return {
      ok: false,
      reason: `These agents depend on each other in a loop, so none of them could ever start: ${stuck.join(", ")}.`,
      cycle: stuck,
    };
  }

  if (waves.length > 1) {
    warnings.push(`${waves.length} waves: agents in a later wave wait for the one before it, so the run is at least ${waves.length} round trips deep.`);
  }
  return { ok: true, waves, warnings };
}

/** Longest dependency chain — what the run costs in serial round trips even
 *  with unlimited concurrency. */
export function criticalPath(waves: string[][]): number {
  return waves.length;
}

/* ── the context an agent inherits ───────────────────────────────────────── */

export interface UpstreamOutput {
  agentId: string;
  agentName: string;
  role: string;
  text: string;
}

/** Per-upstream cap. Six upstreams at 4,000 characters is already a large
 *  prompt, and an agent that inherits everything verbatim spends its whole
 *  budget re-reading the swarm. */
export const UPSTREAM_CHARS = 4_000;

/**
 * What a dependent agent is shown of its upstreams.
 *
 * Only DIRECT dependencies, deliberately. Passing the transitive closure would
 * hand a third-wave agent the entire run, which is both expensive and exactly
 * the homogenising pressure a panel exists to avoid: every downstream agent
 * reading every upstream agent converges on one voice.
 */
export function upstreamBlock(agent: AgentSpec, outputs: UpstreamOutput[]): string {
  const wanted = new Set(agent.dependsOn);
  const mine = outputs.filter((o) => wanted.has(o.agentId));
  if (mine.length === 0) return "";
  return [
    "You have been given the work of the agents you depend on. Build on it, correct it, or disagree with it — but do not simply restate it.",
    "",
    ...mine.map((o) => {
      const text = o.text.length > UPSTREAM_CHARS ? `${o.text.slice(0, UPSTREAM_CHARS)}\n…[truncated]` : o.text;
      return `--- ${o.agentName} (brief: ${o.role}) ---\n${text}`;
    }),
  ].join("\n");
}

/* ── the router ──────────────────────────────────────────────────────────── */

export interface ModelChoice {
  provider: string;
  model: string;
  /** Free text the router reads: "cheap and fast", "strong at code". */
  note?: string;
}

/**
 * Ask a small model to assign the roster.
 *
 * The catalogue is passed in rather than described, because a router asked to
 * "pick a good model" will invent one that does not exist. Constraining it to
 * a list is what makes the output checkable — and `parseRouterPlan` checks it
 * anyway, because a constrained model still ignores constraints sometimes.
 */
export function routerPrompt(question: string, agents: AgentSpec[], catalogue: ModelChoice[]): string {
  return [
    "You are routing a panel of AI agents. Assign each agent a model, and say which agents must wait for which others.",
    "",
    "Agents:",
    ...agents.map((a) => `- ${a.id}: ${a.name} — ${a.role}`),
    "",
    "Models you may choose from, and ONLY these:",
    ...catalogue.map((m) => `- ${m.provider}/${m.model}${m.note ? ` (${m.note})` : ""}`),
    "",
    `The question: ${question}`,
    "",
    "Rules:",
    "- Put an agent in `dependsOn` only when it genuinely needs another's output. Independent agents run in parallel and a needless dependency makes the run slower and dearer for nothing.",
    "- Never create a loop.",
    "- Prefer a cheap model for wide, shallow work and a strong one for judgement, synthesis and code.",
    "- maxTokens between 256 and 64000. Give a summariser room; a one-line classifier does not need it.",
    "",
    "Return ONLY a JSON object, no prose and no markdown fence:",
    '{"assignments":[{"id":"<agent id>","provider":"<provider>","model":"<model>","maxTokens":<number>,"dependsOn":["<agent id>"],"why":"<a few words>"}]}',
  ].join("\n");
}

export interface RouterAssignment {
  id: string;
  provider?: string;
  model?: string;
  maxTokens?: number;
  dependsOn: string[];
  why: string;
}

export interface RouterPlan {
  assignments: RouterAssignment[];
  /** Everything discarded, and why. A router whose bad suggestions vanish
   *  silently is worse than no router: the run then fails for a reason
   *  nothing recorded. */
  rejected: Array<{ field: string; value: string; reason: string }>;
}

/**
 * Parse and VALIDATE a router's reply.
 *
 * Every field is checked against what exists: the agent must be in the roster,
 * the model must be in the catalogue, a dependency must name a real agent, and
 * the resulting graph must still plan. Anything that fails is dropped and
 * recorded rather than passed through — the fallback is always the roster the
 * user already had, which works.
 */
export function parseRouterPlan(text: string, agents: AgentSpec[], catalogue: ModelChoice[]): RouterPlan {
  const rejected: RouterPlan["rejected"] = [];
  const known = new Map(agents.map((a) => [a.id, a]));
  const models = new Set(catalogue.map((m) => `${m.provider}/${m.model}`));

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(text));
  } catch {
    return { assignments: [], rejected: [{ field: "response", value: text.slice(0, 80), reason: "the router did not return JSON" }] };
  }

  const raw = (parsed as { assignments?: unknown })?.assignments;
  if (!Array.isArray(raw)) {
    return { assignments: [], rejected: [{ field: "assignments", value: typeof raw, reason: "no assignments array in the reply" }] };
  }

  const assignments: RouterAssignment[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : "";
    if (!known.has(id)) {
      rejected.push({ field: "id", value: String(r.id), reason: "no agent with that id" });
      continue;
    }

    const provider = typeof r.provider === "string" ? r.provider : undefined;
    const model = typeof r.model === "string" ? r.model : undefined;
    let useProvider: string | undefined;
    let useModel: string | undefined;
    if (provider && model) {
      if (models.has(`${provider}/${model}`)) {
        useProvider = provider;
        useModel = model;
      } else {
        rejected.push({ field: "model", value: `${provider}/${model}`, reason: "not a model this deployment offers" });
      }
    }

    const deps: string[] = [];
    const rawDeps = Array.isArray(r.dependsOn) ? r.dependsOn : [];
    for (const d of rawDeps) {
      const dep = typeof d === "string" ? d : "";
      if (dep === id) {
        rejected.push({ field: "dependsOn", value: dep, reason: "an agent cannot depend on itself" });
      } else if (!known.has(dep)) {
        rejected.push({ field: "dependsOn", value: dep, reason: "no agent with that id" });
      } else {
        deps.push(dep);
      }
    }

    const maxTokens = typeof r.maxTokens === "number" && Number.isFinite(r.maxTokens) ? clampTokens(r.maxTokens) : undefined;

    assignments.push({
      id,
      ...(useProvider ? { provider: useProvider } : {}),
      ...(useModel ? { model: useModel } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      dependsOn: deps,
      why: typeof r.why === "string" ? r.why.slice(0, 120) : "",
    });
  }

  return { assignments, rejected };
}

/** Extract the JSON object from a reply that may carry a fence or prose. */
function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? (fenced[1] ?? "") : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return start >= 0 && end > start ? body.slice(start, end + 1) : body.trim();
}

/**
 * Apply a router plan to a roster.
 *
 * Refuses wholesale if the result would not plan — a router that proposes a
 * cycle should cost you nothing, so the roster you had is returned untouched
 * with the reason attached. Partial application would leave half a routed
 * swarm, which is the worst of both.
 */
export function applyRouterPlan(
  agents: AgentSpec[],
  plan: RouterPlan,
): { ok: true; agents: AgentSpec[]; changed: number } | { ok: false; reason: string } {
  const byId = new Map(plan.assignments.map((a) => [a.id, a]));
  let changed = 0;

  const next = agents.map((a) => {
    const assign = byId.get(a.id);
    if (!assign) return a;
    changed += 1;
    return {
      ...a,
      ...(assign.provider && assign.model ? { provider: assign.provider, model: assign.model } : {}),
      ...(assign.maxTokens !== undefined ? { maxTokens: assign.maxTokens } : {}),
      dependsOn: assign.dependsOn,
    };
  });

  const planned = planWaves(next);
  if (!planned.ok) {
    return { ok: false, reason: `The router's plan was rejected: ${planned.reason}` };
  }
  return { ok: true, agents: next, changed };
}
