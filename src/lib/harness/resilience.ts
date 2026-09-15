/* ────────────────────────────────────────────────────────────────────────────
   Failure handling.

   The load-bearing decision is that the circuit breaker sits OUTSIDE the retry
   loop. Retry-inside-breaker is the common shape and it is wrong: one logical
   call against a dead provider becomes N attempts, the breaker records N
   failures, and a threshold of 3 trips on a single flaky call. One logical
   call is one vote, whatever it cost internally.

   The second is that Retry-After is a FLOOR, not a suggestion. A jittered
   backoff that undercuts the header simply earns a second 429 and burns the
   retry budget proving the server meant it.

   The third is that repairJson only ever fixes SYNTAX. It never invents a
   field, and when it cannot parse the text it says so and names every rung it
   tried, because a harness that quietly substitutes a plausible object turns a
   visible parse failure into an invisible wrong answer.
   ──────────────────────────────────────────────────────────────────────────── */

export type ErrorKind =
  | "auth" | "rate_limit" | "server" | "network" | "timeout" | "context"
  | "bad_request" | "refusal" | "abort" | "parse" | "unknown";

export interface Classification {
  kind: ErrorKind;
  retryable: boolean;
  /** Names the constraint AND the way forward; it is shown to a person. */
  blurb: string;
}

/** A Retry-After longer than a step timeout is not a delay, it is a failure.
 *  Honouring 600s verbatim converts one rate limit into a dead run, so the
 *  parsed value is clamped and the retry budget is allowed to exhaust instead. */
export const RETRY_AFTER_MAX_MS = 60_000;

/** These never count against the breaker. A 400 is our bug, a refusal is the
 *  model's policy and a context overflow is our prompt: none of them is
 *  evidence that the provider is down, and opening the circuit on them takes a
 *  healthy provider offline for every other run in the process.
 *  `abort` is here for the same reason — the user cancelled, the provider did
 *  nothing wrong. (The spec named the first three; abort follows identically.) */
const BREAKER_IGNORED: ReadonlySet<ErrorKind> = new Set<ErrorKind>(["bad_request", "context", "refusal", "abort"]);

export function classifyError(message: string, status?: number): Classification {
  const m = (message ?? "").toLowerCase();

  // Message patterns that must beat the status code. A 400 carrying
  // "context_length_exceeded" is a context problem, and retrying it as a
  // generic bad request wastes the whole retry budget on a certainty.
  if (/\babort/.test(m) || /cancell?ed/.test(m) || m.includes("aborterror")) {
    return { kind: "abort", retryable: false, blurb: "The call was cancelled. Nothing was retried; start it again when you are ready." };
  }
  if (/context[_ ]length|maximum context|too many tokens|context window|prompt is too long/.test(m)) {
    return { kind: "context", retryable: false, blurb: "The prompt exceeded the model's context. Cut the trusted-context budget or the transcript; retrying sends the same oversized prompt." };
  }
  if (/refus|cannot assist|can't assist|content policy|safety system|violates/.test(m)) {
    return { kind: "refusal", retryable: false, blurb: "The model refused. Change the request or route it to a different model; a retry gets the same refusal." };
  }

  if (typeof status === "number" && status > 0) {
    if (status === 401 || status === 403) {
      return { kind: "auth", retryable: false, blurb: `HTTP ${status}: the key was rejected. Check the provider key in Settings; retrying cannot fix credentials.` };
    }
    if (status === 429) {
      return { kind: "rate_limit", retryable: true, blurb: "HTTP 429: rate limited. Backing off, honouring Retry-After as a floor." };
    }
    if (status === 408 || status === 504) {
      return { kind: "timeout", retryable: true, blurb: `HTTP ${status}: the provider timed out. Retrying with backoff.` };
    }
    if (status >= 500) {
      return { kind: "server", retryable: true, blurb: `HTTP ${status}: the provider failed. Retrying with backoff.` };
    }
    if (status === 400 || status === 404 || status === 405 || status === 409 || status === 422) {
      return { kind: "bad_request", retryable: false, blurb: `HTTP ${status}: the request was malformed. This is ours to fix, not the provider's; it is not retried and does not count against the circuit breaker.` };
    }
  }

  if (/timed? ?out|etimedout|deadline exceeded/.test(m)) {
    return { kind: "timeout", retryable: true, blurb: "The call timed out. Retrying with backoff." };
  }
  if (/network|fetch failed|failed to fetch|enotfound|econnrefused|econnreset|socket hang up|dns|offline/.test(m)) {
    return { kind: "network", retryable: true, blurb: "The network call did not complete. Retrying with backoff; check connectivity if it persists." };
  }
  if (/rate limit|too many requests|quota/.test(m)) {
    return { kind: "rate_limit", retryable: true, blurb: "Rate limited. Backing off, honouring Retry-After as a floor." };
  }
  if (/unauthorized|invalid api key|authentication/.test(m)) {
    return { kind: "auth", retryable: false, blurb: "The key was rejected. Check the provider key in Settings; retrying cannot fix credentials." };
  }
  if (/json|unexpected token|unexpected end of|parse/.test(m)) {
    return { kind: "parse", retryable: false, blurb: "The response could not be parsed. Repair the text or re-ask with a stricter format; a blind retry usually returns the same shape." };
  }

  // Deliberately NOT retryable. An error nobody has classified is as likely to
  // be deterministic as transient, and retrying it spends real money proving
  // that. If this kind shows up in traces, add a rule above for it.
  return { kind: "unknown", retryable: false, blurb: `Unclassified failure: ${message || "(no message)"}. Not retried, because an unnamed error is as likely deterministic as transient.` };
}

