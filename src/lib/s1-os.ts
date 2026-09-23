"use client";

/* Binding the pure System One core (src/lib/s1/) to this OS: the two real
   deciders (Jev over the server relay, and a chat model emulating it), the OS
   itself as an environment, and the Harness Router's runners and combiner. */

import { ask } from "./useAI";
import { runAgentLoop } from "./agent-loop";
import { startRun } from "./harness-runtime";
import { makeZip } from "./zip";
import { useSettings } from "@/kernel/settings";
import { useWM } from "@/kernel/wm";
import { useVFS } from "@/kernel/vfs";
import { useHarness } from "@/kernel/harness";
import { bus } from "@/kernel/bus";
import { trackJob } from "@/kernel/jobs";
import { APPS } from "@/kernel/registry";
import { allThemes } from "@/kernel/customthemes";
import { LAYOUTS } from "./zones";
import { runAiosAgent, aiosChatBusy, aiosChatLastId, aiosChatSince } from "@/shell/AiosChat";
import { toJevRequest, type JevWire } from "./s1/compile";
import { EMULATED_SYSTEM, buildEmulatedPrompt, parseEmulatedReply } from "./s1/emulated";
import { runSystemOne } from "./s1/run";
import { combinerPrompt, combinerSystem, savePlan, HARNESSES, type HarnessId, type HarnessOutput, type OutputShape } from "./s1/router";
import type { ActionSpec, Decider, Environment, Handoff, Risk, RunReport, TraceStep } from "./s1/types";

/** TypeSafe's published input price, used only to ESTIMATE a Jev call's cost
 *  (chars / 4 tokens). Output tokens are free. Traces mark it as an estimate. */
const JEV_USD_PER_M_INPUT = 0.042;

export function jevDecider(key: string, wire: JevWire = "typed"): Decider {
  return {
    kind: "jev",
    label: "Jev (TypeSafe System One)",
    decide: async ({ state, questions }) => {
      const body = toJevRequest(state, questions, wire);
      const payload = JSON.stringify(body);
      const res = await fetch("/api/ai/systemone", { method: "POST", headers: { "content-type": "application/json", "x-api-key": key }, body: payload });
      const text = await res.text();
      let json: unknown = null;
      try { json = JSON.parse(text); } catch { /* reported below */ }
      if (!res.ok) {
        const err = (json as { error?: unknown } | null)?.error;
        throw new Error(`Jev HTTP ${res.status}: ${typeof err === "string" ? err : err ? JSON.stringify(err) : text.slice(0, 300)}`);
      }
      if (!json) throw new Error("Jev returned a body that is not JSON.");
      return { raw: json, model: (json as { model?: string }).model, costUsd: (payload.length / 4) * (JEV_USD_PER_M_INPUT / 1e6), costEstimated: true };
    },
  };
}

export function emulatedDecider(signal?: AbortSignal): Decider {
  const s = useSettings.getState().ai;
  return {
    kind: "emulated",
    label: `Emulated by ${s.model || s.provider}`,
    decide: async ({ state, questions }) => {
      const res = await ask({
        messages: [{ role: "user", content: buildEmulatedPrompt(state, questions) }],
        system: EMULATED_SYSTEM,
        persona: false,
        temperature: 0,
        web: false,
        signal,
        trace: { name: "system-one-emulated", role: "decider" },
      });
      // An unparseable reply becomes an empty map: every question then shows
      // up as a problem and the gate refuses, which is the honest outcome.
      return { raw: parseEmulatedReply(res.text) ?? {}, costUsd: res.costUsd };
    },
  };
}

/* ── the OS as an environment ───────────────────────────────────────────── */

