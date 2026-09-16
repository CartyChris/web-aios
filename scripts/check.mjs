#!/usr/bin/env node
/**
 * Integrity gate.
 *
 * Adapted from GlassBox's check.py, which exists because a type-checker and a
 * linter between them still miss a whole class of defect: wiring that is
 * perfectly well-typed and points at nothing. Their version catches
 * `$('#some-id').onclick = ...` where no such id exists — dead wiring left
 * behind by removed UI, which throws at boot. The React equivalents are
 * different but the class is identical, and every check below was written
 * because that exact failure has actually happened in this repo:
 *
 *  - <Icon name="typo" /> falls back to a generic tile instead of throwing, so
 *    a misspelled glyph is invisible until someone notices the wrong picture.
 *  - An appId string that no longer exists in the registry makes a menu item,
 *    a pin or a bus message silently do nothing.
 *  - Two zustand stores sharing a persist key silently clobber each other's
 *    data, and the symptom appears in whichever store loads second.
 *  - Emoji in the UI is a standing project rule; a single one slips in easily.
 *  - A registry entry importing a deleted module only fails when someone opens
 *    that app.
 *
 * Every check prints what it scanned, so a check that silently stops matching
 * anything is visible rather than quietly passing. Exit 1 on any failure.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not .pathname: this project lives under a directory with a
// space in its name, and .pathname hands back "%20" which every fs call then
// fails to find.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");
const problems = [];
const notes = [];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

const files = walk(SRC);
const read = (f) => readFileSync(f, "utf8");
const rel = (f) => relative(ROOT, f);

/** Line number of a character offset, for an error message someone can act on. */
const lineAt = (src, index) => src.slice(0, index).split("\n").length;

/* ── 1. Every icon name resolves ─────────────────────────────────────────── */
{
  const iconsSrc = read(join(SRC, "shell/icons.tsx"));
  const block = iconsSrc.slice(iconsSrc.indexOf("export const ICONS"), iconsSrc.indexOf("export interface IconProps"));
  const known = new Set([...block.matchAll(/^\s{2}([a-zA-Z][\w]*):/gm)].map((m) => m[1]));
  if (known.size < 50) problems.push(`icons: only parsed ${known.size} glyph names — the ICONS parser has stopped matching`);

  let checked = 0;
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(/<Icon\s+name=["']([^"']+)["']/g)) {
      checked++;
      if (!known.has(m[1])) problems.push(`${rel(f)}:${lineAt(src, m.index)} — <Icon name="${m[1]}"> is not in the icon set`);
    }
    // Registry and catalogue entries name their glyph as a bare string.
    for (const m of src.matchAll(/^\s*icon:\s*["']([^"']+)["']/gm)) {
      if (!m[1]) continue;
      checked++;
      if (!known.has(m[1])) problems.push(`${rel(f)}:${lineAt(src, m.index)} — icon: "${m[1]}" is not in the icon set`);
    }
  }
  notes.push(`${known.size} glyphs, ${checked} references checked`);
}

/* ── 2. Every referenced app id exists ───────────────────────────────────── */
{
  const registry = read(join(SRC, "kernel/registry.tsx"));
  const ids = new Set([...registry.matchAll(/^\s{4}id:\s*["']([^"']+)["']/gm)].map((m) => m[1]));
  if (ids.size < 10) problems.push(`registry: only parsed ${ids.size} app ids — the parser has stopped matching`);

  let checked = 0;
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(/appId:\s*["']([^"']+)["']/g)) {
      checked++;
      if (!ids.has(m[1])) problems.push(`${rel(f)}:${lineAt(src, m.index)} — appId "${m[1]}" is not in the registry`);
    }
    for (const m of src.matchAll(/wm\.open\(\s*["']([^"']+)["']/g)) {
      checked++;
      if (!ids.has(m[1])) problems.push(`${rel(f)}:${lineAt(src, m.index)} — wm.open("${m[1]}") is not in the registry`);
    }
  }
  notes.push(`${ids.size} apps, ${checked} id references checked`);
}

