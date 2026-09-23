/* The emulated decider: an ordinary chat model asked to answer typed
   questions as JSON probabilities, for when there is no Jev key.

   It is NOT a System One model. Its probabilities are self-reported by a
   language model and are not calibrated the way Jev's are, which is why every
   trace and every screen labels it "emulated". The parser shares
   parseAnswers with the Jev path, so an un-offered option is discarded here
   exactly as it would be there. */

import type { Questions } from "./types";

export const EMULATED_SYSTEM = [
  "You are emulating a System One decision model. You never write prose.",
  "You receive a STATE and a set of typed QUESTIONS. Answer every question in one JSON object:",
  '{"answers": {"<question>": <answer>, ...}}',
  "Answer formats by type:",
  '- noul: {"noul": <probability 0..1 that the statement is true>}',
  '- choice: {"choice": "<one of the listed option keys>", "probabilities": {"<key>": <p>, ...}} over the listed keys ONLY; probabilities sum to 1',
  '- score: {"score": <expected level index>, "probabilities": [<p for level 0>, <p for level 1>, ...]} summing to 1',
  "Use only option keys that are listed. Be honest about uncertainty: spread probability when unsure.",
  "Reply with the JSON object and nothing else.",
].join("\n");

export function buildEmulatedPrompt(state: string, questions: Questions): string {
  const qs = Object.entries(questions).map(([name, q]) => {
    if (q.type === "noul") return `### ${name} (noul)\n${q.instructions}`;
    if (q.type === "choice") return `### ${name} (choice)\n${q.instructions}\nOptions:\n${Object.entries(q.criteria).map(([k, d]) => `  - ${k}: ${d}`).join("\n")}`;
    return `### ${name} (score, ${q.criteria.length} levels)\n${q.instructions}\nLevels:\n${q.criteria.map((d, i) => `  ${i}: ${d}`).join("\n")}`;
  });
  return `STATE:\n${state}\n\nQUESTIONS:\n${qs.join("\n\n")}`;
}

/** Pull the JSON object out of a chat reply: code fences, prose around it,
 *  trailing commas and smart quotes are all tolerated. Returns null when no
 *  object can be recovered, never a guessed one. */
export function parseEmulatedReply(text: string): unknown {
  let s = text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1];
  const start = s.indexOf("{");
  if (start < 0) return null;
  // Walk to the brace that closes the first one, respecting strings.
  let depth = 0, inStr = false, esc = false, endAt = -1;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { endAt = i; break; } }
  }
  const body = s.slice(start, endAt < 0 ? undefined : endAt + 1).replace(/,\s*([}\]])/g, "$1");
  try { return JSON.parse(body); } catch { return null; }
}
