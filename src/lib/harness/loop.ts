import type {
  Action,
  DefinitionOfDone,
  FactStore,
  LlmCallRecord,
  LoopConfig,
  RunFlag,
  RunResult,
  RunStatus,
  RunTotals,
  Span,
  SpanRole,
  SpanSink,
  Step,
  StepOutcome,
  ToolContext,
  ToolDef,
  ToolRegistry,
  ToolResult,
  TraceFlag,
  TriggerEvent,
  Usd,
} from "./types";
import { assembleContext } from "./context";
import { dodValidate, evaluateDod, type JudgeFn } from "./dod";
import { checkTrace, endSpan, startSpan } from "./trace";
import { runTool, validateArgs } from "./tools";
import {
  actionVerb,
  availableVerbs,
  buildSystemPrompt,
  buildUserPrompt,
  parseAction,
  renderTranscript,
  splitThoughtAction,
  stopSequences,
} from "./protocol";
import { foldSteps, renderLedger } from "./fold";

/* ────────────────────────────────────────────────────────────────────────────
   The ReAct loop.

   Three properties are load-bearing and easy to lose in a rewrite.

   1. It never throws. Every failure path resolves to a RunResult carrying a
      status, the steps taken and the flags raised. A harness that throws loses
      the trace, and the trace is the only thing that made the failure useful.

   2. Every limit is a field on LoopConfig. How far the agent may go is
      configuration, not code, so no bare number in this file bounds a run. The
      two module constants below bound the loop DETECTOR, not the agent, and
      are named so that the difference stays visible.

   3. The repair call is accounted separately. When a turn cannot be split into
      a thought and an action we pay for a second, action-only completion. That
      is real money; folding it into the first call makes the harness
      under-report its own cost, which is the number the cost dashboard is
      built on.

   And one deliberate refusal: on cap exhaustion the answer is "". A best guess
   emitted at the step cap is how a harness reports a success it did not
   achieve. An empty answer fails the definition of done, which is the truth.
   ──────────────────────────────────────────────────────────────────────────── */

/** Minimum characters of `thought | action` before the loop detector will look
 *  at a step at all.
 *
 *  The floor is on the TEXT length, never on the shingle count. Degenerate,
 *  repetitive output produces very FEW distinct shingles, so a shingle-count
 *  floor would exclude exactly the steps the detector exists to catch — the
 *  guard would move opposite to the thing it guards against. A long repeated
 *  paragraph clears this floor; a two-word step does not, and two two-word
 *  steps are not evidence of anything. */
const LOOP_MIN_TEXT_CHARS = 200;

/** Words per shingle. Word shingles rather than character ones: a JSON
 *  argument's punctuation dominates character n-grams, so two structurally
 *  different calls to the same tool would score as near-identical. */
const SHINGLE_WORDS = 5;

/** Dedupe memo, keyed by TriggerEvent.dedupeKey and stamped with the injected
 *  clock. Module state rather than a dependency, because the check has to work
 *  identically in the browser, in the MCP route and under node --test, and
 *  because the case it exists for is one trigger firing twice on a single
 *  event — not a cross-process one. */
const lastStartByDedupeKey = new Map<string, number>();

export interface LlmRequest {
  system: string;
  prompt: string;
  stop: string[];
  temperature: number;
  maxTokens: number;
  provider: string;
  model: string;
  parentSpanId: string;
  label: string;
  role: SpanRole;
}

export interface LlmResponse {
  text: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: Usd;
  ms: number;
  provider: string;
  model: string;
  spanId: string;
  error?: string;
}

export type LlmFn = (req: LlmRequest) => Promise<LlmResponse>;

export interface LoopDeps {
  llm: LlmFn;
  tools: ToolRegistry;
  facts: FactStore;
  span: SpanSink;
  now: () => number;
  uid: (prefix: string) => string;
  signal: AbortSignal;
  /** USD already committed this run, re-read before every model call. */
  spend: () => Usd;
  /** Asked before a tool whose annotations require approval. Resolves with
   *  the named approver, or null for denial. */
  approve: (tool: ToolDef, args: Record<string, unknown>) => Promise<string | null>;
  fingerprint: string;
}

