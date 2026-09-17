import type { ProjectFile } from "./scaffold";

/* ────────────────────────────────────────────────────────────────────────────
   Version history for apps the user built.

   AI Studio can already rewrite an app you made. Until now that rewrite was
   destructive: the model returned a new document, the store replaced the old
   one, and if the result was worse than what you had there was nothing to go
   back to. Asking a model to improve something is a gamble, and a gamble you
   cannot walk away from is not a feature anyone should use twice.

   Three decisions carry this module, and each has a test:

   - **Reverting APPENDS.** Going back to v3 does not delete v4 and v5; it
     writes a new version whose content is v3's. So un-reverting is just
     reverting again, and the history is a log rather than a stack you can pop
     your own work off. A revert that truncated would make "try it and see" a
     one-way door.
   - **Pruning never drops the first version.** A cap is necessary — every
     version holds a whole document and localStorage is a shared quota — but
     the one version you must always be able to reach is the thing you had
     before any model touched it. So the oldest is pinned and pruning eats the
     middle.
   - **Nothing here renders or stores.** Pure functions over a list, which is
     what lets the pruning invariant and the diff be tested against adversarial
     input rather than eyeballed in a browser.
   ──────────────────────────────────────────────────────────────────────────── */

export type VersionSource = "install" | "ai" | "manual" | "revert" | "import";

export interface AppVersion {
  id: string;
  /** Wall clock at write time. Injected by the caller, never read here. */
  at: number;
  /** One line a person can choose by. Never empty — see `labelFor`. */
  label: string;
  source: VersionSource;
  /** The runnable document at this point. */
  html: string;
  /** Present for projects. The real source, not the preview. */
  files?: ProjectFile[];
  /** What was asked for, when a model made this one. */
  prompt?: string;
  /** The version this was derived from. null for the first. */
  parentId: string | null;
  /** Set on a revert: the version whose content was restored. */
  revertedFrom?: string;
  /** Total characters of html plus every file. Shown in the UI, and the
   *  reason the cap exists. */
  bytes: number;
}

/** How many versions to keep per app. Each holds a whole document, and the
 *  origin's localStorage quota is shared with every other store in the OS. */
export const MAX_VERSIONS = 20;

/** Above this, a single version is refused rather than silently wedging the
 *  quota and taking an unrelated store down with it. */
export const MAX_VERSION_BYTES = 600_000;

export function byteSize(html: string, files?: ProjectFile[]): number {
  return html.length + (files ?? []).reduce((n, f) => n + f.path.length + f.content.length, 0);
}

/* ── creating ────────────────────────────────────────────────────────────── */

export interface NewVersionInput {
  id: string;
  at: number;
  source: VersionSource;
  html: string;
  files?: ProjectFile[];
  prompt?: string;
  label?: string;
  parentId?: string | null;
  revertedFrom?: string;
}

const SOURCE_LABEL: Record<VersionSource, string> = {
  install: "First version",
  ai: "Changed by AI",
  manual: "Edited by hand",
  revert: "Reverted",
  import: "Imported",
};

/** A label a person can pick from a list. An empty label makes a history look
 *  like rows of timestamps, which is exactly when you cannot find the one you
 *  want. */
export function labelFor(input: { source: VersionSource; prompt?: string; label?: string }): string {
  const given = (input.label ?? "").trim();
  if (given) return given.slice(0, 80);
  const prompt = (input.prompt ?? "").trim().replace(/\s+/g, " ");
  if (input.source === "ai" && prompt) return prompt.length > 70 ? `${prompt.slice(0, 69)}…` : prompt;
  return SOURCE_LABEL[input.source];
}

export function makeVersion(input: NewVersionInput): AppVersion {
  return {
    id: input.id,
    at: input.at,
    label: labelFor(input),
    source: input.source,
    html: input.html,
    ...(input.files ? { files: input.files } : {}),
    ...(input.prompt ? { prompt: input.prompt } : {}),
    parentId: input.parentId ?? null,
    ...(input.revertedFrom ? { revertedFrom: input.revertedFrom } : {}),
    bytes: byteSize(input.html, input.files),
  };
}

