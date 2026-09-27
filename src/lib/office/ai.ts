/* ────────────────────────────────────────────────────────────────────────────
   AI in the office apps: prompts, and pulling usable output out of replies.

   Every AI action runs on the model the person chose in Settings (their key,
   a local CLI through Bridge, or on-device). Models wrap answers in prose and
   code fences; these extractors take exactly the part the app needs and say
   when there is none, so a chatty reply never lands in a document as if it
   were the edit.

   PURE.
   ──────────────────────────────────────────────────────────────────────────── */

export interface WriterAction { id: string; label: string; instruction: string; needsSelection: boolean }

export const WRITER_ACTIONS: WriterAction[] = [
  { id: "improve", label: "Improve writing", instruction: "Improve the clarity and flow of this text. Keep the meaning, the language and roughly the length.", needsSelection: true },
  { id: "grammar", label: "Fix spelling and grammar", instruction: "Fix spelling, grammar and punctuation only. Change nothing else.", needsSelection: true },
  { id: "shorter", label: "Make shorter", instruction: "Rewrite this to about half the length, keeping every key point.", needsSelection: true },
  { id: "longer", label: "Make longer", instruction: "Expand this with relevant detail and examples, about twice the length.", needsSelection: true },
  { id: "formal", label: "More formal", instruction: "Rewrite this in a formal, professional tone.", needsSelection: true },
  { id: "casual", label: "More casual", instruction: "Rewrite this in a relaxed, friendly tone.", needsSelection: true },
  { id: "bullets", label: "Turn into bullet points", instruction: "Rewrite this as a concise bulleted list in Markdown (- item).", needsSelection: true },
  { id: "summary", label: "Summarize", instruction: "Summarize this in 2-4 sentences.", needsSelection: true },
  { id: "continue", label: "Continue writing", instruction: "Continue this text naturally for one or two more paragraphs, in the same voice. Reply with only the new text.", needsSelection: false },
];

export const TRANSLATE_TO = ["English", "Spanish", "French", "German", "Italian", "Portuguese", "Japanese", "Chinese", "Korean", "Arabic", "Hindi", "Russian"];

export const EDIT_SYSTEM = "You edit documents. Reply with ONLY the edited text: no preamble, no explanation, no quotation marks around it, no code fences. Use Markdown for structure (# headings, - lists, **bold**) only where the input had structure or the instruction asks for it.";

export function writerPrompt(instruction: string, text: string, context = ""): string {
  return `${instruction}\n\n${context ? `Surrounding document (for context only, do not rewrite it):\n"""\n${context.slice(0, 6000)}\n"""\n\n` : ""}Text:\n"""\n${text.slice(0, 24_000)}\n"""`;
}

