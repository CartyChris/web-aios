/* For You, the local half. Three questions, all answered without the network:

   - Why is this suggestion here? Which of the user's terms it names, and which
     of their own signals put each term in the profile, with each signal's
     exact share of the score.
   - What did the user say about it? More / Less taps re-weight terms, a mute
     removes a term from the profile entirely, and tapping again undoes the tap.
   - What would leave the device if they press Suggest? The same list the
     prompt is built from, serialised the same way, so the panel cannot drift
     from the request.

   Pure: the clock is passed in, no DOM, no stores. */

import type { Interest, InterestSignal, SignalSource } from "./interest-types";
import { extractInterests, redact } from "./interests";
import type { Suggestion, SuggestAllowed } from "./suggest";

const DAY_MS = 86_400_000;

/* ── feedback ─────────────────────────────────────────────────────────────── */

/** One net vote multiplies a term's score by 2^VOTE_STEP (about 1.41). The
 *  multiplier stops growing at VOTE_CAP votes either way, so a run of taps can
 *  lift a topic about 2.8x or sink it to about 0.35x, never to zero: silencing a
 *  term is what Mute is for. */
export const VOTE_STEP = 0.5;
export const VOTE_CAP = 3;
/** Oldest ratings fall off past this; their votes stay, only the undo goes. */
export const RATED_CAP = 200;

export interface Rating {
  dir: 1 | -1;
  /** The terms this tap moved, remembered so a second tap undoes exactly these
   *  even after the profile has changed. */
  terms: string[];
}

export interface Feedback {
  /** Net More (+1) / Less (-1) per term. Stored unclamped so an undo is exact;
   *  the cap applies only when the multiplier is computed. */
  votes: Record<string, number>;
  /** Terms the user never wants used or sent. A single word also hides every
   *  two-word term containing it. */
  muted: string[];
  /** Keyed by suggestionKey(title). A Less rating also hides the suggestion. */
  rated: Record<string, Rating>;
}

export const EMPTY_FEEDBACK: Feedback = { votes: {}, muted: [], rated: {} };

