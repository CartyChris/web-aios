"use client";

import { bus } from "@/kernel/bus";
import { useVFS } from "@/kernel/vfs";
import { useHarness } from "@/kernel/harness";
import { useTriggers, attemptFrom } from "@/kernel/triggers";
import { useSettings } from "@/kernel/settings";
import { useJobs } from "@/kernel/jobs";
import { registerAiosModule } from "./aios-api";
import { uid } from "./format";
import { createDedupeLedger, decideFire, type DedupeLedger } from "./harness/triggers";
import { DEFAULT_LOOP_CONFIG } from "./harness/config";
import type { TriggerKind } from "./harness/types";

/* ────────────────────────────────────────────────────────────────────────────
   The trigger layer's runtime.

   `lib/harness/triggers.ts` decides whether something should fire. This starts
   the timers, subscribes to the bus, and turns a decision into a run — and it
   is the only file in the pair that can be wrong in a way no unit test sees.

   Three deliberate refusals:

   - It is disarmed until someone arms it. A page that begins spending on model
     calls because it was left open in a background tab is not something you
     can leave open in a background tab.
   - One run at a time. A trigger layer whose handler fires while the last run
     is still going will happily start six, and the budget stop only notices
     after each has already paid for its first call.
   - Every decision is recorded, including the declines. That is the whole
     reason Layer 1 is hard to debug: silence.
   ──────────────────────────────────────────────────────────────────────────── */

const POLL_MS = 20_000;
/** Ceiling on runs started by triggers in one page session. A runaway loop
 *  costs money in a way a runaway render does not. */
const MAX_AUTORUNS = 25;

let ledger: DedupeLedger = createDedupeLedger();
let stopFns: Array<() => void> = [];
let pollTimer: ReturnType<typeof setInterval> | null = null;
let running = false;
let autoruns = 0;

function dedupeMs(): number {
  return DEFAULT_LOOP_CONFIG.dedupeMs;
}

/** Evaluate every trigger of one kind against one signal. */
async function dispatch(kind: TriggerKind, signal: string, payload: unknown) {
  const store = useTriggers.getState();
  if (!store.armed) return;

  const now = Date.now();
  for (const spec of store.triggers) {
    if (spec.kind !== kind) continue;

    const decision = decideFire({ spec, kind, signal, payload, now, dedupeMs: dedupeMs(), ledger });

    // A kind mismatch is filtered above, and a disabled trigger produces one
    // decline per event — which would bury the ledger in noise that says
    // nothing. Everything else is worth writing down.
    if (!decision.fire && (decision.reason === "disabled" || decision.reason === "kind_mismatch")) continue;

    const attempt = attemptFrom(uid("att"), spec.id, now, decision);

    if (!decision.fire) {
      store.recordAttempt(attempt);
      continue;
    }

    if (running) {
      store.recordAttempt({ ...attempt, fired: false, reason: "busy", detail: "Another triggered run is still going." });
      continue;
    }
    if (autoruns >= MAX_AUTORUNS) {
      store.recordAttempt({ ...attempt, fired: false, reason: "capped", detail: `This session has already started ${MAX_AUTORUNS} triggered runs.` });
      continue;
    }

    const dod = useHarness.getState().dods.find((d) => d.id === spec.dodId) ?? useHarness.getState().dods[0];
    if (!dod) {
      store.recordAttempt({ ...attempt, fired: false, reason: "invalid", detail: `No definition of done with id ${spec.dodId}.` });
      continue;
    }

    // Counters commit BEFORE the await. A second event arriving while the
    // first run is in flight must see `running` already true.
    running = true;
    autoruns += 1;
    store.markFired(spec.id, now);
    store.recordAttempt(attempt);

    // An automated run is exactly the work a user cannot otherwise see: it
    // started without them. It gets a live job that leads to the Harness.
    const jobId = useJobs.getState().start({ kind: "task", title: `Automation: ${spec.kind}${spec.match ? ` ${spec.match}` : ""}`, detail: decision.objective.slice(0, 120), target: { appId: "harness" } });
    try {
      // Loaded on the first fire, not at boot: the runtime pulls in the whole
      // harness (tools, loop, fixtures, trace, services), about a third of the
      // shell's startup JavaScript, and most sessions never fire a trigger.
      const [{ startRun }, { runPassed }] = await Promise.all([import("./harness-runtime"), import("./harness/passed")]);
      const result = await startRun({
        objective: decision.objective,
        dod,
        trigger: { triggerId: spec.id, kind, payload, dedupeKey: decision.event.dedupeKey },
      });
      // The verdict, not the status: "finished" is the model's own claim.
      const judged = runPassed(result);
      useJobs.getState().finish(jobId, judged.pass ? "done" : "error", `${judged.why} · ${result.totals.steps} steps`);
      store.recordAttempt({
        ...attempt,
        id: uid("att"),
        reason: "completed",
        detail: `${result.status} · ${result.totals.steps} steps · $${result.totals.costUsd.toFixed(4)}`,
        runId: result.runId,
      });
    } catch (e) {
      useJobs.getState().finish(jobId, "error", e instanceof Error ? e.message : "The run threw.");
      store.recordAttempt({
        ...attempt,
        id: uid("att"),
        fired: false,
        reason: "threw",
        detail: e instanceof Error ? e.message : "The run threw.",
      });
    } finally {
      running = false;
    }
  }
}