/** Remove the wrappers models add around an answer: fences, "Here is...:" lead-ins, wrapping quotes. */
export function cleanReply(reply: string): string {
  let s = reply.trim();
  const fence = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(s);
  if (fence) s = fence[1].trim();
  s = s.replace(/^(sure[,!.]?\s*)?(here(?:'s| is) (?:the |your |an? )?(?:edited |revised |improved |rewritten |updated )?(?:text|version|draft|summary|translation)[^:\n]*:\s*\n+)/i, "");
  if (/^["“][\s\S]*["”]$/.test(s) && !/["“”]/.test(s.slice(1, -1))) s = s.slice(1, -1).trim();
  return s;
}

/* ── Sheets ──────────────────────────────────────────────────────────────── */

export const FORMULA_SYSTEM = "You write spreadsheet formulas (Excel/LibreOffice syntax, comma-separated arguments). Reply with ONLY the formula, starting with =. No explanation.";

export function formulaPrompt(request: string, context: string): string {
  return `Write one formula for: ${request}\n\nThe sheet around the target cell (A1 references, first row often headers):\n${context.slice(0, 8000)}`;
}

/** The formula in a reply, or null. Takes the first line that starts with "=" (fences and backticks removed). */
export function extractFormula(reply: string): string | null {
  const s = cleanReply(reply).replace(/`/g, "");
  for (const line of s.split("\n")) {
    const t = line.trim().replace(/^formula:\s*/i, "");
    if (/^=\S/.test(t)) return t.slice(0, 2000);
  }
  return null;
}

export const TABLE_SYSTEM = "You produce tabular data. Reply with ONLY CSV (comma-separated, a header row first, quote fields that contain commas). No explanation, no code fences.";

/** CSV text from a reply that may be fenced or have a sentence before it. */
export function extractCsv(reply: string): string | null {
  const fence = /```(?:csv)?\n([\s\S]*?)\n```/.exec(reply);
  const body = (fence ? fence[1] : reply).trim();
  const lines = body.split(/\r?\n/);
  const first = lines.findIndex((l) => (l.match(/,/g) ?? []).length >= 1);
  if (first < 0) return null;
  const kept = lines.slice(first).filter((l, i) => i === 0 || l.trim() !== "");
  return kept.length >= 2 ? kept.join("\n") : null;
}

/* ── Base ────────────────────────────────────────────────────────────────── */

export const SQL_SYSTEM = "You write SQL SELECT queries for a small in-browser database. Only SELECT. Supported: WHERE with = <> < > <= >= LIKE IN BETWEEN IS NULL AND OR NOT; COUNT SUM AVG MIN MAX; GROUP BY; HAVING; ORDER BY; LIMIT; UPPER LOWER LENGTH ROUND ABS COALESCE SUBSTR YEAR MONTH. Dates are 'YYYY-MM-DD' text. Reply with ONLY the query.";

export function extractSql(reply: string): string | null {
  const fence = /```(?:sql)?\n([\s\S]*?)\n```/i.exec(reply);
  const s = (fence ? fence[1] : reply).trim();
  const m = /\bselect\b[\s\S]*/i.exec(s);
  if (!m) return null;
  // Stop at a blank line followed by prose, or at the end.
  return m[0].split(/\n\s*\n/)[0].trim().replace(/;+\s*$/, "");
}

/* ── Impress ─────────────────────────────────────────────────────────────── */

export const DECK_SYSTEM = `You write slide decks as a Markdown outline and nothing else:
# Deck title
> subtitle
## Slide title
- bullet (at most 5 per slide, short)
  - sub-bullet
Notes: what the speaker says (1-3 sentences)
Use "### Section title" for a section divider and "> quote" alone for a quote slide.`;

export function extractOutline(reply: string): string | null {
  const fence = /```(?:markdown|md)?\n([\s\S]*?)\n```/i.exec(reply);
  const s = (fence ? fence[1] : reply).trim();
  const i = s.search(/^#{1,3}\s/m);
  return i < 0 ? null : s.slice(i);
}

/* ── Draw ────────────────────────────────────────────────────────────────── */

export const DIAGRAM_SYSTEM = `You design diagrams. Reply with ONLY a JSON object:
{"direction":"down","nodes":[{"id":"a","label":"Start","shape":"ellipse"}],"edges":[{"from":"a","to":"b","label":"yes"}]}
shape is one of rect, round, ellipse, diamond (diamond for decisions). Labels short (under 40 characters). At most 30 nodes.`;

/** The first balanced JSON object in a reply, parsed; null if none parses. */
export function extractJson(reply: string): unknown {
  const s = reply.replace(/```(?:json)?/gi, "");
  for (let start = s.indexOf("{"); start >= 0; start = s.indexOf("{", start + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch { break; }
      }
    }
  }
  return null;
}

/* ── Math ────────────────────────────────────────────────────────────────── */

export const LATEX_SYSTEM = "You write mathematical formulas in LaTeX. Reply with ONLY the LaTeX for the formula (no $ signs, no \\[ \\], no explanation).";

export function extractLatex(reply: string): string | null {
  let s = cleanReply(reply);
  const fence = /```(?:latex|tex)?\n([\s\S]*?)\n```/i.exec(reply);
  if (fence) s = fence[1].trim();
  s = s.replace(/^\$\$?|\$\$?$/g, "").replace(/^\\\[|\\\]$/g, "").replace(/^\\\(|\\\)$/g, "").trim();
  return s && s.length < 5000 ? s : null;
}