export function normTerm(s: string): string {
  return String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function suggestionKey(s: { title: string }): string {
  return normTerm(s.title);
}

export function voteFactor(votes: number): number {
  const v = Number.isFinite(votes) ? Math.max(-VOTE_CAP, Math.min(VOTE_CAP, votes)) : 0;
  return Math.pow(2, v * VOTE_STEP);
}

export function isMuted(term: string, muted: readonly string[]): boolean {
  const t = normTerm(term);
  if (!t) return false;
  const words = t.split(" ");
  return muted.some((m) => {
    const mm = normTerm(m);
    if (!mm) return false;
    if (mm === t) return true;
    return !mm.includes(" ") && words.includes(mm);
  });
}

export interface RankedInterest extends Interest {
  /** The score before the user's votes. */
  base: number;
  votes: number;
  /** voteFactor(votes); score === base * factor. */
  factor: number;
}

/** Mute, re-weight, re-rank, cut. With no feedback this is the identity on the
 *  first `limit` items of an extractInterests list, so taking a wider pool
 *  first changes nothing until the user votes. */
export function applyFeedback(profile: Interest[], fb: Feedback, limit: number): RankedInterest[] {
  const n = Math.floor(limit);
  if (!(n > 0)) return [];
  return profile
    .filter((i) => !isMuted(i.term, fb.muted))
    .map((i) => {
      const votes = fb.votes[normTerm(i.term)] ?? 0;
      const factor = voteFactor(votes);
      return { ...i, base: i.score, votes, factor, score: i.score * factor };
    })
    .sort((a, b) => b.score - a.score || (a.term < b.term ? -1 : a.term > b.term ? 1 : 0))
    .slice(0, n);
}

/** A More (+1) or Less (-1) tap on one suggestion. Tapping the same direction
 *  again undoes it; tapping the other direction replaces it. */
export function rateSuggestion(fb: Feedback, key: string, terms: string[], dir: 1 | -1): Feedback {
  const votes = { ...fb.votes };
  const bump = (list: string[], d: number) => {
    for (const t of list) {
      const v = (votes[t] ?? 0) + d;
      if (v === 0) delete votes[t];
      else votes[t] = v;
    }
  };
  const prev = fb.rated[key];
  const rated = { ...fb.rated };
  if (prev) {
    bump(prev.terms, -prev.dir);
    delete rated[key];
  }
  if (!prev || prev.dir !== dir) {
    const clean = [...new Set(terms.map(normTerm).filter(Boolean))];
    bump(clean, dir);
    rated[key] = { dir, terms: clean };
  }
  const keys = Object.keys(rated);
  for (const k of keys.slice(0, Math.max(0, keys.length - RATED_CAP))) delete rated[k];
  return { ...fb, votes, rated };
}

export function muteTerm(fb: Feedback, term: string): Feedback {
  const t = normTerm(term);
  if (!t || fb.muted.includes(t)) return fb;
  return { ...fb, muted: [...fb.muted, t] };
}

export function unmuteTerm(fb: Feedback, term: string): Feedback {
  const t = normTerm(term);
  return fb.muted.includes(t) ? { ...fb, muted: fb.muted.filter((m) => m !== t) } : fb;
}

export function isDismissed(fb: Feedback, s: { title: string }): boolean {
  return fb.rated[suggestionKey(s)]?.dir === -1;
}

/** New suggestions the user already said Less to are dropped locally, with a
 *  reason the rejected list can show. */
export function dropDismissed(list: Suggestion[], fb: Feedback): { kept: Suggestion[]; dropped: Array<{ title: string; reason: string }> } {
  const kept: Suggestion[] = [];
  const dropped: Array<{ title: string; reason: string }> = [];
  for (const s of list) {
    if (isDismissed(fb, s)) dropped.push({ title: s.title, reason: "you said less like this before" });
    else kept.push(s);
  }
  return { kept, dropped };
}

/* ── why am I seeing this ─────────────────────────────────────────────────── */

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function termRegex(term: string): RegExp | null {
  const words = normTerm(term).split(" ").filter(Boolean).map(escapeRe);
  if (!words.length) return null;
  // Start-of-word match, as offlineSuggestions uses, so "volcano" finds
  // "volcanoes"; the two words of a bigram must be adjacent.
  return new RegExp(`(?<![\\p{L}\\p{N}])${words.join("[^\\p{L}\\p{N}]+")}`, "iu");
}

function suggestionText(s: Suggestion): string {
  const parts: string[] = [s.title, s.why, s.prompt ?? ""];
  const walk = (v: unknown, depth: number) => {
    if (depth > 4) return;
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (v && typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) walk(x, depth + 1);
  };
  walk(s.config, 0);
  return parts.join("\n");
}

/** Which profile terms a suggestion names, in profile order. Empty means the
 *  suggestion does not point at any term, and the UI says so. */
export function matchTerms(s: Suggestion, interests: ReadonlyArray<{ term: string }>): string[] {
  const hay = suggestionText(s);
  const out: string[] = [];
  for (const i of interests) {
    const re = termRegex(i.term);
    if (re && re.test(hay) && !out.includes(i.term)) out.push(i.term);
  }
  return out;
}

export interface Evidence {
  source: SignalSource;
  /** Redacted, clipped. Shown on this device only. */
  snippet: string;
  ageDays: number;
  /** This signal's exact share of the term's score. */
  contribution: number;
}

export interface TermExplanation {
  term: string;
  /** The term's score before votes, from the same signals and clock. */
  base: number;
  evidence: Evidence[];
  /** base minus the shown evidence: what every other signal adds, exactly. */
  rest: number;
  /** Contributing signals found but not shown. */
  restSignals: number;
  /** Candidate signals not examined because of the scan cap; each may add nothing. */
  unscanned: number;
}

export const EVIDENCE_SCAN_CAP = 24;
export const SNIPPET_MAX = 90;

export function snippet(text: string): string {
  const t = redact(String(text ?? "")).replace(/\s+/g, " ").trim();
  return t.length > SNIPPET_MAX ? `${t.slice(0, SNIPPET_MAX - 1).trimEnd()}…` : t;
}

/** Each signal's share of a term's score, exactly.
 *
 *  A signal's credit depends on the other signals (a word pair is a term only
 *  if two signals share it), so it cannot be measured by scoring the signal
 *  alone or by leaving it out. Instead its weight is set to zero: it still
 *  counts towards which pairs recur, but adds no score, and the drop in the
 *  term's score is its contribution. The contributions then sum to the score. */
export function explainTerm(
  signals: InterestSignal[],
  term: string,
  now: number,
  opts: { maxEvidence?: number; scanCap?: number; halfLifeDays?: number } = {},
): TermExplanation {
  const t = normTerm(term);
  const maxEvidence = Math.max(0, Math.floor(opts.maxEvidence ?? 3));
  const scanCap = Math.max(0, Math.floor(opts.scanCap ?? EVIDENCE_SCAN_CAP));
  const extractOpts = { limit: Number.POSITIVE_INFINITY, ...(opts.halfLifeDays !== undefined ? { halfLifeDays: opts.halfLifeDays } : {}) };
  const scoreIn = (list: InterestSignal[]) => extractInterests(list, now, extractOpts).find((i) => i.term === t)?.score ?? 0;
  const empty: TermExplanation = { term: t, base: 0, evidence: [], rest: 0, restSignals: 0, unscanned: 0 };
  if (!t) return empty;
  const base = scoreIn(signals);
  if (!(base > 0)) return empty;

  // Only a signal whose text holds every word of the term can credit it; the
  // substring test is a superset of the tokeniser's, so nothing is missed.
  const words = t.split(" ");
  const candidates: number[] = [];
  signals.forEach((s, i) => {
    if (s && typeof s.text === "string" && words.every((w) => s.text.toLowerCase().includes(w))) candidates.push(i);
  });
  // Newest first, so the cap keeps what the person is likeliest to remember.
  candidates.sort((a, b) => (signals[b]?.at ?? 0) - (signals[a]?.at ?? 0) || a - b);
  const scanned = candidates.slice(0, scanCap);

  const found: Evidence[] = [];
  for (const idx of scanned) {
    const s = signals[idx] as InterestSignal;
    const zeroed = signals.map((x, j) => (j === idx ? { ...x, weight: 0 } : x));
    const c = base - scoreIn(zeroed);
    if (c > 1e-12) {
      found.push({ source: s.source, snippet: snippet(s.text), ageDays: Math.max(0, Math.floor((now - s.at) / DAY_MS)), contribution: c });
    }
  }
  found.sort((a, b) => b.contribution - a.contribution || a.ageDays - b.ageDays);
  const evidence = found.slice(0, maxEvidence);
  const shown = evidence.reduce((a, e) => a + e.contribution, 0);
  const rest = base - shown;
  return {
    term: t,
    base,
    evidence,
    rest: Math.abs(rest) < 1e-9 ? 0 : rest,
    restSignals: found.length - evidence.length,
    unscanned: candidates.length - scanned.length,
  };
}

export interface SuggestionWhy {
  terms: Array<RankedInterest & { rank: number; explanation: TermExplanation }>;
  /** Matched terms beyond maxTerms, named but not broken down. */
  moreTerms: string[];
}

export function explainSuggestion(
  s: Suggestion,
  ranked: RankedInterest[],
  signals: InterestSignal[],
  now: number,
  opts: { maxTerms?: number; maxEvidence?: number; scanCap?: number } = {},
): SuggestionWhy {
  const maxTerms = Math.max(0, Math.floor(opts.maxTerms ?? 3));
  const matched = matchTerms(s, ranked);
  const terms = matched.slice(0, maxTerms).map((term) => {
    const idx = ranked.findIndex((r) => r.term === term);
    const r = ranked[idx] as RankedInterest;
    return { ...r, rank: idx + 1, explanation: explainTerm(signals, term, now, { maxEvidence: opts.maxEvidence, scanCap: opts.scanCap }) };
  });
  return { terms, moreTerms: matched.slice(maxTerms) };
}

/* ── what leaves the device ──────────────────────────────────────────────── */

/** The terms exactly as suggestionPrompt serialises them. */
export function outboundTerms(interests: ReadonlyArray<{ term: string; score: number }>): Array<{ term: string; score: number }> {
  return interests.map((i) => ({ term: i.term, score: Math.round(i.score * 100) / 100 }));
}

/** The catalogue the prompt is built from. With shareNames off, the names the
 *  user gave their own widgets and apps stay here; duplicate checking still
 *  uses them locally, because parseSuggestions is given the full list. */
export function outboundAllowed(allowed: SuggestAllowed, shareNames: boolean): SuggestAllowed {
  if (shareNames) return allowed;
  return { ...allowed, existing: { ...allowed.existing, customWidgetNames: [], appNames: [] } };
}

export interface Manifest {
  terms: Array<{ term: string; score: number }>;
  /** Profile terms the user muted: in the profile, never in the request. */
  heldBack: string[];
  names: { customWidgets: string[]; apps: string[] };
  withheldNames: number;
  widgetKindsOnDesktop: string[];
  catalogue: { widgetKinds: number; services: number; newsSources: number };
  /** Signals by source: all of them stay on this device. */
  local: { total: number; bySource: Partial<Record<SignalSource, number>> };
}

export function manifest(
  sent: ReadonlyArray<{ term: string; score: number }>,
  profile: ReadonlyArray<{ term: string }>,
  fb: Feedback,
  allowed: SuggestAllowed,
  shareNames: boolean,
  signals: ReadonlyArray<InterestSignal>,
): Manifest {
  const out = outboundAllowed(allowed, shareNames);
  const bySource: Partial<Record<SignalSource, number>> = {};
  for (const s of signals) bySource[s.source] = (bySource[s.source] ?? 0) + 1;
  return {
    terms: outboundTerms(sent),
    heldBack: profile.filter((p) => isMuted(p.term, fb.muted)).map((p) => p.term),
    names: { customWidgets: [...out.existing.customWidgetNames], apps: [...out.existing.appNames] },
    withheldNames: shareNames ? 0 : allowed.existing.customWidgetNames.length + allowed.existing.appNames.length,
    widgetKindsOnDesktop: [...out.existing.widgetKinds],
    catalogue: { widgetKinds: out.widgetKinds.length, services: out.services.length, newsSources: out.newsSources.length },
    local: { total: signals.length, bySource },
  };
}

export function utf8Bytes(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/* ── one-click hand-off ──────────────────────────────────────────────────── */

export const HANDOFF_MAX = 1200;

/** What AIOS Chat is asked when the user taps Ask AIOS on a suggestion. Built
 *  from the suggestion alone: never the signals or the explanation. */
export function aiosHandoff(s: Suggestion): string {
  const lines = [`For You suggested this for my desktop: "${s.title}".`];
  if (s.why) lines.push(`Its reason: ${s.why}`);
  if (s.type === "widget" && s.kind) {
    const cfg = s.config ?? {};
    const detail = s.kind === "data" && typeof cfg.serviceId === "string"
      ? ` using the ${cfg.serviceId} data service${cfg.args && typeof cfg.args === "object" && Object.keys(cfg.args).length ? ` with ${JSON.stringify(cfg.args)}` : ""}`
      : s.kind === "news" && (typeof cfg.sourceId === "string" || typeof cfg.url === "string")
        ? ` showing ${String(cfg.sourceId ?? cfg.url)}`
        : "";
    lines.push(`It is a built-in ${s.kind} widget${detail}.`);
  } else if (s.prompt) {
    lines.push(`${s.type === "app" ? "The app" : "The widget"} would be: ${s.prompt}`);
  }
  lines.push("Give me three concrete ways I could use it this week, in a few lines. Do not change anything on my desktop unless I ask.");
  const text = lines.join("\n");
  return text.length > HANDOFF_MAX ? `${text.slice(0, HANDOFF_MAX - 1)}…` : text;
}

/* ── small labels ────────────────────────────────────────────────────────── */

export function agoLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}