/* ── Similarity ──────────────────────────────────────────────────────────── */

function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w.length > 0);
}

export function shingles(text: string, n: number = SHINGLE_WORDS): Set<string> {
  const words = normalizeWords(text);
  const out = new Set<string>();
  if (words.length === 0) return out;
  // Shorter than one shingle still has to compare as something, or two
  // identical short steps would score 0 against each other.
  if (words.length < n) {
    out.add(words.join(" "));
    return out;
  }
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(" "));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  return inter / (a.size + b.size - inter);
}

function stepText(s: Step): string {
  return `${s.thought}|${s.action ? s.action.raw : ""}`;
}

/** Compares the newest step against the previous `window` steps. */
export function detectLoop(steps: Step[], threshold: number, window: number): RunFlag | null {
  if (steps.length < 2) return null;
  const last = steps[steps.length - 1];
  if (!last) return null;
  const text = stepText(last);
  if (text.length <= LOOP_MIN_TEXT_CHARS) return null;

  const a = shingles(text);
  const first = Math.max(0, steps.length - 1 - window);
  for (let k = steps.length - 2; k >= first; k--) {
    const prev = steps[k];
    if (!prev) continue;
    const score = jaccard(a, shingles(stepText(prev)));
    if (score > threshold) {
      return {
        code: "loop_detected",
        severity: "warn",
        stepIndex: last.index,
        detail: `step ${last.index} repeats step ${prev.index} (jaccard ${score.toFixed(2)} over ${threshold})`,
      };
    }
  }
  return null;
}

/* ── Canonical arguments ─────────────────────────────────────────────────── */

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v !== null && typeof v === "object") {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = sortValue(src[k]);
    return out;
  }
  return v;
}

/** Sorted keys, all the way down. The per-run tool cache key and the eval
 *  `tool_sequence` both hang off this string being identical for an identical
 *  call, and JSON.stringify preserves insertion order — which is decided by
 *  the model's output, not by us. Arrays keep their order: there, position is
 *  meaning. */
export function canonicalArgs(args: Record<string, unknown>): string {
  return JSON.stringify(sortValue(args));
}

/* ── Run scaffolding ─────────────────────────────────────────────────────── */

function emptyTotals(): RunTotals {
  return {
    steps: 0,
    llmCalls: 0,
    repairCalls: 0,
    toolCalls: 0,
    toolErrors: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    ms: 0,
  };
}

/** checkTrace speaks a different vocabulary from the run flags, and RunFlag's
 *  codes are a closed union in the shared contracts. Only the four with a
 *  run-level equivalent are carried across; the rest stay where they were
 *  computed, on the trace. Mapping a trace flag onto an unrelated run code
 *  would be worse than dropping it — a wrong receipt is not a receipt. */
const TRACE_TO_RUN_FLAG: Partial<Record<TraceFlag["code"], RunFlag["code"]>> = {
  circular: "loop_detected",
  empty_step: "empty_step",
  error_cascade: "tool_error",
  context_drop: "context_truncated",
};

const JUDGE_SYSTEM = `You are grading one answer against one question.
Reply with exactly one line, starting with YES or NO, then one sentence of evidence.
Judge only what the answer says. You are not shown the work that produced it.`;

/** The bracket contents of an action, used only for `finish` when the argument
 *  was JSON without an `answer` field. */
function bracketArgument(raw: string): string {
  const open = raw.indexOf("[");
  const close = raw.lastIndexOf("]");
  return open >= 0 && close > open ? raw.slice(open + 1, close).trim() : "";
}

