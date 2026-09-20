// Turns what the user did inside the OS into a short, ranked list of topics.
// Pure and deterministic so the ranking can be pinned by tests; nothing here
// leaves the browser, and anything that looks like a secret never becomes a term.
import type { Interest, InterestSignal, SignalSource } from "./interest-types";

/** A file you saved or an app you built took effort, so it says more about you
 *  than a query you typed once. Service/harness text is partly machine-shaped
 *  (endpoint names, objectives phrased for an agent), so it counts for less. */
export const SOURCE_WEIGHT: Record<SignalSource, number> = {
  file: 1.5,
  app: 1.4,
  widget: 1.3,
  chat: 1.2,
  search: 1.0,
  harness: 0.9,
  service: 0.8,
};

const SOURCE_ORDER = Object.keys(SOURCE_WEIGHT) as SignalSource[];

const DAY_MS = 86_400_000;
const DEFAULT_HALF_LIFE_DAYS = 14;
const DEFAULT_LIMIT = 12;

/** Most units (distinct terms) one signal may add. Beyond this its credit is
 *  spread thinner, so pasting an essay cannot outvote a week of small actions. */
export const SIGNAL_UNIT_CAP = 6;

/** Only the head of a text is read: signals are meant to be titles and
 *  prompts, and a stray document should not cost a tokenisation of megabytes. */
const MAX_TEXT = 2000;

const STOPWORDS = new Set(
  (
    // English function words.
    "the and for are but not you all any can had her was one our out has him his how its may who did get got let say she too use "
    + "that with have this will your from they them than then there their what when where which while would could should about "
    + "into over under also just only some such more most other very been being were does done doing each few here itself "
    + "myself yourself own same both because until again further once why off before after above below between through during "
    + "these those whom these can't don't won't isn't aren't wasn't didn't doesn't per via yes okay really much many well still "
    + "even ever every lot lots maybe using used use way ways need needs know think thing things something anything "
    // OS boilerplate that every signal would otherwise share.
    + "new untitled chat chats app apps widget widgets file files note notes md txt html htm tsx jsx json css js ts csv yml yaml "
    + "harness run runs desktop window windows stuff make made build built help please want like https http www com org net "
    + "index readme page pages copy draft test tests"
  ).split(/\s+/).filter(Boolean),
);

/** Strip everything that could be a credential or identify a person before a
 *  single token is counted, so a leaked key can never surface as an "interest". */
export function redact(text: string): string {
  return text
    // Query strings and fragments carry tokens and session ids; the path is kept.
    .replace(/(https?:\/\/[^\s?#]*)[?#]\S*/gi, "$1")
    .replace(/\?[^\s]*=[^\s]*/g, " ")
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, " ")
    // Common vendor key prefixes (OpenAI/Stripe sk-, pk-, GitHub ghp_, Slack xox*).
    .replace(/\b(?:sk|pk|rk|ghp|gho|ghs|xox[abprs])[-_][A-Za-z0-9_-]{6,}/gi, " ")
    // Long base64/hex runs. Requiring a digit spares long ordinary words like
    // "internationalization"; 32+ chars is treated as opaque regardless.
    .replace(/[A-Za-z0-9+/_=-]{20,}/g, (m) => (/\d/.test(m) || m.length >= 32 ? " " : m));
}

/** Lower-cased word tokens in order, or null where a token was discarded, so
 *  adjacency (for bigrams) is judged against the original text. */
function tokenise(text: string): (string | null)[] {
  return redact(text.slice(0, MAX_TEXT))
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0)
    .map((t) => (t.length < 3 || /^\p{N}+$/u.test(t) || STOPWORDS.has(t) ? null : t));
}

function bigramsOf(tokens: (string | null)[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 1 < tokens.length; i++) {
    const a = tokens[i], b = tokens[i + 1];
    if (a && b && a !== b) out.add(`${a} ${b}`);
  }
  return out;
}

export function extractInterests(
  signals: InterestSignal[],
  now: number,
  opts: { limit?: number; halfLifeDays?: number } = {},
): Interest[] {
  const limit = Math.floor(opts.limit ?? DEFAULT_LIMIT);
  if (!(limit > 0)) return [];
  const halfLife = opts.halfLifeDays !== undefined && opts.halfLifeDays > 0 && Number.isFinite(opts.halfLifeDays)
    ? opts.halfLifeDays
    : DEFAULT_HALF_LIFE_DAYS;

  const prepared = signals
    .filter((s) => s && typeof s.text === "string" && Number.isFinite(s.at) && s.source in SOURCE_WEIGHT)
    .map((s) => ({ s, tokens: tokenise(s.text) }));

  // A bigram is only a topic if it recurs across signals; one title's word
  // pairs are mostly noise ("quarterly report" once is not an interest).
  const bigramSignals = new Map<string, number>();
  for (const p of prepared) for (const bg of bigramsOf(p.tokens)) bigramSignals.set(bg, (bigramSignals.get(bg) ?? 0) + 1);

  const score = new Map<string, number>();
  const sources = new Map<string, Set<SignalSource>>();

  for (const { s, tokens } of prepared) {
    const extra = s.weight !== undefined && Number.isFinite(s.weight) ? Math.max(0, s.weight) : 1;
    const age = Math.max(0, now - s.at);
    const w = SOURCE_WEIGHT[s.source] * extra * Math.pow(2, -age / (halfLife * DAY_MS));
    if (!(w > 0)) continue;

    // Unigrams inside a recurring bigram are "explained" by it for this signal
    // and are not credited again, so "machine learning" does not also push
    // "machine" and "learning" into the list on the same evidence.
    const covered = new Array<boolean>(tokens.length).fill(false);
    const terms = new Set<string>();
    for (let i = 0; i + 1 < tokens.length; i++) {
      const a = tokens[i], b = tokens[i + 1];
      if (!a || !b || a === b) continue;
      const bg = `${a} ${b}`;
      if ((bigramSignals.get(bg) ?? 0) >= 2) {
        terms.add(bg);
        covered[i] = covered[i + 1] = true;
      }
    }
    tokens.forEach((t, i) => { if (t && !covered[i]) terms.add(t); });
    if (terms.size === 0) continue;

    // Presence, not frequency, and a fixed budget per signal: repeating a word
    // or writing at length buys no extra weight.
    const each = w * Math.min(1, SIGNAL_UNIT_CAP / terms.size);
    for (const t of terms) {
      score.set(t, (score.get(t) ?? 0) + each);
      let set = sources.get(t);
      if (!set) sources.set(t, (set = new Set()));
      set.add(s.source);
    }
  }

  return [...score.entries()]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, limit)
    .map(([term, v]) => ({ term, score: v, sources: SOURCE_ORDER.filter((src) => sources.get(term)?.has(src)) }));
}
