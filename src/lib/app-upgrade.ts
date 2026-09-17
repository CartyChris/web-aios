"use client";

import { ask } from "./useAI";
import { useUserApps } from "@/kernel/userapps";
import { bus } from "@/kernel/bus";
import { upgradePrompt, intentById, looksLikeDocument, unfence, mergeFiles } from "./appversions";
import { parseProjectFiles } from "./scaffold";
import type { ProjectFile } from "./scaffold";

/* ────────────────────────────────────────────────────────────────────────────
   Asking a model to improve an app you already have.

   The interesting part is not the request; it is that the result is a version
   rather than a replacement. Every path through here ends in `commit`, which
   appends to the history, so an upgrade that made things worse is one click
   from being undone — and the click does not destroy the attempt either.

   That changes what the feature IS. "Rewrite my app with AI" is a gamble;
   "try a rewrite, keep it if it is better" is a tool. The only difference is
   whether you can walk it back.
   ──────────────────────────────────────────────────────────────────────────── */

export interface UpgradeOptions {
  appId: string;
  intentId: string;
  /** What the user typed, if anything. */
  detail: string;
  signal?: AbortSignal;
  onDelta?: (full: string) => void;
}

export type UpgradeResult =
  | { ok: true; versionId: string; changedFiles: number; costUsd: number }
  | { ok: false; reason: string };

export async function upgradeApp(opts: UpgradeOptions): Promise<UpgradeResult> {
  const store = useUserApps.getState();
  const app = store.get(opts.appId);
  if (!app) return { ok: false, reason: "That app no longer exists." };

  const intent = intentById(opts.intentId);
  // A project is upgraded from its SOURCE, not from the built preview. Handing
  // a model the bundled output and asking for a change would have it rewrite
  // the artefact and silently orphan the files the artefact came from.
  const isProject = app.kind === "project" && Array.isArray(app.files) && app.files.length > 0;
  const current = isProject ? renderFiles(app.files as ProjectFile[]) : app.html;

  let reply: string;
  let costUsd = 0;
  try {
    const res = await ask({
      messages: [{ role: "user", content: buildPrompt(isProject, opts.intentId, opts.detail, current) }],
      system:
        "You modify an existing application. You return code and nothing else. " +
        "You never remove a feature you were not asked to remove.",
      // Generous, because a truncated rewrite is the failure mode that costs
      // the most: it looks like a result and is not one.
      maxTokens: 16_000,
      temperature: 0.3,
      signal: opts.signal,
      onDelta: (_d, full) => opts.onDelta?.(full),
    });
    reply = res.text;
    costUsd = res.costUsd;
  } catch (e) {
    if ((e as Error).name === "AbortError") return { ok: false, reason: "Cancelled." };
    return { ok: false, reason: e instanceof Error ? e.message : "The model call failed." };
  }

  if (isProject) {
    const files = parseProjectFiles(reply);
    if (files.length === 0) {
      return { ok: false, reason: "The model did not return any recognisable files, so nothing was changed." };
    }
    const merged = mergeFiles(app.files as ProjectFile[], files);
    const html = findPreview(merged) ?? app.html;
    const committed = store.commit(opts.appId, { html, files: merged }, { source: "ai", prompt: `${intent.label}: ${opts.detail}`.trim() });
    if (!committed.ok) return { ok: false, reason: committed.reason };
    bus.emit("notify", { title: `Updated "${app.name}"`, body: `${files.length} file(s) rewritten. Revert from the Versions panel.`, kind: "success" });
    return { ok: true, versionId: committed.versionId, changedFiles: files.length, costUsd };
  }

  const html = unfence(reply);
  const shape = looksLikeDocument(html);
  if (!shape.ok) return { ok: false, reason: `Nothing was changed: ${shape.reason}.` };

  const committed = store.commit(opts.appId, { html }, { source: "ai", prompt: `${intent.label}: ${opts.detail}`.trim() });
  if (!committed.ok) return { ok: false, reason: committed.reason };
  bus.emit("notify", { title: `Updated "${app.name}"`, body: "Revert from the Versions panel if it is worse.", kind: "success" });
  return { ok: true, versionId: committed.versionId, changedFiles: 1, costUsd };
}

function buildPrompt(isProject: boolean, intentId: string, detail: string, current: string): string {
  const base = upgradePrompt(intentId, detail, current);
  if (!isProject) return base;
  // Override the single-document return format for a multi-file project.
  return base.replace(
    "- Return ONE complete HTML document and nothing else. No explanation, no markdown fence.",
    "- Return every file you changed, each preceded by a line of the form `--- path/to/file.ext ---`. Return whole files, never fragments or diffs.",
  );
}

function renderFiles(files: ProjectFile[]): string {
  return files.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n");
}

function findPreview(files: ProjectFile[]): string | null {
  const index = files.find((f) => /(^|\/)index\.html$/i.test(f.path)) ?? files.find((f) => f.path.endsWith(".html"));
  return index ? index.content : null;
}