export async function runReAct(
  objective: string,
  config: LoopConfig,
  dod: DefinitionOfDone,
  trigger: TriggerEvent,
  deps: LoopDeps,
): Promise<RunResult> {
  const startedAt = deps.now();
  const runId = deps.uid("run");
  const spans: Span[] = [];
  const spanAt = new Map<string, number>();
  const flags: RunFlag[] = [];
  const steps: Step[] = [];
  const totals = emptyTotals();
  const cache = new Map<string, ToolResult>();

  const emit = (s: Span): void => {
    const at = spanAt.get(s.id);
    if (at === undefined) {
      spanAt.set(s.id, spans.length);
      spans.push(s);
    } else {
      spans[at] = s;
    }
    deps.span(s);
  };

  const open = (init: {
    parentId: string | null;
    name: string;
    kind: Span["kind"];
    role: SpanRole;
    stepIndex?: number;
    input?: string;
    attrs?: Span["attrs"];
  }): Span => {
    const span = startSpan({ ...init, id: deps.uid("span"), runId, at: deps.now() });
    emit(span);
    return span;
  };

  const close = (span: Span, patch: Partial<Span>): void => {
    emit(endSpan(span, { ...patch, at: deps.now() }));
  };

  const bare = (status: RunStatus, extra: RunFlag[]): RunResult => {
    const at = deps.now();
    return {
      runId,
      configId: config.id,
      agentId: null,
      objective,
      trigger,
      status,
      answer: "",
      steps,
      transcript: renderTranscript(steps),
      spans,
      verdict: null,
      flags: [...flags, ...extra],
      totals: { ...totals, ms: at - startedAt },
      startedAt,
      endedAt: at,
      fingerprint: deps.fingerprint,
    };
  };

  /* 1. Admit the trigger. A duplicate costs nothing here and a whole run a
     moment later, so this happens before the root span is even opened. */
  const priorAt = lastStartByDedupeKey.get(trigger.dedupeKey);
  if (priorAt !== undefined && startedAt - priorAt < config.dedupeMs) {
    return bare("aborted", [
      {
        code: "dedupe_skipped",
        severity: "info",
        stepIndex: 0,
        detail: `dedupeKey ${trigger.dedupeKey} started ${startedAt - priorAt}ms ago, inside ${config.dedupeMs}ms`,
      },
    ]);
  }
  lastStartByDedupeKey.set(trigger.dedupeKey, startedAt);
  for (const [key, at] of lastStartByDedupeKey) {
    if (startedAt - at >= config.dedupeMs) lastStartByDedupeKey.delete(key);
  }

  const root = open({
    parentId: null,
    name: "run",
    kind: "app",
    role: "run",
    input: objective,
    attrs: { runId, configId: config.id, dodId: dod.id, trigger: trigger.kind },
  });

  try {
    /* 2. No run proceeds without a definition of done that can fail. */
    const valid = dodValidate(dod);
    if (!valid.ok) {
      // RunFlag has no code for a rejected DoD and types.ts is shared, so these
      // land as invalid_action at step 0 — the invalid action being the launch
      // request itself — with the actual reason spelled out in the detail.
      const reasons = valid.reasons.map<RunFlag>((r) => ({
        code: "invalid_action",
        severity: "error",
        stepIndex: 0,
        detail: `definition of done rejected: ${r}`,
      }));
      close(root, { error: `definition of done rejected: ${valid.reasons.join("; ")}` });
      return bare("failed", reasons);
    }

    /* 3. The registry for this run. finish must not be in it: it ends the run
       rather than returning an observation, and a registered finish would let
       a DoD's tool_called criterion match on it meaninglessly. */
    if (deps.tools.get("finish") !== undefined) {
      close(root, { error: "finish is registered as a tool" });
      return bare("failed", [
        {
          code: "invalid_action",
          severity: "error",
          stepIndex: 0,
          detail: "finish must not be a registered tool name",
        },
      ]);
    }
    const registered = deps.tools.list();
    const available =
      config.toolNames.length > 0 ? registered.filter((t) => config.toolNames.includes(t.name)) : registered;
    const verbs = availableVerbs(available);

    /* 4. Trusted context, with everything it withheld written down. "Why did
       the agent not see the thing I gave it" is the question that destroys
       trust in a memory, so nothing is dropped silently. */
    const block = assembleContext(deps.facts.all(), { maxChars: config.contextMaxChars, query: objective });
    for (const w of block.withheld) {
      flags.push({
        code: "context_truncated",
        severity: "info",
        stepIndex: 0,
        detail: `${w.id}: ${w.reason} (${w.chars} chars)`,
      });
    }
    const ledger =
      block.withheld.length === 0
        ? "nothing withheld"
        : block.withheld.map((w) => `${w.id}: ${w.reason} (${w.chars} chars)`).join("\n");
    const ctxSpan = open({ parentId: root.id, name: "context", kind: "system", role: "context" });
    close(ctxSpan, {
      text: ledger,
      attrs: { chars: block.chars, included: block.includedIds.length, withheld: block.withheld.length },
    });

    /* 5. Built once. It is the cache prefix; it must not move during the run. */
    const system = buildSystemPrompt(available, config.thoughtDensity, block.stable);

    /* 6. */
    let i = 1;
    let consecutiveToolErrors = 0;
    let repairsUsed = 0;
    let answer = "";
    let status: RunStatus = "running";
    let temperature = config.llm.temperature;
    let loopedLastStep = false;

    const record = (step: Step): void => {
      steps.push(step);
      totals.steps = steps.length;
      totals.costUsd += step.costUsd;
    };

    const llmRecord = (req: LlmRequest, res: LlmResponse): LlmCallRecord => {
      const rec: LlmCallRecord = {
        spanId: res.spanId,
        provider: res.provider,
        model: res.model,
        system: req.system,
        prompt: req.prompt,
        stop: req.stop,
        temperature: req.temperature,
        maxTokens: req.maxTokens,
        output: res.text,
        tokensIn: res.tokensIn,
        tokensOut: res.tokensOut,
        costUsd: res.costUsd,
        ms: res.ms,
        attempt: 1,
      };
      if (res.error !== undefined) rec.error = res.error;
      return rec;
    };

    const callLlm = async (req: LlmRequest, at: number): Promise<LlmResponse> => {
      try {
        return await deps.llm(req);
      } catch (e) {
        return {
          text: "",
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
          ms: deps.now() - at,
          provider: req.provider,
          model: req.model,
          spanId: "",
          error: e instanceof Error ? e.message : String(e),
        };
      }
    };

    /** Loop detection and the resample decision. Returns true when the run must
     *  stop. Shared by the parse-error path and the normal path so a step that
     *  failed to parse still counts toward a repetition — a model stuck
     *  emitting the same malformed turn is the clearest loop there is. */
    const afterStep = (): boolean => {
      const looped = detectLoop(steps, config.loopSimilarity, config.loopWindow);
      if (!looped) {
        loopedLastStep = false;
        temperature = config.llm.temperature;
        return false;
      }
      flags.push(looped);
      // A second consecutive detection ends the run instead of getting hotter.
      // Repetition comes from context pressure far more often than from the
      // sampler, and a hotter retry on an already-degenerate context just
      // spends more to produce the same shape.
      if (config.onLoop === "abort" || loopedLastStep) {
        status = "loop_detected";
        return true;
      }
      loopedLastStep = true;
      temperature = config.resampleTemperature;
      flags.push({
        code: "resampled",
        severity: "info",
        stepIndex: looped.stepIndex,
        detail: `retrying at temperature ${config.resampleTemperature}`,
      });
      return false;
    };

    /* 7. */
    while (i <= config.maxSteps) {
      /* 8. Pre-flight, in this order, each ending the run immediately. */
      if (deps.signal.aborted) {
        status = "aborted";
        break;
      }
      if (deps.now() - startedAt > config.runTimeoutMs) {
        status = "timeout";
        break;
      }
      // Before dispatch, not after: ask()'s own budget stop throws, and a
      // thrown budget error mid-flight loses the step it was thrown from.
      const spent = deps.spend();
      if (spent >= config.maxCostUsd) {
        status = "budget_stopped";
        flags.push({
          code: "budget_stopped",
          severity: "warn",
          stepIndex: i,
          detail: `spend ${spent} reached maxCostUsd ${config.maxCostUsd}`,
        });
        break;
      }

      const stepStart = deps.now();
      const stepSpan = open({ parentId: root.id, name: `step ${i}`, kind: "app", role: "step", stepIndex: i });

      /* 9. Primed with the label, so the model never has to produce it — and
         never gets the index wrong, which would break its own stop sequence.

         Past foldAfterSteps the older steps are folded into a counted ledger
         so a long run stops crowding out the context block it shares a window
         with. Only what the MODEL sees is folded: run.transcript below stays
         complete, because it is the receipt, and the ledger points at it by
         path so the agent can read the detail back with the tools it has. */
      const fold = config.foldAfterSteps > 0 && steps.length > config.foldAfterSteps
        ? foldSteps(steps, { keepRecent: config.foldKeepRecent })
        : null;
      const transcript = fold && fold.foldedCount
        ? `${renderLedger(fold, { artifactPath: `/harness/runs/${runId}.md` })}\n\n${renderTranscript(fold.kept)}`
        : renderTranscript(steps);
      const prompt = buildUserPrompt(objective, transcript, block.volatile, i);

      /* 10. */
      const req: LlmRequest = {
        system,
        prompt,
        stop: stopSequences(i),
        temperature,
        maxTokens: config.llm.maxTokens,
        provider: config.llm.provider,
        model: config.llm.model,
        parentSpanId: stepSpan.id,
        label: `step ${i} · ${config.llm.model}`,
        role: "llm",
      };
      const res = await callLlm(req, stepStart);
      totals.llmCalls += 1;
      totals.tokensIn += res.tokensIn;
      totals.tokensOut += res.tokensOut;
      const call = llmRecord(req, res);

      if (res.error !== undefined) {
        record({
          index: i,
          thought: "",
          action: null,
          parseError: res.error,
          observation: "",
          outcome: "aborted",
          llm: call,
          startedAt: stepStart,
          ms: deps.now() - stepStart,
          costUsd: res.costUsd,
        });
        close(stepSpan, { error: res.error, costUsd: res.costUsd });
        status = "failed";
        break;
      }

      /* 11. */
      const split = splitThoughtAction(res.text, i);
      const thought = split.thought;
      let actionLine = split.ok ? split.action : "";
      let repair: LlmCallRecord | undefined;
      let stepCost = res.costUsd;

      /* 12a. The parse-failure repair path. */
      if (!split.ok && repairsUsed < config.maxRepairsPerRun) {
        const repairReq: LlmRequest = {
          system,
          prompt: `${prompt} ${thought}\nAction ${i}:`,
          stop: ["\n"],
          temperature,
          maxTokens: config.llm.maxTokens,
          provider: config.llm.provider,
          model: config.llm.model,
          parentSpanId: stepSpan.id,
          label: `repair ${i} · ${config.llm.model}`,
          // A separate role, and therefore a separate span. This is real money,
          // and a harness that folds it into the first call under-reports its
          // own cost.
          role: "llm_repair",
        };
        const rres = await callLlm(repairReq, deps.now());
        // Counted whether or not it produced a usable action: it was billed
        // either way, and the budget has to see that.
        repairsUsed += 1;
        totals.repairCalls += 1;
        totals.tokensIn += rres.tokensIn;
        totals.tokensOut += rres.tokensOut;
        stepCost += rres.costUsd;
        repair = llmRecord(repairReq, rres);
        flags.push({
          code: "parse_repair",
          severity: "info",
          stepIndex: i,
          detail: `${split.reason}; asked again for the action only`,
        });
        if (rres.error === undefined && rres.text.trim().length > 0) actionLine = rres.text.trim();
      }

      /* 12b. Still nothing, and no repair budget left to spend on it. */
      if (actionLine.length === 0) {
        const reason = split.ok ? "empty action" : split.reason;
        const observation = `Invalid action: could not read an Action line. Emit exactly: Action ${i}: verb[argument]`;
        flags.push({ code: "invalid_action", severity: "warn", stepIndex: i, detail: reason });
        const step: Step = {
          index: i,
          thought,
          action: null,
          parseError: reason,
          observation,
          outcome: "parse_error",
          llm: call,
          startedAt: stepStart,
          ms: deps.now() - stepStart,
          costUsd: stepCost,
        };
        if (repair) step.repair = repair;
        record(step);
        close(stepSpan, { text: observation, costUsd: stepCost, attrs: { outcome: "parse_error" } });
        if (afterStep()) break;
        i += 1;
        continue;
      }

      /* 13. Grammar. An unknown verb is NOT a parse failure: it is an ordinary
         observation the next thought gets to react to, which is the whole
         recovery mechanism ReAct relies on. */
      const verb = actionVerb(actionLine);
      let action: Action | null = null;
      let outcome: StepOutcome = "acted";
      let observation = "";
      let parseError: string | undefined;

      if (!verbs.includes(verb)) {
        observation = `Invalid action: ${actionLine}. Available: ${verbs.join(", ")}`;
        outcome = "invalid_action";
        flags.push({ code: "invalid_action", severity: "warn", stepIndex: i, detail: `unknown verb "${verb}"` });
        action = { verb, raw: actionLine, args: {} };
      } else {
        const parsed = parseAction(actionLine, available);
        if (!parsed.ok) {
          observation = `Invalid action: ${parsed.reason}. Emit exactly: Action ${i}: verb[argument]`;
          outcome = "parse_error";
          parseError = parsed.reason;
          flags.push({ code: "invalid_action", severity: "warn", stepIndex: i, detail: parsed.reason });
        } else {
          action = parsed.action;
        }
      }

      let toolRecord: Step["tool"] | undefined;
      const act = action;

      if (act !== null && outcome === "acted") {
        if (act.verb === "finish") {
          /* 14. */
          const given = act.args.answer;
          answer = typeof given === "string" ? given : bracketArgument(act.raw);
          outcome = "finished";
          observation = "";
          status = "finished";
        } else if (act.verb === "think") {
          /* 15. "OK." — the shortest constant that still reads as an
             acknowledgement, and it is paid for on every single thought. */
          observation = "OK.";
          outcome = "thought";
        } else {
          const tool = available.find((t) => t.name === act.verb);
          if (!tool) {
            // Reachable only if the registry changed under us mid-run.
            observation = `Invalid action: ${act.verb} is no longer available. Available: ${verbs.join(", ")}`;
            outcome = "invalid_action";
            flags.push({
              code: "invalid_action",
              severity: "warn",
              stepIndex: i,
              detail: `${act.verb} left the registry mid-run`,
            });
          } else {
            /* 16. The approval gate. The agent advises; a named person
               decides. */
            const gated =
              config.approvals === "always" ||
              (config.approvals === "destructive" &&
                (tool.annotations.requiresApproval || tool.annotations.destructive));
            let approvedBy: string | null = null;
            let denied = false;
            if (gated) {
              approvedBy = await deps.approve(tool, act.args);
              if (approvedBy === null) {
                denied = true;
                observation = `Denied by ${config.approvals} approvals policy: ${tool.name} was not run.`;
                outcome = "denied";
                flags.push({
                  code: "approval_required",
                  severity: "info",
                  stepIndex: i,
                  detail: `${tool.name} was denied`,
                });
              }
            }

            if (!denied) {
              /* 17. Our parse before their execution. A schema failure is our
                 reading of the model, not the tool misbehaving, so it never
                 counts toward the tool-error cascade. */
              const checked = validateArgs(tool.inputSchema, act.args);
              if (!checked.ok) {
                observation = `Invalid action: ${checked.error}`;
                outcome = "invalid_action";
                flags.push({ code: "invalid_action", severity: "warn", stepIndex: i, detail: checked.error });
              } else {
                const canon = canonicalArgs(checked.args);
                const toolSpan = open({
                  parentId: stepSpan.id,
                  name: tool.name,
                  kind: "tool",
                  role: "tool",
                  stepIndex: i,
                  input: canon,
                  attrs: approvedBy === null ? { tool: tool.name } : { tool: tool.name, approvedBy },
                });
                const ctx: ToolContext = {
                  runId,
                  stepIndex: i,
                  signal: deps.signal,
                  facts: deps.facts,
                  span: deps.span,
                  parentSpanId: toolSpan.id,
                  now: deps.now,
                  cache,
                };
                const key = `${tool.name}|${canon}`;
                // Only a deterministic tool may be memoised. A tool declared
                // non-deterministic is exactly one whose second call can
                // legitimately differ, so serving it from a memo would
                // fabricate an observation the world never produced.
                const hit = tool.deterministic ? cache.get(key) : undefined;
                const result: ToolResult = hit ? { ...hit, cached: true } : await runTool(tool, checked.args, ctx);
                if (!hit && tool.deterministic && result.status === "ok") cache.set(key, result);

                totals.toolCalls += 1;
                close(toolSpan, {
                  text: result.observation,
                  error: result.status === "ok" ? undefined : result.error,
                  attrs: { tool: tool.name, status: result.status, cached: result.cached === true },
                });
                toolRecord = { spanId: toolSpan.id, tool: tool.name, args: checked.args, result, ms: result.ms };

                /* 18. */
                observation = result.observation;
                if (result.status === "ok") {
                  consecutiveToolErrors = 0;
                  outcome = "acted";
                } else {
                  outcome = "tool_error";
                  totals.toolErrors += 1;
                  consecutiveToolErrors += 1;
                  flags.push({
                    code: "tool_error",
                    severity: "warn",
                    stepIndex: i,
                    detail: `${tool.name}: ${result.error ?? result.status}`,
                  });
                }
              }
            }
          }
        }
      }

      /* 19. */
      const step: Step = {
        index: i,
        thought,
        action,
        observation,
        outcome,
        llm: call,
        startedAt: stepStart,
        ms: deps.now() - stepStart,
        costUsd: stepCost,
      };
      if (parseError !== undefined) step.parseError = parseError;
      if (repair) step.repair = repair;
      if (toolRecord) step.tool = toolRecord;
      record(step);
      close(stepSpan, {
        text: observation,
        costUsd: stepCost,
        tokensIn: res.tokensIn,
        tokensOut: res.tokensOut,
        attrs: { outcome, verb: action ? action.verb : "" },
      });

      if (status === "finished") break;

      if (consecutiveToolErrors >= config.maxToolErrors) {
        status = "tool_error_cascade";
        break;
      }

      /* 20. */
      if (afterStep()) break;

      /* 21. */
      i += 1;
    }

    /* 22. Cap exhaustion. The empty answer is deliberate: it fails the DoD,
       which is the truth. A fabricated best guess here is how a harness
       reports a success it did not achieve. */
    if (status === "running") {
      status = "cap_exhausted";
      answer = "";
      const at = deps.now();
      record({
        index: i,
        thought: "",
        action: { verb: "finish", raw: "finish[]", args: { answer: "" } },
        observation: "",
        outcome: "finished",
        llm: {
          spanId: "",
          provider: config.llm.provider,
          model: config.llm.model,
          system: "",
          prompt: "",
          stop: [],
          temperature: config.llm.temperature,
          maxTokens: config.llm.maxTokens,
          output: "",
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
          ms: 0,
          // attempt 0: nothing was sent. A synthetic step claiming an attempt
          // would inflate the call count the cost dashboard reads.
          attempt: 0,
        },
        startedAt: at,
        ms: 0,
        costUsd: 0,
      });
      flags.push({
        code: "cap_exhausted",
        severity: "warn",
        stepIndex: i,
        detail: `no finish[...] within maxSteps ${config.maxSteps}; the answer is empty on purpose`,
      });
    }

    const run: RunResult = {
      runId,
      configId: config.id,
      agentId: null,
      objective,
      trigger,
      status,
      answer,
      steps,
      transcript: renderTranscript(steps),
      spans,
      verdict: null,
      flags,
      totals: { ...totals, ms: deps.now() - startedAt },
      startedAt,
      endedAt: deps.now(),
      fingerprint: deps.fingerprint,
    };

    /* 23. The judge sees the objective and the answer. Never the plan, the
       thoughts or the transcript: a verifier shown the argument for something
       agrees with it far more often than an independent one. */
    const judge: JudgeFn = async (question, obj, ans) => {
      const jreq: LlmRequest = {
        system: JUDGE_SYSTEM,
        prompt: `Question: ${question}\nObjective: ${obj}\nAnswer: ${ans}`,
        stop: [],
        temperature: config.judge.temperature,
        maxTokens: config.judge.maxTokens,
        provider: config.judge.provider,
        model: config.judge.model,
        parentSpanId: root.id,
        label: `judge · ${config.judge.model}`,
        role: "judge",
      };
      const jres = await callLlm(jreq, deps.now());
      totals.llmCalls += 1;
      totals.tokensIn += jres.tokensIn;
      totals.tokensOut += jres.tokensOut;
      totals.costUsd += jres.costUsd;
      if (jres.error !== undefined) return { met: false, observed: `judge failed: ${jres.error}` };
      const line = jres.text.trim().split("\n")[0]?.trim() ?? "";
      return { met: /^yes\b/i.test(line), observed: line };
    };

    // Three states where grading costs money the run has already been told it
    // does not have, or cannot spend: past the budget ceiling, cancelled, and
    // a dead transport. The fixed criteria still run; only the model call is
    // withheld.
    const useJudge = status !== "budget_stopped" && status !== "aborted" && status !== "failed";
    let verdictError = "";
    try {
      run.verdict = await evaluateDod(dod, run, useJudge ? judge : null);
    } catch (e) {
      run.verdict = null;
      verdictError = `definition of done could not be evaluated: ${e instanceof Error ? e.message : String(e)}`;
    }

    /* 24. */
    run.totals = { ...totals, ms: deps.now() - startedAt };
    run.endedAt = deps.now();
    close(root, {
      text: answer,
      tokensIn: run.totals.tokensIn,
      tokensOut: run.totals.tokensOut,
      costUsd: run.totals.costUsd,
      error: verdictError.length > 0 ? verdictError : undefined,
      attrs: {
        ...root.attrs,
        status,
        steps: run.totals.steps,
        pass: run.verdict ? run.verdict.pass : false,
      },
    });

    // A checker that throws must not destroy the trace it was checking.
    let traceFlags: TraceFlag[] = [];
    try {
      traceFlags = checkTrace(spans, steps, {
        similarity: config.loopSimilarity,
        stepTimeoutMs: config.stepTimeoutMs,
        now: run.endedAt,
      });
    } catch {
      traceFlags = [];
    }
    for (const tf of traceFlags) {
      const code = TRACE_TO_RUN_FLAG[tf.code];
      if (!code) continue;
      if (flags.some((f) => f.code === code)) continue;
      flags.push({ code, severity: tf.severity, stepIndex: 0, detail: `${tf.label}: ${tf.detail}` });
    }
    run.flags = flags;
    return run;
  } catch (e) {
    // runReAct always resolves. Whatever went wrong, the steps taken so far are
    // still the receipt, and losing them is worse than the failure itself.
    const detail = e instanceof Error ? e.message : String(e);
    close(root, { error: detail });
    return bare("failed", [{ code: "invalid_action", severity: "error", stepIndex: 0, detail }]);
  }
}