export type AppendResult =
  | { ok: true; history: AppVersion[]; pruned: string[] }
  | { ok: false; reason: string };

/**
 * Append a version and prune to the cap.
 *
 * Refuses an oversized document rather than storing it: one 5 MB version can
 * exhaust the shared origin quota, and the symptom shows up in whichever
 * unrelated store writes next. Refusing is visible; wedging the quota is not.
 */
export function appendVersion(history: AppVersion[], version: AppVersion): AppendResult {
  if (version.bytes > MAX_VERSION_BYTES) {
    return {
      ok: false,
      reason:
        `That version is ${Math.round(version.bytes / 1024)} KB, over the ${Math.round(MAX_VERSION_BYTES / 1024)} KB per-version limit. ` +
        `Storing it risks the browser storage every app here shares.`,
    };
  }
  // Identical content is not a version. Two adjacent entries with the same
  // bytes give you a history you cannot navigate and a diff that says nothing.
  const head = history[history.length - 1];
  if (head && head.html === version.html && sameFiles(head.files, version.files)) {
    return { ok: false, reason: "That is identical to the current version, so nothing was saved." };
  }

  const next = [...history, version];
  const { kept, pruned } = prune(next, MAX_VERSIONS);
  return { ok: true, history: kept, pruned };
}

function sameFiles(a: ProjectFile[] | undefined, b: ProjectFile[] | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((f, i) => f.path === b[i]?.path && f.content === b[i]?.content);
}

/**
 * Prune to `max`, keeping the FIRST version and the most recent ones.
 *
 * The first is pinned because it is the only thing that answers "put it back
 * the way it was before any of this". A plain `.slice(-max)` would drop it the
 * moment you made twenty-one changes — quietly, and exactly when a long
 * session means you most want it.
 */
export function prune(history: AppVersion[], max: number): { kept: AppVersion[]; pruned: string[] } {
  if (max < 1) return { kept: [], pruned: history.map((v) => v.id) };
  if (history.length <= max) return { kept: history, pruned: [] };

  const first = history[0] as AppVersion;
  // max - 1 recent, because the pinned first occupies one slot.
  const recent = history.slice(-(max - 1));
  const keptIds = new Set([first.id, ...recent.map((v) => v.id)]);
  const kept = [first, ...recent.filter((v) => v.id !== first.id)];
  const pruned = history.filter((v) => !keptIds.has(v.id)).map((v) => v.id);
  return { kept, pruned };
}

/* ── reverting ───────────────────────────────────────────────────────────── */

export type RevertResult =
  | { ok: true; version: AppVersion }
  | { ok: false; reason: string };

/**
 * Build the version that restores an earlier one.
 *
 * Note what this does NOT do: it does not return a shortened history. Revert
 * is a forward operation that copies old content into a new entry, so the
 * versions you reverted past are still there and you can come back. A history
 * you can destroy by navigating it is a trap.
 */
export function revertTo(history: AppVersion[], targetId: string, id: string, at: number): RevertResult {
  const target = history.find((v) => v.id === targetId);
  if (!target) return { ok: false, reason: `There is no version ${targetId} in this app's history.` };

  const head = history[history.length - 1];
  if (head && head.id === targetId) {
    return { ok: false, reason: "That is already the current version." };
  }
  if (head && head.html === target.html && sameFiles(head.files, target.files)) {
    return { ok: false, reason: "The current version is already identical to that one." };
  }

  return {
    ok: true,
    version: makeVersion({
      id,
      at,
      source: "revert",
      html: target.html,
      files: target.files,
      parentId: head?.id ?? null,
      revertedFrom: target.id,
      label: `Reverted to "${target.label}"`,
    }),
  };
}