/** Accepts both Retry-After forms: delta-seconds and an HTTP date. */
export function parseRetryAfter(header: string | null, now: number): number {
  if (header === null) return 0;
  const raw = header.trim();
  if (raw === "") return 0;

  if (/^\d+(\.\d+)?$/.test(raw)) {
    const ms = Number(raw) * 1000;
    return Math.min(RETRY_AFTER_MAX_MS, Math.max(0, ms));
  }

  const at = Date.parse(raw);
  if (Number.isNaN(at)) return 0;
  return Math.min(RETRY_AFTER_MAX_MS, Math.max(0, at - now));
}

/** Full jitter: a uniform draw from [0, ceiling), not "ceiling minus a bit".
 *  Equal-jitter schemes leave every client in a thundering herd synchronised
 *  on the same lower bound, which is the problem backoff exists to solve.
 *  `capMs` caps the JITTER CEILING only — never the Retry-After floor, because
 *  a floor a client is free to ignore is not a floor. */
export function backoffDelay(attempt: number, baseMs: number, capMs: number, retryAfterMs: number, rand: () => number): number {
  const n = Math.max(1, Math.floor(attempt));
  const ceiling = Math.min(Math.max(0, capMs), Math.max(0, baseMs) * 2 ** (n - 1));
  const jittered = rand() * ceiling;
  return Math.max(jittered, Math.max(0, retryAfterMs));
}

export type BreakerState = "closed" | "open" | "half_open";

export interface Breaker {
  /** Has a side effect in half_open: it claims the single probe slot. */
  allow: () => boolean;
  onSuccess: () => void;
  onFailure: (kind: ErrorKind) => void;
  state: () => BreakerState;
}

export class CircuitOpenError extends Error {
  readonly kind = "circuit_open";
  constructor(message: string) {
    super(message);
    this.name = "CircuitOpenError";
  }
}

export function createBreaker(opts: { threshold: number; cooldownMs: number; now: () => number }): Breaker {
  // A threshold of 0 would open the circuit before a single failure, which is
  // the guard whose limit moves opposite to the case it exists to catch.
  const threshold = Math.max(1, Math.floor(opts.threshold));
  const cooldownMs = Math.max(0, opts.cooldownMs);

  let state: BreakerState = "closed";
  let failures = 0;
  let openedAt = 0;
  let probeInFlight = false;

  const allow = (): boolean => {
    if (state === "open") {
      if (opts.now() - openedAt >= cooldownMs) {
        state = "half_open";
        probeInFlight = false;
      } else {
        return false;
      }
    }
    if (state === "half_open") {
      // Exactly one probe. Letting the whole backlog through on the first tick
      // of the cooldown is how a half-open breaker re-kills a recovering
      // provider the instant it comes back.
      if (probeInFlight) return false;
      probeInFlight = true;
      return true;
    }
    return true;
  };

  const onSuccess = (): void => {
    failures = 0;
    probeInFlight = false;
    state = "closed";
  };

  const onFailure = (kind: ErrorKind): void => {
    probeInFlight = false;
    if (BREAKER_IGNORED.has(kind)) return;
    failures += 1;
    if (state === "half_open") {
      state = "open";
      openedAt = opts.now();
      return;
    }
    if (failures >= threshold) {
      state = "open";
      openedAt = opts.now();
    }
  };

  return { allow, onSuccess, onFailure, state: () => state };
}