export const OS_ACTIONS: ActionSpec[] = [
  { name: "open_app", description: "Open an app", risk: "write", params: [{ name: "app", kind: "candidates", description: "Which app to open" }] },
  { name: "focus_window", description: "Bring an open window to the front", risk: "read", params: [{ name: "window", kind: "candidates", description: "Which window to focus" }] },
  { name: "close_window", description: "Close an open window (unsaved work in it may be lost)", risk: "destructive", params: [{ name: "window", kind: "candidates", description: "Which window to close" }] },
  { name: "set_theme", description: "Switch the OS colour theme", risk: "write", params: [{ name: "theme", kind: "candidates", description: "Which theme" }] },
  { name: "tile_windows", description: "Arrange the open windows in a layout", risk: "write", params: [{ name: "layout", kind: "choices", description: "Which layout", choices: Object.fromEntries(LAYOUTS.map((l) => [l.id, `${l.name}: ${l.hint}`])) }] },
  { name: "done", description: "Finish: the goal is achieved", risk: "finish" },
];

export function createOsEnv(): Environment {
  return {
    id: "os",
    name: "This OS",
    actions: OS_ACTIONS,
    observe: () => {
      const wm = useWM.getState();
      const wins = wm.windows.filter((w) => w.pinned || w.workspace === wm.activeWorkspace);
      const themeId = useSettings.getState().themeId;
      return {
        text: `${wins.length} window(s) open on workspace ${wm.activeWorkspace + 1}. Theme: ${themeId}.`,
        fields: { windows: wins.map((w) => ({ id: w.id, app: w.appId, title: w.title, state: w.state, focused: w.id === wm.focused })), theme: themeId },
        candidates: {
          app: Object.fromEntries(APPS.map((a) => [a.id, `${a.name}: ${a.description}`])),
          window: Object.fromEntries(wins.map((w) => [w.id, `${w.title} (${w.appId})${w.id === wm.focused ? ", focused" : ""}`])),
          theme: Object.fromEntries(allThemes().map((t) => [t.id, `${t.name}${t.dark ? " (dark)" : " (light)"}`])),
        },
        available: wins.length > 1 ? undefined : OS_ACTIONS.map((a) => a.name).filter((n) => n !== "tile_windows"),
      };
    },
    execute: (action, params) => {
      const wm = useWM.getState();
      switch (action) {
        case "open_app": bus.emit("app:open", { appId: String(params.app) }); return { ok: true, text: `Opened ${String(params.app)}.` };
        case "focus_window": wm.restore(String(params.window)); wm.focus(String(params.window)); return { ok: true, text: `Focused ${String(params.window)}.` };
        case "close_window": wm.close(String(params.window)); return { ok: true, text: `Closed ${String(params.window)}.` };
        case "set_theme": useSettings.getState().applyTheme(String(params.theme)); return { ok: true, text: `Theme set to ${String(params.theme)}.` };
        case "tile_windows": wm.applyLayout(String(params.layout)); return { ok: true, text: `Applied layout ${String(params.layout)}.` };
        case "done": return { ok: true, terminal: true, success: true, text: "The decider judged the goal achieved." };
        default: return { ok: false, text: `Unknown action ${action}.` };
      }
    },
  };
}

/* ── the router's harness runners ───────────────────────────────────────── */

export interface RouterRunDeps {
  signal: AbortSignal;
  decider: Decider;
  thresholds: Record<Risk, number>;
  escalate: (h: Handoff) => Promise<"approve" | "deny">;
  onStep?: (s: TraceStep) => void;
}

