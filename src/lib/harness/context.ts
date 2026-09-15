/* ────────────────────────────────────────────────────────────────────────────
   Layer 4 — trusted context.

   Two properties decide whether this layer is worth having.

   1. The prefix must be CACHE-STABLE. Providers cache a prompt prefix on an
      all-or-nothing byte match, so anything that moves when the run's volatile
      content changes throws the cache away and silently multiplies the bill.
      The stable budget here is therefore a function of maxChars ALONE — never
      of how many volatile facts happen to exist, never of the query. The
      leftover volatile budget is not reclaimed when there is nothing volatile
      to put in it: reclaiming it would mean the stable block shrinks the moment
      a single volatile fact appears, which is precisely the shift this exists
      to prevent. Wasted budget is cheap; a permanent cache miss is not.
   2. Nothing is dropped silently. Every fact handed in leaves in exactly one of
      `includedIds` or `withheld`, with a reason. "Why did the agent not see the
      thing I gave it" is the question that destroys trust in a memory.
   ──────────────────────────────────────────────────────────────────────────── */

import type { ContextBlock, Fact, FactStore } from "./types";

/** Roughly the shortest prefix a provider will cache at all (~1k tokens).
 *  A stable block below this buys nothing from the discipline above, which is
 *  why STABLE_SHARE is set so the default 6,000-char budget clears it. */
export const CACHE_MIN_CHARS = 4200;

/** Fraction of the character budget reserved for the stable prefix.
 *  0.75 of the default 6,000 is 4,500 — comfortably over CACHE_MIN_CHARS. */
export const STABLE_SHARE = 0.75;

export const STABLE_HEADER = "# Trusted context";
export const VOLATILE_HEADER = "# Recent context";

const SEP = "\n\n";

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function tokenize(q: string): string[] {
  return normalize(q).split(" ").filter((t) => t.length >= 2);
}

/** Distinct query tokens present in the fact. Lexical and deterministic: a
 *  retrieval step that needs a model call cannot run inside a pure module, and
 *  a non-deterministic one makes a replayed trace stop matching. */
function relevance(fact: Fact, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const hay = normalize(`${fact.text} ${fact.source} ${fact.tags.join(" ")}`);
  let hits = 0;
  for (const t of tokens) if (hay.includes(t)) hits++;
  return hits;
}

/** No timestamp in here, on purpose: `updatedAt` changes on every touch and a
 *  clock printed inside the cache prefix guarantees a miss on every run. */
function renderFact(f: Fact): string {
  return `[${f.id}] ${f.source} (${f.sourceKind}, w${f.weight})\n${f.text}`;
}

/** Locale-independent thousands grouping. `toLocaleString` would make the
 *  withheld ledger — which lands in a trace file — depend on the machine. */
function group(n: number): string {
  const s = Math.abs(Math.trunc(n)).toString();
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ",";
    out += s[i];
  }
  return n < 0 ? `-${out}` : out;
}

export function createFactStore(facts: Fact[]): FactStore {
  const snapshot = [...facts];
  const index = new Map<string, Fact>();
  for (const f of snapshot) if (!index.has(f.id)) index.set(f.id, f);

  return {
    all: () => [...snapshot],
    byId: (id: string) => index.get(id),
    search: (q: string, limit: number) => {
      if (limit <= 0) return [];
      const tokens = tokenize(q);
      // An empty query returning nothing is the guard that excludes the case it
      // exists to serve: the caller asked for "whatever is most relevant" and a
      // store with no query still has weights to rank by.
      if (tokens.length === 0) {
        return [...snapshot]
          .sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .slice(0, limit);
      }
      return snapshot
        .map((f) => ({ f, score: relevance(f, tokens) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || b.f.weight - a.f.weight || (a.f.id < b.f.id ? -1 : a.f.id > b.f.id ? 1 : 0))
        .map((x) => x.f)
        .slice(0, limit);
    },
  };
}

export interface AssembleOptions {
  maxChars: number;
  query: string;
  /** Volatile facts under this weight are recorded as withheld rather than
   *  included. Defaults to 0 — off — because a cut that drops facts by default
   *  is a silent context loss dressed up as a feature. */
  minVolatileWeight?: number;
}

interface Packed {
  body: string;
  included: string[];
  withheld: Array<{ id: string; reason: string; chars: number }>;
}

function pack(facts: Fact[], header: string, budget: number): Packed {
  const parts: string[] = [];
  const included: string[] = [];
  const withheld: Array<{ id: string; reason: string; chars: number }> = [];
  let used = header.length;

  for (const f of facts) {
    const rendered = renderFact(f);
    const cost = SEP.length + rendered.length;
    if (used + cost <= budget) {
      parts.push(rendered);
      included.push(f.id);
      used += cost;
    } else {
      withheld.push({
        id: f.id,
        reason: `budget: ${group(used + cost - budget)} chars over`,
        chars: rendered.length,
      });
    }
  }

  return {
    body: parts.length === 0 ? "" : [header, ...parts].join(SEP),
    included,
    withheld,
  };
}

/** Stable facts first, ordered by (weight desc, id asc), then volatile facts.
 *  The two are never interleaved and the query never touches the stable order:
 *  a prefix that reorders itself per question is a prefix that never caches. */
export function assembleContext(facts: Fact[], opts: AssembleOptions): ContextBlock {
  const minVolatileWeight = opts.minVolatileWeight ?? 0;
  const maxChars = Math.max(0, opts.maxChars);
  const stableBudget = Math.floor(maxChars * STABLE_SHARE);
  const volatileBudget = maxChars - stableBudget;

  const withheld: Array<{ id: string; reason: string; chars: number }> = [];
  const seen = new Set<string>();
  const stableIn: Fact[] = [];
  const volatileIn: Fact[] = [];

  for (const f of facts) {
    if (seen.has(f.id)) {
      withheld.push({ id: f.id, reason: "duplicate id: first occurrence kept", chars: f.text.length });
      continue;
    }
    seen.add(f.id);
    if (f.text.trim() === "") {
      withheld.push({ id: f.id, reason: "empty text", chars: 0 });
      continue;
    }
    if (f.volatile) {
      if (f.weight < minVolatileWeight) {
        withheld.push({
          id: f.id,
          reason: `volatile and below weight cut (weight ${f.weight} < ${minVolatileWeight})`,
          chars: f.text.length,
        });
        continue;
      }
      volatileIn.push(f);
    } else {
      stableIn.push(f);
    }
  }

  const byWeightThenId = (a: Fact, b: Fact): number =>
    b.weight - a.weight || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  const orderedStable = [...stableIn].sort(byWeightThenId);

  const tokens = tokenize(opts.query);
  const orderedVolatile = [...volatileIn].sort((a, b) => {
    const d = relevance(b, tokens) - relevance(a, tokens);
    return d !== 0 ? d : byWeightThenId(a, b);
  });

  const stable = pack(orderedStable, STABLE_HEADER, stableBudget);
  const volatile = pack(orderedVolatile, VOLATILE_HEADER, volatileBudget);

  return {
    stable: stable.body,
    volatile: volatile.body,
    includedIds: [...stable.included, ...volatile.included],
    withheld: [...withheld, ...stable.withheld, ...volatile.withheld],
    chars: stable.body.length + volatile.body.length,
  };
}

/** A stable block under the provider's minimum is not cached at all, so the
 *  cost of the discipline is being paid for nothing. Worth surfacing. */
export function cacheEligible(block: ContextBlock): boolean {
  return block.stable.length >= CACHE_MIN_CHARS;
}
