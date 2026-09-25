/* ────────────────────────────────────────────────────────────────────────────
   Arcade high-score tables.

   PURE. Top N per game, highest first. A tie keeps the OLDER entry above the
   newer one: the person who got there first holds the place, which is how
   every arcade cabinet has done it and what nobody questions.
   ──────────────────────────────────────────────────────────────────────────── */

export interface ScoreEntry {
  score: number;
  at: number;
}

export const TABLE_SIZE = 5;

export function insertScore(list: readonly ScoreEntry[], entry: ScoreEntry, max = TABLE_SIZE): { list: ScoreEntry[]; rank: number | null } {
  if (!Number.isFinite(entry.score) || entry.score <= 0) return { list: list.slice(0, max), rank: null };
  const clean = list.filter((e) => Number.isFinite(e.score) && e.score > 0);
  let at = clean.length;
  for (let i = 0; i < clean.length; i++) {
    if (entry.score > clean[i].score) { at = i; break; }
  }
  if (at >= max) return { list: clean.slice(0, max), rank: null };
  const next = [...clean.slice(0, at), entry, ...clean.slice(at)].slice(0, max);
  return { list: next, rank: at + 1 };
}
