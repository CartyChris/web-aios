/* The decisions the Agent Loop makes that do not need a model, pulled out so
   they can be tested: which attempt is the result, what files it contains,
   and whether the price cap allows another step.

   The rule this module exists to enforce is that a loop always ends with a
   result. A run that spent money and returned nothing is the worst outcome
   available, worse than an honest partial one, so every path below ends in
   text and says how much to trust it. Pure: no DOM, no clock, no randomness. */

export interface PolicyIteration {
  n: number;
  plan: string;
  action: string;
  verdict: { pass: boolean; reason: string } | null;
}

export interface ExtractedFile {
  path: string;
  content: string;
}

const LANG_FILE: Record<string, string> = {
  html: "index.html", htm: "index.html", css: "styles.css", js: "main.js", javascript: "main.js",
  jsx: "App.jsx", ts: "main.ts", typescript: "main.ts", tsx: "App.tsx", py: "main.py", python: "main.py",
  json: "data.json", md: "README.md", markdown: "README.md", sh: "run.sh", bash: "run.sh", sql: "query.sql",
  rs: "main.rs", rust: "main.rs", go: "main.go", java: "Main.java", c: "main.c", cpp: "main.cpp", svg: "image.svg",
  yaml: "config.yaml", yml: "config.yaml", toml: "config.toml", glsl: "shader.glsl", txt: "notes.txt",
};

/** A file name the model put near the block: `index.html`, "File: game.js",
 *  "### src/app.ts", or a title="…" on the fence itself. */
function nameHint(info: string, before: string): string | null {
  const t = info.match(/(?:title|file(?:name)?)\s*=\s*["']?([\w./-]+\.\w+)/i);
  if (t) return t[1];
  const inline = info.trim().split(/\s+/)[1];
  if (inline && /^[\w./-]+\.\w+$/.test(inline)) return inline;
  const lastLine = before.trimEnd().split("\n").pop() ?? "";
  const m = lastLine.match(/([\w./-]+\.[A-Za-z0-9]{1,6})\b/);
  return m && lastLine.length < 160 ? m[1] : null;
}

const safePath = (p: string) => p.replace(/^[./]+/, "").replace(/\.\.+/g, ".").replace(/[^\w./-]/g, "_") || "file.txt";

/** Every fenced code block, as a file. Names come from hints near the block,
 *  then from the language, and collisions get a numeric suffix rather than
 *  silently overwriting an earlier block. */
export function extractFiles(text: string): ExtractedFile[] {
  const out: ExtractedFile[] = [];
  const used = new Map<string, number>();
  const re = /```([^\n`]*)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const info = m[1] ?? "";
    const body = m[2] ?? "";
    if (!body.trim()) continue;
    const lang = info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    const hinted = nameHint(info, text.slice(Math.max(0, m.index - 200), m.index));
    let path = safePath(hinted ?? LANG_FILE[lang] ?? (looksLikeHtml(body) ? "index.html" : "snippet.txt"));
    const seen = used.get(path) ?? 0;
    used.set(path, seen + 1);
    if (seen > 0) path = path.replace(/(\.[^.]+)?$/, (ext) => `-${seen + 1}${ext}`);
    out.push({ path, content: body.replace(/\n$/, "") });
  }
  // A bare HTML document with no fence is still a file, and the most common
  // shape for "make me a single-file game".
  if (out.length === 0 && looksLikeHtml(text)) {
    const start = text.search(/<!doctype html|<html[\s>]/i);
    const end = text.search(/<\/html>/i);
    out.push({ path: "index.html", content: text.slice(start, end > start ? end + 7 : undefined).trim() });
  }
  return out;
}

export function looksLikeHtml(text: string): boolean {
  return /<!doctype html|<html[\s>]/i.test(text);
}

export const isEmptyResult = (text: string | null | undefined): boolean => !text || text.trim().length === 0;

/** How much of an attempt is substance: code counts double, because an
 *  objective that asks for an artifact is served by the artifact, not by
 *  prose about it. */
export function substance(text: string): number {
  if (isEmptyResult(text)) return 0;
  const code = extractFiles(text).reduce((a, f) => a + f.content.length, 0);
  return text.trim().length + code;
}

/** The result of a run that has not yet had a final pass: the last verified
 *  attempt if any passed, otherwise the most substantial one. Null only when
 *  every attempt was empty, which is the caller's cue to spend one more call. */
export function pickResult(its: PolicyIteration[]): { text: string; n: number; source: "verified" | "best-attempt" } | null {
  for (let i = its.length - 1; i >= 0; i--) {
    if (its[i].verdict?.pass && !isEmptyResult(its[i].action)) return { text: its[i].action, n: its[i].n, source: "verified" };
  }
  // An attempt that contains a file outranks any that only talk: the
  // artifact is what was asked for. Within a tier, more substance wins.
  const rank = (t: string) => (extractFiles(t).length > 0 ? 1e12 : 0) + substance(t);
  let best: PolicyIteration | null = null;
  for (const it of its) if (rank(it.action) > (best ? rank(best.action) : 0)) best = it;
  return best ? { text: best.action, n: best.n, source: "best-attempt" } : null;
}

