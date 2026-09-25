/* Provenance for files: who made this, a person or a model?

   A model's write records itself (which agent, which model, when). A later
   write that carries no mark is a person editing it: the original mark stays
   and gains editedAt, so the badge can say "AI-made, edited since" instead of
   either forgetting the model or claiming the model wrote the edit. This is a
   local record, not C2PA: it proves nothing to a third party, and says so. */

export interface Provenance {
  /** The agent or app that wrote it: "AIOS Chat", "DeepSeek Harness", ... */
  by: string;
  model?: string;
  at: number;
  /** A person changed it after the model wrote it. */
  editedAt?: number;
}

export function nextProvenance(prev: Provenance | undefined, incoming: Provenance | undefined, now: number): Provenance | undefined {
  if (incoming) return { by: incoming.by, ...(incoming.model ? { model: incoming.model } : {}), at: incoming.at };
  if (prev) return { ...prev, editedAt: now };
  return undefined;
}

export function provenanceLabel(p: Provenance | undefined): string | null {
  if (!p) return null;
  return `Made by ${p.by}${p.model ? ` (${p.model})` : ""}${p.editedAt ? ", edited since" : ""}`;
}