/** Start listening. Idempotent: calling it twice does not double-subscribe,
 *  which in a React StrictMode double-mount would otherwise fire everything
 *  twice and make the dedupe ledger look like the bug. */
export function startTriggerRuntime(): () => void {
  stopTriggerRuntime();

  stopFns.push(
    bus.on("*", (payload) => {
      const wrapped = payload as { event?: string; payload?: unknown } | undefined;
      const name = wrapped?.event;
      // `span` fires on every model call inside a triggered run. Letting a
      // trigger listen for it is a loop that funds itself.
      if (!name || name === "span" || name.startsWith("trigger:")) return;
      void dispatch("event", name, wrapped?.payload);
    }),
  );

  stopFns.push(
    bus.on("vfs:write", (payload) => {
      const path = (payload as { path?: string } | undefined)?.path;
      if (typeof path === "string") void dispatch("file", path, payload);
    }),
  );

  pollTimer = setInterval(() => {
    void dispatch("schedule", "", {});
  }, POLL_MS);

  return stopTriggerRuntime;
}

export function stopTriggerRuntime() {
  for (const off of stopFns) off();
  stopFns = [];
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** Fire a trigger by hand, ignoring its schedule but not its dedupe window —
 *  which is what makes "Test" a real test rather than a different code path. */
export async function fireNow(triggerId: string, payload: unknown = {}) {
  const spec = useTriggers.getState().triggers.find((t) => t.id === triggerId);
  if (!spec) return;
  await dispatch(spec.kind, spec.kind === "file" ? String((payload as { path?: string }).path ?? spec.match) : spec.match, payload);
}

export function installTriggers() {
  registerAiosModule("triggers", {
    start: startTriggerRuntime,
    stop: stopTriggerRuntime,
    fireNow,
    list: () => useTriggers.getState().triggers,
    attempts: () => useTriggers.getState().attempts,
    // Exposed so a test can prove the ledger is actually wired in: a dedupe
    // that has never suppressed anything is indistinguishable from one that is
    // not connected.
    suppressed: () => ledger.suppressed(),
    reset: () => {
      ledger = createDedupeLedger();
      autoruns = 0;
      running = false;
    },
    state: () => ({ armed: useTriggers.getState().armed, running, autoruns, maxAutoruns: MAX_AUTORUNS, spentUsd: useSettings.getState().ai.spentUsd }),
  });
}

/** The VFS does not publish writes, so nothing would ever reach a file
 *  trigger. Wrapping the store's write is how the signal gets onto the bus
 *  without every caller having to remember to emit one. */
export function instrumentVfs() {
  const store = useVFS.getState();
  const original = store.write;
  if ((original as { __instrumented?: boolean }).__instrumented) return;

  const wrapped = ((path: string, content: string, meta?: Parameters<typeof original>[2]) => {
    const node = original(path, content, meta);
    // Harness receipts are themselves VFS writes. A file trigger watching
    // /harness would fire on its own trace and never stop.
    if (!path.startsWith("/harness/")) bus.emit("vfs:write", { path, appId: meta?.appId });
    return node;
  }) as typeof original;
  (wrapped as { __instrumented?: boolean }).__instrumented = true;

  useVFS.setState({ write: wrapped });
}
