/* ────────────────────────────────────────────────────────────────────────────
   Notes — wiki links, backlinks, word counts and full-text search.

   A link is `[[Title]]` or `[[Title|shown text]]`, matched case-insensitively
   against a note's file name without `.md`. Links inside fenced code are not
   links: a note documenting the syntax must not grow phantom backlinks.

   PURE. No DOM, no clock.
   ──────────────────────────────────────────────────────────────────────────── */

export interface NoteLike { path: string; name: string; content: string }

export const noteTitle = (name: string): string => name.replace(/\.md$/i, "");

const stripCode = (text: string): string => text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");

/** Distinct link targets in order of first appearance. */
export function extractLinks(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /\[\[([^\[\]|\n]+?)(?:\|[^\[\]\n]*)?\]\]/g;
  for (const m of stripCode(text).matchAll(re)) {
    const t = m[1].trim();
    const k = t.toLowerCase();
    if (t && !seen.has(k)) { seen.add(k); out.push(t); }
  }
  return out;
}

export function resolveLink(title: string, notes: NoteLike[]): NoteLike | null {
  const k = title.trim().toLowerCase();
  return notes.find((n) => noteTitle(n.name).toLowerCase() === k) ?? null;
}

/** Notes that link to `target`, excluding the note itself. */
export function backlinks(target: NoteLike, notes: NoteLike[]): NoteLike[] {
  const k = noteTitle(target.name).toLowerCase();
  return notes.filter((n) => n.path !== target.path && extractLinks(n.content).some((l) => l.toLowerCase() === k));
}

export interface TextStats { words: number; chars: number; lines: number; readingMin: number }

/** Words are runs containing a letter or digit, so "-" and "##" do not count. */
export function textStats(text: string): TextStats {
  const words = text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  return {
    words,
    chars: [...text].length,
    lines: text ? text.split("\n").length : 0,
    readingMin: words === 0 ? 0 : Math.max(1, Math.ceil(words / 200)),
  };
}

export interface SearchHit { path: string; title: string; count: number; snippet: string; inTitle: boolean }

/**
 * Case-insensitive full-text search. Ranked by title hit, then number of
 * matches; each hit carries a snippet around the first body match.
 */
export function searchNotes(notes: NoteLike[], query: string, radius = 36): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: SearchHit[] = [];
  for (const n of notes) {
    const title = noteTitle(n.name);
    const inTitle = title.toLowerCase().includes(q);
    const body = n.content.toLowerCase();
    let count = 0;
    let first = -1;
    for (let i = body.indexOf(q); i !== -1; i = body.indexOf(q, i + q.length)) {
      if (first === -1) first = i;
      count++;
    }
    if (!inTitle && count === 0) continue;
    let snippet = "";
    if (first !== -1) {
      const a = Math.max(0, first - radius);
      const b = Math.min(n.content.length, first + q.length + radius);
      snippet = `${a > 0 ? "..." : ""}${n.content.slice(a, b).replace(/\s+/g, " ")}${b < n.content.length ? "..." : ""}`;
    }
    hits.push({ path: n.path, title, count, snippet, inTitle });
  }
  return hits.sort((x, y) => Number(y.inTitle) - Number(x.inTitle) || y.count - x.count || x.title.localeCompare(y.title));
}

/** Turn `[[Title]]` into plain markdown emphasis for the preview renderer,
 *  which has no notion of wiki links. Unresolved links are marked. */
export function renderWikiLinks(text: string, exists: (title: string) => boolean): string {
  return text.replace(/\[\[([^\[\]|\n]+?)(?:\|([^\[\]\n]*))?\]\]/g, (_m, t: string, shown?: string) => {
    const label = (shown ?? t).trim();
    return exists(t.trim()) ? `**${label}**` : `*${label} (no such note)*`;
  });
}

/** A safe file name for a note title. */
export function noteFileName(title: string): string {
  const clean = title.replace(/[\/\\:*?"<>|\n\r\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return `${clean || "untitled"}.md`;
}