export const currentVersion = (history: AppVersion[]): AppVersion | undefined => history[history.length - 1];

/* ── diffing ─────────────────────────────────────────────────────────────── */

export interface VersionDiff {
  /** Lines present in `to` and not in `from`. */
  added: number;
  removed: number;
  /** Signed character delta. */
  bytesDelta: number;
  /** Per-file, for a project. Empty for a single document. */
  files: Array<{ path: string; status: "added" | "removed" | "changed" | "same" }>;
  /** True when nothing at all differs. */
  identical: boolean;
  /** One line for a list row. */
  summary: string;
}

/**
 * A line-level count, deliberately NOT a real diff algorithm.
 *
 * This answers "how big was that change" in a list row, and a multiset
 * comparison answers it in linear time. A proper LCS diff would be the right
 * tool for showing someone which lines moved, and the wrong one for a number
 * rendered next to twenty rows — so this counts, and says that it counts.
 */
export function diffVersions(from: AppVersion, to: AppVersion): VersionDiff {
  const fromLines = countLines(from.html);
  const toLines = countLines(to.html);

  let added = 0;
  let removed = 0;
  for (const [line, n] of toLines) added += Math.max(0, n - (fromLines.get(line) ?? 0));
  for (const [line, n] of fromLines) removed += Math.max(0, n - (toLines.get(line) ?? 0));

  const files = diffFiles(from.files, to.files);
  const identical = added === 0 && removed === 0 && files.every((f) => f.status === "same");

  const parts: string[] = [];
  if (added) parts.push(`+${added}`);
  if (removed) parts.push(`-${removed}`);
  const changedFiles = files.filter((f) => f.status !== "same").length;
  if (changedFiles) parts.push(`${changedFiles} file${changedFiles === 1 ? "" : "s"}`);

  return {
    added,
    removed,
    bytesDelta: to.bytes - from.bytes,
    files,
    identical,
    summary: identical ? "No change" : `${parts.join(" ")} · ${signed(to.bytes - from.bytes)} chars`,
  };
}

function signed(n: number): string {
  return n >= 0 ? `+${n.toLocaleString("en-US")}` : n.toLocaleString("en-US");
}

/** A multiset, so N identical lines are not collapsed into one. Blank lines
 *  are dropped: reformatting should not read as a hundred-line change. */
function countLines(src: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    out.set(line, (out.get(line) ?? 0) + 1);
  }
  return out;
}

function diffFiles(a: ProjectFile[] | undefined, b: ProjectFile[] | undefined): VersionDiff["files"] {
  if (!a && !b) return [];
  const from = new Map((a ?? []).map((f) => [f.path, f.content]));
  const to = new Map((b ?? []).map((f) => [f.path, f.content]));
  const paths = [...new Set([...from.keys(), ...to.keys()])].sort();
  return paths.map((path) => {
    const before = from.get(path);
    const after = to.get(path);
    if (before === undefined) return { path, status: "added" as const };
    if (after === undefined) return { path, status: "removed" as const };
    return { path, status: before === after ? ("same" as const) : ("changed" as const) };
  });
}

/* ── is this actually a document? ────────────────────────────────────────── */

/**
 * Did the model return something plausibly whole?
 *
 * The failure worth catching is truncation. A model that runs out of tokens
 * mid-rewrite returns a file that looks fine in a list and is broken when you
 * open it, and committing that puts a dead app in front of the user as though
 * it were an improvement. The history makes it recoverable; this makes it rare.
 */
export function looksLikeDocument(html: string): { ok: true } | { ok: false; reason: string } {
  const text = html.trim();
  if (text.length < 40) return { ok: false, reason: "the reply was too short to be a document" };
  if (!/<html|<!doctype|<body|<div|<main|<section/i.test(text)) {
    return { ok: false, reason: "the reply does not look like HTML at all" };
  }
  if (/<html[\s>]/i.test(text) && !/<\/html>/i.test(text)) {
    return { ok: false, reason: "the document is missing its closing </html> — the model was probably cut off" };
  }
  if (/<body[\s>]/i.test(text) && !/<\/body>/i.test(text)) {
    return { ok: false, reason: "the document is missing its closing </body> — the model was probably cut off" };
  }
  return { ok: true };
}

