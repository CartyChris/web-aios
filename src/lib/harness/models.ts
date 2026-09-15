import type { Usd } from "./types";

/* ────────────────────────────────────────────────────────────────────────────
   Role to model, so that swapping a model is configuration.

   The runtime layer's whole promise is that once traces and costs exist, a
   model swap is a config change rather than a code change. That only holds if
   nothing in the loop, the tools or the control layer names a provider. So the
   mapping lives here, keyed by the ROLE a call plays — worker, judge, cheap,
   long_context — and callers ask for a role.

   The one rule this file enforces rather than merely offers: a judge is never
   the worker's own model. A verifier running the producer's weights agrees
   with it far more often than an independent one does, and that agreement is
   indistinguishable from success on every dashboard that measures pass rate.
   ──────────────────────────────────────────────────────────────────────────── */

export type ModelRole = "worker" | "judge" | "cheap" | "long_context";

export interface ModelEntry {
  id: string;
  role: ModelRole[];
  inPerMTok: number;
  outPerMTok: number;
  contextTokens: number;
  notes: string;
}

/** The fallback price, mirroring `PRICE_PER_MTOK.default` in providers.ts.
 *
 *  Duplicated rather than imported because every module under harness/ must
 *  build under tsconfig.test.json, which has no path alias and no DOM lib. An
 *  unknown id costing zero is the dangerous answer: a budget meter that reads
 *  $0.00 for an unrecognised model silently removes the ceiling. */
export const DEFAULT_PRICE = { inPerMTok: 1, outPerMTok: 5 } as const;

/** Declaration order is preference order within a role. */
export const OPENROUTER_CATALOGUE: ModelEntry[] = [
  {
    id: "anthropic/claude-opus-5",
    role: ["worker", "long_context"],
    inPerMTok: 5,
    outPerMTok: 25,
    contextTokens: 200_000,
    notes: "Default worker. Strongest at multi-step tool use; also the most expensive per finished task.",
  },
  {
    id: "openai/gpt-5.2",
    role: ["judge", "worker"],
    inPerMTok: 1.25,
    outPerMTok: 10,
    contextTokens: 400_000,
    notes: "Default judge, because it shares no weights with the default worker.",
  },
  {
    id: "google/gemini-3-pro",
    role: ["long_context", "judge", "worker"],
    inPerMTok: 1.25,
    outPerMTok: 10,
    contextTokens: 1_000_000,
    notes: "Long-context option. A third vendor, so it is a valid judge for either of the two above.",
  },
  {
    id: "anthropic/claude-sonnet-5",
    role: ["worker", "cheap"],
    inPerMTok: 3,
    outPerMTok: 15,
    contextTokens: 200_000,
    notes: "Cheaper worker from the same vendor as the default worker, so it is a poor judge for it.",
  },
  {
    id: "deepseek/deepseek-v3.2",
    role: ["cheap", "worker"],
    inPerMTok: 1,
    outPerMTok: 5,
    contextTokens: 164_000,
    notes: "Priced at the catalogue default; no published figure is pinned here, so treat cost as an estimate.",
  },
  {
    id: "meta-llama/llama-4-maverick",
    role: ["cheap", "worker"],
    inPerMTok: 1,
    outPerMTok: 5,
    contextTokens: 1_000_000,
    notes: "Priced at the catalogue default. Long context at low cost; weakest at strict action formatting.",
  },
  {
    id: "openai/gpt-5.2-mini",
    role: ["cheap", "judge"],
    inPerMTok: 0.25,
    outPerMTok: 2,
    contextTokens: 400_000,
    notes: "Cheapest judge. Use where the criterion is a yes/no reading of a short answer.",
  },
];

/** Everything before the first slash. OpenRouter ids are `vendor/model`. */
export function vendorOf(id: string): string {
  const slash = id.indexOf("/");
  return slash === -1 ? id : id.slice(0, slash);
}

/** The catalogue entry for an id, or a synthetic one at the default price.
 *
 *  A hand-typed model id is a supported escape hatch across this codebase, so
 *  an unknown id must still produce a cost estimate rather than a crash or a
 *  zero. */
export function entryFor(id: string): ModelEntry {
  const known = OPENROUTER_CATALOGUE.find((e) => e.id === id);
  if (known) return known;
  return {
    id,
    role: ["worker"],
    inPerMTok: DEFAULT_PRICE.inPerMTok,
    outPerMTok: DEFAULT_PRICE.outPerMTok,
    contextTokens: 128_000,
    notes: "Not in the catalogue; priced at the default rate and assumed to be a worker.",
  };
}

function blendedPrice(e: ModelEntry): number {
  return e.inPerMTok + e.outPerMTok;
}

/** Pick a model for a role, never returning one of `exclude`.
 *
 *  `pickModel("judge", [workerModelId])` is the cross-model guarantee. Where
 *  the role has no candidate left, any other catalogue model is still a better
 *  answer than the excluded one, so the search widens before it gives up — and
 *  it throws rather than hand back an excluded id, because silently returning
 *  the worker's own model defeats the only reason this function exists. */
export function pickModel(role: ModelRole, exclude: string[] = []): ModelEntry {
  const banned = new Set(exclude);
  const bannedVendors = new Set(exclude.map(vendorOf));

  const byRole = OPENROUTER_CATALOGUE.filter((e) => e.role.includes(role) && !banned.has(e.id));
  const candidates = byRole.length > 0
    ? byRole
    : OPENROUTER_CATALOGUE.filter((e) => !banned.has(e.id));

  if (candidates.length === 0) {
    throw new Error(
      `No model left for role "${role}" after excluding ${exclude.join(", ") || "nothing"}. `
      + "Returning an excluded id would defeat the judge-is-not-the-worker rule.",
    );
  }

  // Same-vendor models share training data and failure modes, so a same-vendor
  // judge is only a partial escape from self-agreement. Prefer another vendor,
  // then fall back to declaration order, then to the id so the choice is
  // reproducible run to run.
  const ranked = [...candidates].sort((a, b) => {
    const aCross = bannedVendors.has(vendorOf(a.id)) ? 1 : 0;
    const bCross = bannedVendors.has(vendorOf(b.id)) ? 1 : 0;
    if (aCross !== bCross) return aCross - bCross;
    if (role === "cheap") {
      const price = blendedPrice(a) - blendedPrice(b);
      if (price !== 0) return price;
    }
    const order = OPENROUTER_CATALOGUE.indexOf(a) - OPENROUTER_CATALOGUE.indexOf(b);
    if (order !== 0) return order;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  // Non-empty by the guard above; indexing is safe but TypeScript cannot see it.
  const winner = ranked[0];
  if (!winner) throw new Error(`No model left for role "${role}".`);
  return winner;
}

export function estimateRunCost(entry: ModelEntry, tokensIn: number, tokensOut: number): Usd {
  return (tokensIn / 1e6) * entry.inPerMTok + (tokensOut / 1e6) * entry.outPerMTok;
}