/* ── 3. Every registry component file exists ─────────────────────────────── */
{
  const registry = read(join(SRC, "kernel/registry.tsx"));
  const imports = [...registry.matchAll(/import\(["']@\/([^"']+)["']\)/g)].map((m) => m[1]);
  if (!imports.length) problems.push("registry: no lazy imports found — the parser has stopped matching");
  for (const spec of imports) {
    const base = join(SRC, spec);
    if (!existsSync(`${base}.tsx`) && !existsSync(`${base}.ts`)) {
      problems.push(`registry imports @/${spec} which does not exist`);
    }
  }
  notes.push(`${imports.length} app modules resolved`);
}

/* ── 4. Persist keys are unique ──────────────────────────────────────────── */
{
  const seen = new Map();
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(/name:\s*["'](webaios\.[^"']+)["']/g)) {
      const key = m[1];
      const where = `${rel(f)}:${lineAt(src, m.index)}`;
      if (seen.has(key) && seen.get(key) !== where) {
        problems.push(`storage key "${key}" is used by both ${seen.get(key)} and ${where} — they will clobber each other`);
      }
      seen.set(key, where);
    }
  }
  notes.push(`${seen.size} storage keys, all distinct`);
}

/* ── 4b. App display names are unique ────────────────────────────────────── */
{
  // Added after a real collision: a new app was registered as "Signals" while
  // the Intel app already carried that name. Every id was unique, so check 2
  // passed — but the launcher, the dock, the palette, the pin picker and the
  // mobile shell all render the NAME, so the two apps were indistinguishable
  // everywhere a person actually chooses between them. Uniqueness of the key
  // is not uniqueness of the label.
  const registrySrc = read(join(SRC, "kernel/registry.tsx"));
  const entries = [...registrySrc.matchAll(/id:\s*["']([a-z0-9_-]+)["'],[\s\S]{0,400}?name:\s*["']([^"']+)["']/g)];
  if (entries.length < 20) {
    problems.push(`app names: only parsed ${entries.length} registry entries — the parser has stopped matching`);
  }
  const byName = new Map();
  for (const m of entries) {
    const [, id, name] = m;
    const key = name.trim().toLowerCase();
    if (byName.has(key)) {
      problems.push(
        `app name "${name}" is used by both "${byName.get(key)}" and "${id}" — they are indistinguishable in the launcher, dock and palette`,
      );
    }
    byName.set(key, id);
  }
  notes.push(`${entries.length} app names, all distinct`);
}

/* ── 5. No emoji in the UI ───────────────────────────────────────────────── */
{
  // Pictographic ranges only. Deliberately excludes the arrows, box-drawing and
  // typographic marks the comments and UI use on purpose.
  const EMOJI = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F0FF}\u{2600}-\u{27BF}\u{FE0F}]/u;
  let scanned = 0;
  for (const f of files) {
    const src = read(f);
    scanned++;
    src.split("\n").forEach((line, i) => {
      if (EMOJI.test(line)) problems.push(`${rel(f)}:${i + 1} — emoji in source: ${line.trim().slice(0, 70)}`);
    });
  }
  notes.push(`${scanned} files scanned for emoji`);
}

/* ── 6. No stray debug output on the boot path ───────────────────────────── */
{
  // Template-literal contents are blanked first, keeping newlines so line
  // numbers stay honest. Bridge.tsx emits the source of a Node daemon the user
  // runs themselves, and that program logs its own pairing token on purpose —
  // flagging it is the check being wrong, not the code. Widening the check to
  // understand context is the fix; whitelisting the file would blind it to a
  // real console.log added there tomorrow.
  const blankTemplates = (src) => src.replace(/`(?:\\.|[^`\\])*`/gs, (m) => "`" + "\n".repeat((m.match(/\n/g) || []).length) + "`");
  let count = 0;
  for (const f of files) {
    const src = blankTemplates(read(f));
    for (const m of src.matchAll(/console\.log\(/g)) {
      count++;
      problems.push(`${rel(f)}:${lineAt(src, m.index)} — console.log left in source`);
    }
  }
  if (!count) notes.push("no console.log outside template literals");
}

/* ── Report ──────────────────────────────────────────────────────────────── */
for (const n of notes) console.error(`  · ${n}`);
if (problems.length) {
  console.error(`\nFAIL — ${problems.length} problem${problems.length === 1 ? "" : "s"}:`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.error(`\nOK  icons resolve | app ids resolve | modules exist | keys unique | names unique | no emoji | no debug output`);
