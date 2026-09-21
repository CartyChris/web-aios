/* ────────────────────────────────────────────────────────────────────────────
   Context folding — what the agent still remembers after step 40.

   A ReAct loop's transcript grows linearly and its window does not. The naive
   fixes are both bad: truncating the head throws away the goal and the reason
   the agent is doing any of this, and asking a model to re-summarise the whole
   transcript each turn produces "context collapse" — each rewrite is shorter
   and blander than the last until the useful detail is gone, and it costs a
   call per step.

   So this is a CURATOR, not a summariser. Completed steps fold into an
   itemized ledger of short bullets, updated incrementally by deterministic
   rules and never regenerated. A repeated event increments a counter instead
   of appending a near-duplicate, which is what turns forty lines of "called
   http_get, timed out" into one line that says it happened forty times — the
   single most useful thing you can tell a model that is stuck in a loop.

   Folded steps are not destroyed. They are addressed by path, so the transcript
   the agent sees carries a pointer it can read back with the tools it already
   has. Losing detail from the window is fine; losing it from the run is not.

   Shape follows the 2026 harness work on context folding, agentic context
   engineering (itemized, incrementally curated context) and file-backed state.

   PURE. No clock, no randomness, no I/O — the caller supplies the artifact path.
   ──────────────────────────────────────────────────────────────────────────── */

import type { Step } from "./types";

export type BulletKind = "failure" | "artifact" | "decision" | "tool" | "note";

export interface LedgerBullet {
  id: string;
  kind: BulletKind;
  text: string;
  /** Step index this was first seen at. */
  firstStep: number;
  /** Step index it was last seen at. */
  lastStep: number;
  /** How many times the same normalized text recurred. The whole point. */
  hits: number;
}

/** Ranked by how much a stuck agent needs to see it. A failure it keeps
 *  hitting outranks a tool call that worked, every time. */
const KIND_RANK: Record<BulletKind, number> = {
  failure: 0,
  artifact: 1,
  decision: 2,
  tool: 3,
  note: 4,
};

export interface FoldOptions {
  /** Steps kept verbatim at the end of the transcript. */
  keepRecent?: number;
  /** Maximum bullets carried forward. */
  maxBullets?: number;
  /** Where the folded steps were written, so the agent can read them back. */
  artifactPath?: string;
  /** Characters allowed for one bullet's text. */
  maxBulletChars?: number;
}

export const FOLD_DEFAULTS = {
  keepRecent: 3,
  maxBullets: 24,
  maxBulletChars: 160,
} as const;

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").replace(/[0-9]+/g, "#").trim();

const clip = (s: string, n: number): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= n ? one : `${one.slice(0, n - 1)}…`;
};

/* ── extraction ──────────────────────────────────────────────────────────── */

/** Paths and URLs worth remembering by address rather than by content. */
const PATH_RE = /(?:^|\s)((?:\/[\w.-]+){2,}|https?:\/\/[^\s)]+)/g;

/**
 * The bullets one step contributes.
 *
 * Deliberately mechanical: no model is asked what mattered, because a model
 * asked that question every step is both the cost and the collapse this module
 * exists to avoid.
 */
export function bulletsFor(step: Step, maxChars: number): Array<Omit<LedgerBullet, "id" | "hits" | "firstStep" | "lastStep">> {
  const out: Array<{ kind: BulletKind; text: string }> = [];
  const verb = step.action?.verb;

  if (step.outcome === "tool_error" || step.outcome === "invalid_action" || step.outcome === "parse_error") {
    out.push({ kind: "failure", text: clip(`${verb ?? step.outcome}: ${step.parseError ?? step.observation}`, maxChars) });
  } else if (step.outcome === "denied") {
    out.push({ kind: "failure", text: clip(`${verb ?? "action"} was denied by the approver`, maxChars) });
  } else if (step.outcome === "acted" && verb) {
    out.push({ kind: "tool", text: clip(`${verb}(${compactArgs(step.action?.args ?? {})}) -> ${step.observation}`, maxChars) });
  } else if (step.outcome === "finished") {
    out.push({ kind: "decision", text: clip(`finished: ${step.observation}`, maxChars) });
  }

  // Anything path-addressable is worth a line of its own: it is how the agent
  // gets the detail back after the step itself has been folded away.
  const seen = new Set<string>();
  for (const m of step.observation.matchAll(PATH_RE)) {
    const p = m[1];
    if (seen.has(p)) continue;
    seen.add(p);
    out.push({ kind: "artifact", text: clip(p, maxChars) });
    if (seen.size >= 3) break;
  }

  return out;
}

function compactArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    parts.push(`${k}=${clip(String(s ?? ""), 40)}`);
    if (parts.length >= 3) break;
  }
  return parts.join(", ");
}

/* ── curation ────────────────────────────────────────────────────────────── */

/**
 * Fold one step into the ledger, in place-by-value.
 *
 * A bullet whose normalized text already exists increments `hits` and moves
 * its `lastStep` forward rather than being appended. Normalization folds digits
 * together, so "timed out after 3000ms" and "timed out after 5000ms" are one
 * recurring failure rather than two singletons — which is the difference
 * between a ledger that says "this is a loop" and one that just gets longer.
 */
