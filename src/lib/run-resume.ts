/* Resumable multi-step runs (Deep Work stages, Atlas source batches) — pure.

   A run is resumable when its state is persisted per step and the next step to
   do can be derived from that state alone. A step left "active" after a
   reload was interrupted mid-flight: its partial output is not trustworthy, so
   it is redone rather than skipped. */

export type StepStatus = "pending" | "active" | "ready" | "verified" | "blocked" | "invalidated";

/** Steps still to run, in order: everything not ready/verified. */
export function remainingSteps<T extends { id: string; status: StepStatus }>(steps: T[], includeBlocked = true): T[] {
  return steps.filter((s) => s.status !== "ready" && s.status !== "verified" && (includeBlocked || s.status !== "blocked"));
}

/** Progress as done/total with a 0..1 fraction; total 0 gives null, not NaN. */
export function stepProgress(steps: Array<{ status: StepStatus }>): { done: number; total: number; fraction: number | null } {
  const total = steps.length;
  const done = steps.filter((s) => s.status === "ready" || s.status === "verified").length;
  return { done, total, fraction: total ? done / total : null };
}

/** After a reload no promise is in flight, so an "active" step was interrupted. */
export function markInterrupted<T extends { status: StepStatus }>(steps: T[]): { steps: T[]; interrupted: number } {
  let interrupted = 0;
  const out = steps.map((s) => {
    if (s.status !== "active") return s;
    interrupted++;
    return { ...s, status: "pending" as StepStatus };
  });
  return { steps: out, interrupted };
}

/**
 * Split pasted text into URLs to fetch: one per line or whitespace, http(s)
 * only, deduplicated against each other and against those already present.
 */
export function parseUrlBatch(text: string, existing: string[] = [], cap = 25): string[] {
  const have = new Set(existing);
  const out: string[] = [];
  for (const tok of text.split(/\s+/)) {
    const t = tok.trim().replace(/[),.;]+$/, "");
    if (!/^https?:\/\/[^\s]+$/i.test(t) || have.has(t)) continue;
    have.add(t);
    out.push(t);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Rows to RFC 4180 CSV. A field is quoted when it holds a comma, quote, CR or
 * LF, and quotes are doubled. A field starting with = + - @ is prefixed with a
 * quote mark so a spreadsheet does not run it as a formula (CSV injection).
 */
export function toCsv(header: string[], rows: Array<Array<string | number | undefined>>): string {
  const cell = (v: string | number | undefined): string => {
    let s = v === undefined ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
}