/** Strip a markdown fence a model added despite being asked not to. */
export function unfence(text: string): string {
  const fenced = text.match(/```(?:html|xml)?\s*([\s\S]*?)```/i);
  return (fenced ? (fenced[1] ?? "") : text).trim();
}

/** Replace the files a model returned, keep the ones it did not mention. A
 *  model that returns three of nine files has changed three, not deleted six. */
export function mergeFiles(existing: ProjectFile[], returned: ProjectFile[]): ProjectFile[] {
  const byPath = new Map(existing.map((f) => [f.path, f]));
  for (const f of returned) byPath.set(f.path, f);
  return [...byPath.values()];
}

/* ── the upgrade prompt ──────────────────────────────────────────────────── */

/** Named intents, so "make it better" is not the only thing on offer. A vague
 *  instruction is how a model returns a rewrite nobody asked for. */
export const UPGRADE_INTENTS: Array<{ id: string; label: string; instruction: string }> = [
  {
    id: "polish",
    label: "Polish the design",
    instruction:
      "Improve the visual design: spacing, hierarchy, contrast and alignment. Keep every existing feature and every " +
      "piece of behaviour exactly as it is. Change how it looks, not what it does.",
  },
  {
    id: "feature",
    label: "Add a feature",
    instruction: "Add the feature described below. Leave everything already working exactly as it is.",
  },
  {
    id: "fix",
    label: "Fix a bug",
    instruction:
      "Find and fix the problem described below. Make the smallest change that fixes it. Do not refactor anything " +
      "the bug does not touch.",
  },
  {
    id: "a11y",
    label: "Make it accessible",
    instruction:
      "Improve keyboard navigation, focus states, colour contrast and screen-reader labelling. Do not change the " +
      "visual design beyond what contrast requires.",
  },
  {
    id: "mobile",
    label: "Make it work on a phone",
    instruction:
      "Make the layout work at 375px wide: touch targets at least 44px, no horizontal scrolling, and stacked rather " +
      "than side-by-side panels. Keep the desktop layout intact.",
  },
  {
    id: "faster",
    label: "Make it faster",
    instruction:
      "Reduce work done per frame and per interaction. Do not change any visible behaviour; if a change would alter " +
      "what the user sees, do not make it.",
  },
  {
    id: "simplify",
    label: "Simplify the code",
    instruction:
      "Remove duplication and dead code, and clarify names. Behaviour must be byte-for-byte identical afterwards.",
  },
];

export function intentById(id: string) {
  return UPGRADE_INTENTS.find((i) => i.id === id) ?? UPGRADE_INTENTS[0];
}

/**
 * The instruction sent to the model.
 *
 * It states the return format and the preservation rule before the request,
 * because a model asked to "improve this app" will often return a
 * reimagined one — losing features the user never asked it to touch. The
 * history makes that recoverable; the prompt makes it rarer.
 */
export function upgradePrompt(intentId: string, detail: string, current: string): string {
  const intent = intentById(intentId);
  return [
    intent.instruction,
    detail.trim() ? `\nSpecifically: ${detail.trim()}` : "",
    "",
    "Rules:",
    "- Return ONE complete HTML document and nothing else. No explanation, no markdown fence.",
    "- It must run standalone: everything inline, no build step, no imports from a package manager.",
    "- Preserve every feature that already works unless you were explicitly asked to change it.",
    "- If you cannot do what was asked, return the document UNCHANGED rather than approximating it.",
    "",
    "Current document:",
    current,
  ].filter(Boolean).join("\n");
}