function retryAfterOf(e: unknown): number {
  if (e !== null && typeof e === "object" && "retryAfterMs" in e) {
    const v = (e as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  return 0;
}

export interface ResilientOptions {
  /** Extra attempts after the first. `retries: 2` means up to 3 calls. */
  retries: number;
  baseMs: number;
  capMs: number;
  rand: () => number;
  sleep: (ms: number) => Promise<void>;
  classify: (e: unknown) => Classification;
}

export async function resilientCall<T>(breaker: Breaker, fn: (attempt: number) => Promise<T>, o: ResilientOptions): Promise<T> {
  if (!breaker.allow()) {
    throw new CircuitOpenError(`circuit ${breaker.state()}: the provider is failing, so this call was not attempted. It will be retried after the cooldown.`);
  }

  const maxAttempts = Math.max(1, Math.floor(o.retries) + 1);
  for (let attempt = 1; ; attempt++) {
    try {
      const value = await fn(attempt);
      breaker.onSuccess();
      return value;
    } catch (e) {
      const c = o.classify(e);
      if (!c.retryable || attempt >= maxAttempts) {
        // Exactly one vote per logical call, whatever it cost inside.
        breaker.onFailure(c.kind);
        throw e;
      }
      await o.sleep(backoffDelay(attempt, o.baseMs, o.capMs, retryAfterOf(e), o.rand));
    }
  }
}

/* ── repairJson ──────────────────────────────────────────────────────────── */

export const REPAIR_RUNGS = ["as-is", "strip-fence", "trim-prose", "drop-trailing-commas", "close-truncated"] as const;
export type RepairRung = (typeof REPAIR_RUNGS)[number];

export type RepairResult =
  | { ok: true; value: unknown; rung: RepairRung }
  | { ok: false; tried: string[]; note: string };

function tryParse(s: string): { ok: true; value: unknown } | { ok: false; note: string } {
  try {
    return { ok: true, value: JSON.parse(s) as unknown };
  } catch (e) {
    return { ok: false, note: e instanceof Error ? e.message : String(e) };
  }
}

function stripFence(s: string): string {
  const closed = /```(?:json|JSON)?[ \t]*\r?\n?([\s\S]*?)```/.exec(s);
  if (closed && closed[1] !== undefined) return closed[1].trim();
  // An unterminated fence still hides the payload; a truncated response ends
  // mid-object with no closing fence far more often than not.
  const open = /```(?:json|JSON)?[ \t]*\r?\n?/.exec(s);
  if (open) return s.slice(open.index + open[0].length).trim();
  return s;
}

function trimProse(s: string): string {
  const candidates: Array<{ at: number; text: string }> = [];
  const oi = s.indexOf("{");
  if (oi >= 0) {
    // lastIndexOf, not indexOf: a } inside a nested object breaks a first-match slice.
    const ci = s.lastIndexOf("}");
    candidates.push({ at: oi, text: ci > oi ? s.slice(oi, ci + 1) : s.slice(oi) });
  }
  const ai = s.indexOf("[");
  if (ai >= 0) {
    const ac = s.lastIndexOf("]");
    candidates.push({ at: ai, text: ac > ai ? s.slice(ai, ac + 1) : s.slice(ai) });
  }
  if (candidates.length === 0) return s;

  // Prefer the LONGEST candidate that parses. Preferring the earliest opener
  // makes "Note [1]: {...}" return [1] — syntactically valid, semantically the
  // wrong object, and silent about it.
  const parsing = candidates.filter((c) => tryParse(c.text).ok).sort((a, b) => b.text.length - a.text.length || a.at - b.at);
  if (parsing.length > 0) return parsing[0]!.text;
  return [...candidates].sort((a, b) => a.at - b.at)[0]!.text;
}

function dropTrailingCommas(s: string): string {
  return s.replace(/,(\s*[}\]])/g, "$1");
}

function closeTruncated(s: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of s) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }

  let out = s;
  // A dangling backslash would turn the quote we are about to append into an
  // escape and leave the string open again.
  if (escaped) out = out.slice(0, -1);
  if (inString) out += '"';
  out = out.replace(/\s+$/, "");

  // A dangling separator cannot be closed, only removed: `{"a":1,"b":` has a
  // key with no value, and appending `}` yields invalid JSON, not a fix.
  for (;;) {
    const before = out;
    out = out.replace(/,\s*$/, "");
    if (/:\s*$/.test(out)) out = out.replace(/\s*"(?:[^"\\]|\\.)*"\s*:\s*$/, "");
    out = out.replace(/\s+$/, "");
    if (out === before) break;
  }

  return out + stack.reverse().join("");
}

export function repairJson(text: string): RepairResult {
  const tried: string[] = [];
  let candidate = typeof text === "string" ? text : "";
  let note = "empty input";

  const rungs: Array<[RepairRung, (s: string) => string]> = [
    ["as-is", (s) => s],
    ["strip-fence", stripFence],
    ["trim-prose", trimProse],
    ["drop-trailing-commas", dropTrailingCommas],
    ["close-truncated", closeTruncated],
  ];

  for (const [name, fix] of rungs) {
    tried.push(name);
    candidate = fix(candidate);
    const r = tryParse(candidate);
    if (r.ok) return { ok: true, value: r.value, rung: name };
    note = r.note;
  }

  return {
    ok: false,
    tried,
    note: `no syntax repair produced valid JSON; last parser error: ${note}`,
  };
}