export function curate(bullets: LedgerBullet[], step: Step, opts: FoldOptions = {}): LedgerBullet[] {
  const maxChars = opts.maxBulletChars ?? FOLD_DEFAULTS.maxBulletChars;
  const next = bullets.slice();
  const index = new Map(next.map((b, i) => [`${b.kind}:${norm(b.text)}`, i]));

  for (const b of bulletsFor(step, maxChars)) {
    const key = `${b.kind}:${norm(b.text)}`;
    const at = index.get(key);
    if (at !== undefined) {
      const prev = next[at];
      next[at] = { ...prev, hits: prev.hits + 1, lastStep: step.index };
      continue;
    }
    index.set(key, next.length);
    next.push({
      id: `b${step.index}_${next.length}`,
      kind: b.kind,
      text: b.text,
      firstStep: step.index,
      lastStep: step.index,
      hits: 1,
    });
  }
  return next;
}

/**
 * Trim the ledger to `maxBullets`, keeping what a stuck agent needs.
 *
 * Ordered by kind first (a recurring failure outranks a successful tool call),
 * then by hit count, then by recency. Ties broken by id so the result is
 * deterministic — a ledger that reorders between identical runs would make the
 * prompt prefix uncacheable, which is the very thing context.ts protects.
 */
export function prune(bullets: LedgerBullet[], maxBullets: number = FOLD_DEFAULTS.maxBullets): LedgerBullet[] {
  if (bullets.length <= maxBullets) return bullets;
  const ranked = bullets.slice().sort((a, b) =>
    KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
    b.hits - a.hits ||
    b.lastStep - a.lastStep ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const kept = ranked.slice(0, maxBullets);
  // Restore the ledger's original order so the rendered block reads
  // chronologically rather than by rank.
  const keep = new Set(kept.map((b) => b.id));
  return bullets.filter((b) => keep.has(b.id));
}

/* ── folding a transcript ────────────────────────────────────────────────── */

export interface FoldResult {
  /** Steps left verbatim, in order. */
  kept: Step[];
  /** The ledger standing in for everything older. */
  bullets: LedgerBullet[];
  /** Inclusive step indices that were folded, or null if nothing was. */
  foldedRange: [number, number] | null;
  /** Steps folded away. */
  foldedCount: number;
}

/**
 * Split a transcript into a verbatim tail and a ledger for the head.
 *
 * Folding is all-or-nothing per step: half a step in the window is worse than
 * none of it, because a Thought without its Observation reads as an unanswered
 * question and models will answer it again.
 */
export function foldSteps(steps: Step[], opts: FoldOptions = {}): FoldResult {
  const keepRecent = Math.max(0, opts.keepRecent ?? FOLD_DEFAULTS.keepRecent);
  const maxBullets = opts.maxBullets ?? FOLD_DEFAULTS.maxBullets;

  if (steps.length <= keepRecent) {
    return { kept: steps.slice(), bullets: [], foldedRange: null, foldedCount: 0 };
  }

  const cut = steps.length - keepRecent;
  const head = steps.slice(0, cut);
  let bullets: LedgerBullet[] = [];
  for (const s of head) bullets = curate(bullets, s, opts);

  return {
    kept: steps.slice(cut),
    bullets: prune(bullets, maxBullets),
    foldedRange: [head[0].index, head[head.length - 1].index],
    foldedCount: head.length,
  };
}

/* ── rendering ───────────────────────────────────────────────────────────── */

export const LEDGER_HEADER = "# Earlier steps, folded";

const KIND_LABEL: Record<BulletKind, string> = {
  failure: "failed",
  artifact: "wrote",
  decision: "decided",
  tool: "did",
  note: "note",
};

/**
 * The ledger as it appears in the prompt.
 *
 * Returns "" for an empty ledger rather than a lonely header: an empty section
 * reads to a model as "there was nothing earlier", which is false and invites
 * it to redo work it has already done.
 */
export function renderLedger(result: FoldResult, opts: FoldOptions = {}): string {
  if (!result.bullets.length && !result.foldedCount) return "";
  const lines: string[] = [LEDGER_HEADER];

  if (result.foldedRange) {
    const [a, b] = result.foldedRange;
    const where = opts.artifactPath ? ` Full detail: ${opts.artifactPath}` : "";
    lines.push(`Steps ${a}-${b} (${result.foldedCount}) are summarised below.${where}`);
  }

  for (const bl of result.bullets) {
    const times = bl.hits > 1 ? ` (x${bl.hits})` : "";
    const at = bl.firstStep === bl.lastStep ? `s${bl.firstStep}` : `s${bl.firstStep}-${bl.lastStep}`;
    lines.push(`- [${at}] ${KIND_LABEL[bl.kind]}: ${bl.text}${times}`);
  }
  return lines.join("\n");
}

/** Failures that recurred at least `min` times — what a supervisor should look
 *  at before spending another step, and what an eval should turn into a test. */
export function recurringFailures(bullets: LedgerBullet[], min = 2): LedgerBullet[] {
  return bullets
    .filter((b) => b.kind === "failure" && b.hits >= min)
    .sort((a, b) => b.hits - a.hits || (a.id < b.id ? -1 : 1));
}
