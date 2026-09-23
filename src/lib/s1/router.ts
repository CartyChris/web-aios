/* Harness Router: ask a System One decider which harnesses fit a task, then
   merge their outputs into one product. The question design follows
   Switchboard (github.com/ruban-24/switchboard): a noul per candidate, a
   choice for the primary, a score for difficulty, and a low-confidence
   fallback to a safe default. Pure: no DOM, no clock. */

import { parseAnswers } from "./parse";
import type { Answers, Questions } from "./types";

export type HarnessId = "agent_loop" | "react" | "aios_chat" | "system_one" | "direct";
export type OutputShape = "answer" | "file" | "folder" | "zip" | "app";

export const HARNESSES: Record<HarnessId, { name: string; description: string }> = {
  agent_loop: { name: "Agent Loop", description: "Plan, act, verify, learn over several iterations with a judge; best for multi-step deliverables that benefit from self-checking and can produce files." },
  react: { name: "ReAct harness", description: "Tool-using ReAct loop with deterministic tools, live web tools and a definition of done; best for research and fact lookup that needs tools." },
  aios_chat: { name: "AIOS Chat agent", description: "Operates this OS: opens apps, writes notes and files, schedules; best when the task is an action inside the OS." },
  system_one: { name: "System One harness", description: "Picks among enumerable actions with calibrated probabilities and refuses when unsure; best for classification or choosing among fixed options, not for writing text." },
  direct: { name: "Direct answer", description: "One model call, no tools; best for short questions, explanations and small single-file drafts." },
};

export const SHAPES: Record<OutputShape, string> = {
  answer: "A written answer (markdown)",
  file: "A single file",
  folder: "A folder of several files",
  zip: "A downloadable zip archive of several files",
  app: "A runnable single-page web app (index.html plus assets)",
};

export const DIFFICULTY = ["trivial", "easy", "moderate", "hard", "very hard"];

export const fitQ = (id: HarnessId) => `fit__${id}`;

export function routerQuestions(ids: HarnessId[] = Object.keys(HARNESSES) as HarnessId[]): Questions {
  const q: Questions = {};
  for (const id of ids) q[fitQ(id)] = { type: "noul", instructions: `This harness fits the task: ${HARNESSES[id].name}. ${HARNESSES[id].description}` };
  q.primary = { type: "choice", instructions: "Which single harness should lead this task?", criteria: Object.fromEntries(ids.map((id) => [id, HARNESSES[id].description])) };
  q.difficulty = { type: "score", instructions: "How difficult is this task?", criteria: [...DIFFICULTY] };
  q.shape = { type: "choice", instructions: "What shape should the final product take?", criteria: { ...SHAPES } };
  return q;
}

export interface RoutePlan {
  selected: Array<{ id: HarnessId; p: number; primary: boolean }>;
  fits: Record<string, number>;
  primary: { id: HarnessId; p: number };
  difficulty: { level: number; label: string; p: number } | null;
  shape: { shape: OutputShape; p: number };
  fallback: string | null;
  discarded: Record<string, string[]>;
  problems: string[];
  answers: Answers;
}

export interface RouteOptions {
  /** A harness joins the run when its fit clears this. */
  fitThreshold?: number;
  /** Below this, the primary pick is not trusted and "direct" leads. */
  minPrimary?: number;
  maxHarnesses?: number;
  /** Only these may be selected (e.g. drop System One when no env suits). */
  allowed?: HarnessId[];
}

export function planRoute(raw: unknown, questions: Questions, o: RouteOptions = {}): RoutePlan {
  const fitThreshold = o.fitThreshold ?? 0.5;
  const minPrimary = o.minPrimary ?? 0.4;
  const maxHarnesses = o.maxHarnesses ?? 3;
  const allowed = o.allowed ?? (Object.keys(HARNESSES) as HarnessId[]);
  const { answers, discarded, problems } = parseAnswers(raw, questions);

  const fits: Record<string, number> = {};
  for (const id of allowed) { const a = answers[fitQ(id)]; if (a && a.type === "noul") fits[id] = a.p; }

  let fallback: string | null = null;
  const pa = answers.primary;
  let primary: { id: HarnessId; p: number } = { id: "direct", p: 0 };
  if (pa && pa.type === "choice" && allowed.includes(pa.choice as HarnessId)) {
    primary = { id: pa.choice as HarnessId, p: pa.probabilities[pa.choice] ?? 0 };
    if (primary.p < minPrimary) { fallback = `primary ${primary.id} at ${primary.p.toFixed(2)} is under ${minPrimary}; falling back to direct`; primary = { id: "direct", p: primary.p }; }
  } else fallback = "no usable primary answer; falling back to direct";

  const extra = (Object.entries(fits) as Array<[HarnessId, number]>)
    .filter(([id, p]) => id !== primary.id && p >= fitThreshold)
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(0, maxHarnesses - 1));
  const selected = [{ id: primary.id, p: fits[primary.id] ?? primary.p, primary: true }, ...extra.map(([id, p]) => ({ id, p, primary: false }))];

  const d = answers.difficulty;
  const difficulty = d && d.type === "score" ? { level: d.level, label: DIFFICULTY[d.level] ?? String(d.level), p: d.probabilities[d.level] ?? 0 } : null;
  const s = answers.shape;
  const shape = s && s.type === "choice" ? { shape: s.choice as OutputShape, p: s.probabilities[s.choice] ?? 0 } : { shape: "answer" as OutputShape, p: 0 };
  return { selected, fits, primary, difficulty, shape, fallback, discarded, problems, answers };
}