/** Whether another model call fits under the price the user set. `estimate`
 *  is what the next step is expected to cost, from what earlier steps cost. */
export function withinCap(spentUsd: number, capUsd: number | undefined, estimateUsd: number): boolean {
  if (!capUsd || capUsd <= 0) return true;
  return spentUsd + Math.max(0, estimateUsd) <= capUsd;
}

/** Expected cost of the next iteration: the mean of the ones so far, or a
 *  small prior before there are any. */
export function nextIterationEstimate(costs: number[], prior = 0.005): number {
  const real = costs.filter((c) => Number.isFinite(c) && c > 0);
  return real.length ? real.reduce((a, c) => a + c, 0) / real.length : prior;
}

/** Last resort when no model produced anything: an honest report built from
 *  what the loop did establish. It is a result, labelled as a fallback, never
 *  passed off as the artifact. */
export function fallbackReport(objective: string, its: PolicyIteration[], why: string): string {
  const lines = [
    `# No artifact was produced`,
    "",
    `**Objective:** ${objective}`,
    "",
    `**Why:** ${why}`,
    "",
    `## What each attempt planned`,
    ...its.map((it) => `${it.n}. ${it.plan.trim() || "(no plan)"}${it.verdict ? `\n   - Verifier: ${it.verdict.reason}` : ""}`),
    "",
    `## To get a result next time`,
    `- Raise the price cap, or pick a model that answers without long hidden reasoning for the act step.`,
    `- Set a separate judge model and enable "final pass" so a second model writes the deliverable.`,
  ];
  return lines.join("\n");
}

/* ── Judges and the gauntlet ─────────────────────────────────────────────── */

export interface JudgeVote {
  /** "Jev", "LLM judge · claude-fable-5-1", "Red team". */
  name: string;
  pass: boolean;
  detail: string;
  /** A probability, where the judge gives one (Jev's noul). */
  p?: number;
}

export type Severity = "high" | "medium" | "low";

export interface Defect {
  severity: Severity;
  issue: string;
}

/** A panel passes only when every judge on it passes. One dissent is enough
 *  to fail: the point of a second judge is that it can catch what the first
 *  let through, and averaging would let it be outvoted. */
export function combineVotes(votes: JudgeVote[]): { pass: boolean; reason: string } {
  if (votes.length === 0) return { pass: false, reason: "No judge returned a verdict." };
  const failed = votes.filter((v) => !v.pass);
  if (failed.length === 0) return { pass: true, reason: votes.map((v) => `${v.name}: ${v.detail}`).join(" | ") };
  return { pass: false, reason: failed.map((v) => `${v.name}: ${v.detail}`).join(" | ") };
}

/** What a gauntlet round demands on top of the definition of done. Round 1 is
 *  the definition of done alone; from round 2 a red team attacks the result
 *  and it must survive with no high-severity defect; from round 3 no medium
 *  one either. The bar only rises, so a later pass means more than an earlier one. */
export function gauntletBar(round: number): { redTeam: boolean; maxSeverity: Severity | null; label: string } {
  if (round <= 1) return { redTeam: false, maxSeverity: null, label: "definition of done" };
  if (round === 2) return { redTeam: true, maxSeverity: "medium", label: "no high-severity defects" };
  return { redTeam: true, maxSeverity: "low", label: "no high- or medium-severity defects" };
}

export const isStrictestBar = (round: number): boolean => round >= 3;

const RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3 };

/** Whether a defect list clears a bar. `maxSeverity` is the worst allowed. */
export function clearsBar(defects: Defect[], maxSeverity: Severity | null): boolean {
  if (!maxSeverity) return true;
  return defects.every((d) => RANK[d.severity] <= RANK[maxSeverity]);
}

/** The red team's reply: {"defects":[{"severity":"high","issue":"..."}]}, in
 *  a fence or with prose around it. Unknown severities count as high: a red
 *  team that could not grade its finding has not shown it is minor. An
 *  unreadable reply returns null, never an empty list, because "no defects
 *  found" and "could not read the answer" must not look the same. */
export function parseDefects(text: string): Defect[] | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let raw: unknown;
  try { raw = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  const list = (raw as { defects?: unknown })?.defects;
  if (!Array.isArray(list)) return null;
  const out: Defect[] = [];
  for (const d of list) {
    const rec = d as { severity?: unknown; issue?: unknown };
    const issue = typeof rec?.issue === "string" ? rec.issue.trim() : "";
    if (!issue) continue;
    const sev = typeof rec.severity === "string" ? rec.severity.toLowerCase() : "";
    out.push({ severity: sev === "low" || sev === "medium" || sev === "high" ? sev : "high", issue: issue.slice(0, 400) });
  }
  return out;
}

/** Whether the loop stops after this iteration. Without "stop when done" it
 *  always runs every round the user asked for. With it, a normal loop stops
 *  on the first pass; a gauntlet stops only on a pass at the strictest bar,
 *  since an early pass there is against an easier bar by design. */
export function shouldStop(pass: boolean, opts: { stopOnPass: boolean; gauntlet: boolean; round: number }): boolean {
  if (!pass || !opts.stopOnPass) return false;
  return !opts.gauntlet || isStrictestBar(opts.round);
}