async function runOne(id: HarnessId, task: string, d: RouterRunDeps): Promise<HarnessOutput> {
  if (id === "direct") {
    const r = await ask({ messages: [{ role: "user", content: task }], system: "Do the task directly and completely. If it asks for files, give each file's full contents.", persona: false, signal: d.signal, trace: { name: "router-direct", role: "harness" } });
    return { id, ok: true, text: r.text };
  }
  if (id === "agent_loop") {
    const r = await runAgentLoop({ objective: task, maxIters: 3, signal: d.signal });
    return { id, ok: r.final.source !== "fallback", text: `${r.final.text}\n\n(stopped: ${r.stopped}, source: ${r.final.source})`, files: r.final.files };
  }
  if (id === "react") {
    const dod = useHarness.getState().dods[0];
    if (!dod) throw new Error("No definition of done is saved in the Harness app.");
    const r = await startRun({ objective: task, dod, signal: d.signal });
    return { id, ok: r.status === "finished" && !!r.answer, text: r.answer || `(no answer; status ${r.status})` };
  }
  if (id === "aios_chat") {
    if (aiosChatBusy()) throw new Error("AIOS Chat is already running a prompt.");
    const from = aiosChatLastId();
    await runAiosAgent(task);
    const msgs = aiosChatSince(from).filter((m) => m.role !== "user");
    const err = msgs.find((m) => m.role === "error");
    return { id, ok: !err, text: msgs.map((m) => `[${m.role}] ${m.text}`).join("\n") || "(no reply)" };
  }
  // system_one: act on the OS toward the task. It cannot write prose, so its
  // output is what it did.
  const r: RunReport = await runSystemOne({ goal: task, env: createOsEnv(), decider: d.decider, thresholds: d.thresholds, maxSteps: 8, now: () => performance.now(), signal: d.signal, escalate: d.escalate, onStep: d.onStep });
  const lines = r.steps.map((s) => `${s.n}. ${s.decision.action ?? "(none)"} ${JSON.stringify(s.decision.params)} [${s.verdict}, weakest ${s.gate.weakest.p.toFixed(2)}] ${s.env?.text ?? ""}`);
  return { id, ok: r.status === "completed", text: `System One run ${r.status} (${r.reason}).\n${lines.join("\n")}` };
}

/** Run every selected harness as its own live job. Harnesses that only
 *  produce text run in parallel; the two that drive the OS run one after
 *  the other so they cannot fight over the same windows. */
export async function runHarnesses(ids: HarnessId[], task: string, d: RouterRunDeps, onResult: (o: HarnessOutput) => void): Promise<HarnessOutput[]> {
  const wrap = (id: HarnessId) =>
    trackJob({ title: `Router: ${HARNESSES[id].name}`, kind: "agent", detail: task.slice(0, 80), target: { appId: "systemone" } }, () => runOne(id, task, d))
      .catch((e): HarnessOutput => ({ id, ok: false, text: `Failed: ${e instanceof Error ? e.message : String(e)}` }))
      .then((o) => { onResult(o); return o; });
  const parallel = ids.filter((id) => id !== "aios_chat" && id !== "system_one");
  const serial = ids.filter((id) => id === "aios_chat" || id === "system_one");
  const out = await Promise.all(parallel.map(wrap));
  for (const id of serial) { if (d.signal.aborted) break; out.push(await wrap(id)); }
  return out;
}

export async function combineAndSave(task: string, shape: OutputShape, outputs: HarnessOutput[], signal: AbortSignal) {
  const res = await trackJob({ title: "Router: combining", kind: "ai", detail: `${outputs.length} output(s) into ${shape}`, target: { appId: "systemone" } }, () =>
    ask({ messages: [{ role: "user", content: combinerPrompt(task, outputs) }], system: combinerSystem(shape), persona: false, signal, maxTokens: 8000, trace: { name: "router-combiner", role: "combiner" } }),
  );
  const plan = savePlan(task, shape, res.text);
  const vfs = useVFS.getState();
  for (const w of plan.writes) vfs.write(w.path, w.content, { appId: "systemone" });
  bus.emit("notify", { title: "Harness Router finished", body: `Saved ${plan.writes.length} file(s): ${plan.primaryPath}`, kind: "success", target: { appId: "files" } });
  return { text: res.text, costUsd: res.costUsd, plan };
}

/** Store-only on purpose: the bytes are exactly what the tests check
 *  (signatures, CRC-32) and what `unzip -t` accepted. */
export function downloadPlanZip(zip: NonNullable<ReturnType<typeof savePlan>["zip"]>) {
  const bytes = makeZip(zip.entries);
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/zip" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = zip.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