/* ── the combiner ───────────────────────────────────────────────────────── */

export interface HarnessOutput { id: HarnessId; ok: boolean; text: string; files?: Array<{ path: string; content: string }> }

export function combinerSystem(shape: OutputShape): string {
  const files = shape === "answer"
    ? "Write the final answer as markdown. No file markers."
    : [
        "Emit the product as files. Each file is written exactly as:",
        "<<<FILE relative/path.ext>>>",
        "file contents",
        "<<<END>>>",
        shape === "file" ? "Emit exactly ONE file." : shape === "app" ? "Emit a runnable web app: index.html at the root, with any CSS and JS it needs (inline or as sibling files)." : "Emit every file the product needs, including a README.md.",
        "Put nothing outside the file blocks except, optionally, one short summary line first.",
      ].join("\n");
  return [
    "You are the combiner. Several agent harnesses worked on the same task independently.",
    "Merge their outputs into ONE coherent final product: keep what is correct and specific, resolve contradictions (prefer the output with evidence), drop repetition, and fill gaps yourself.",
    "Never mention the harnesses or that outputs were merged.",
    files,
  ].join("\n");
}

export function combinerPrompt(task: string, outputs: HarnessOutput[]): string {
  const parts = outputs.map((o) => {
    const files = (o.files ?? []).map((f) => `--- ${f.path} ---\n${f.content.slice(0, 6_000)}`).join("\n");
    return `## Output from ${HARNESSES[o.id].name}${o.ok ? "" : " (FAILED)"}\n${o.text.slice(0, 12_000)}${files ? `\n\nFiles:\n${files}` : ""}`;
  });
  return `TASK:\n${task}\n\n${parts.join("\n\n")}`;
}

export function parseCombinedFiles(text: string): Array<{ path: string; content: string }> {
  const out: Array<{ path: string; content: string }> = [];
  const re = /<<<FILE\s+([^>\n]+?)\s*>>>\r?\n([\s\S]*?)\r?\n?<<<END>>>/g;
  for (const m of text.matchAll(re)) {
    const path = safePath(m[1]);
    if (path) out.push({ path, content: m[2] });
  }
  return out;
}

/** Relative, forward-slash, no "..": a combiner cannot write outside its folder. */
export function safePath(p: string): string | null {
  const parts = p.trim().replace(/\\/g, "/").split("/").filter((s) => s && s !== ".");
  if (!parts.length || parts.some((s) => s === "..")) return null;
  return parts.join("/");
}

export function slugify(s: string, max = 40): string {
  const slug = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/g, "");
  return slug || "task";
}

export interface SavePlan { writes: Array<{ path: string; content: string }>; zip: { name: string; entries: Array<{ path: string; content: string }> } | null; primaryPath: string }

/** Where the combined product lands in the VFS, by shape. */
export function savePlan(task: string, shape: OutputShape, combined: string): SavePlan {
  const slug = slugify(task);
  const files = parseCombinedFiles(combined);
  if (shape === "answer" || files.length === 0) {
    const path = `/router/${slug}.md`;
    return { writes: [{ path, content: combined }], zip: null, primaryPath: path };
  }
  if (shape === "file") {
    const f = files[0];
    const path = `/router/${slug}/${f.path.split("/").pop()}`;
    return { writes: [{ path, content: f.content }], zip: null, primaryPath: path };
  }
  const writes = files.map((f) => ({ path: `/router/${slug}/${f.path}`, content: f.content }));
  const primary = writes.find((w) => /(^|\/)index\.html$/.test(w.path)) ?? writes.find((w) => /README\.md$/i.test(w.path)) ?? writes[0];
  return { writes, zip: shape === "zip" || shape === "app" ? { name: `${slug}.zip`, entries: files.map((f) => ({ path: `${slug}/${f.path}`, content: f.content })) } : null, primaryPath: primary.path };
}
