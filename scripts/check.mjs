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

/* ── 4c. Every theme is legible ──────────────────────────────────────────── */
{
  // Added with the jump from 16 themes to 50. A palette is data, and bad data
  // here is invisible until someone switches to that theme and finds half the
  // interface unreadable — which is exactly the class this gate exists for.
  //
  // Two rules, and each is measured rather than eyeballed:
  //  - muted text must clear WCAG AA (4.5:1) on the solid panel it sits on. It
  //    carries every secondary label in the OS.
  //  - accent and accent2 must be perceptually distinct. Luminance ratio is
  //    the WRONG metric for that: a brown and a green of equal lightness score
  //    1.01 and are obviously different colours. Redmean distance respects
  //    hue, so it answers the question actually being asked.
  const src = read(join(SRC, "kernel/themes.ts"));
  const block = src.slice(src.indexOf("export const THEMES"), src.indexOf("/* Wallpapers"));
  const RE = /^\s*t\(\s*"([a-z0-9]+)",\s*"([^"]+)",\s*(true|false),\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)"\s*\)/gm;

  const rgb = (h) => {
    const m = h.replace("#", "");
    const full = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
    const n = parseInt(full, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const luminance = (h) => {
    const [r, g, b] = rgb(h).map((v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => {
    const l1 = luminance(a); const l2 = luminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const redmean = (a, b) => {
    const [r1, g1, b1] = rgb(a); const [r2, g2, b2] = rgb(b);
    const rm = (r1 + r2) / 2;
    const dr = r1 - r2; const dg = g1 - g2; const db = b1 - b2;
    return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
  };

  const MUTED_MIN = 4.5;   // WCAG AA for text
  const ACCENT_MIN = 3.0;  // WCAG for a non-text UI mark
  const DISTINCT_MIN = 100; // redmean; the shipped palettes sit at 126 and up

  let themes = 0;
  for (const m of block.matchAll(RE)) {
    const [, id, , , , , , panelSolid, text, muted, accent, accent2] = m;
    themes++;
    const mutedRatio = contrast(muted, panelSolid);
    if (mutedRatio < MUTED_MIN) {
      problems.push(`theme "${id}": muted text is ${mutedRatio.toFixed(2)}:1 on its panel, under the ${MUTED_MIN}:1 minimum — every secondary label would be hard to read`);
    }
    const textRatio = contrast(text, panelSolid);
    if (textRatio < MUTED_MIN) {
      problems.push(`theme "${id}": body text is ${textRatio.toFixed(2)}:1 on its panel, under the ${MUTED_MIN}:1 minimum`);
    }
    const accentRatio = contrast(accent, panelSolid);
    if (accentRatio < ACCENT_MIN) {
      problems.push(`theme "${id}": accent is ${accentRatio.toFixed(2)}:1 on its panel, under the ${ACCENT_MIN}:1 minimum for a UI mark`);
    }
    // Text that sits ON the accent. Before this was computed per theme, the
    // primary button hardcoded one dark blue and failed AA on 19 of 50
    // palettes — worst case 2.5:1. Recomputed here from the same rule the
    // runtime uses, so the two cannot drift apart.
    const onAccent = luminance(accent) > 0.179 ? "#050506" : "#ffffff";
    const onAccentRatio = contrast(onAccent, accent);
    if (onAccentRatio < 4.5) {
      problems.push(`theme "${id}": text on the accent reaches only ${onAccentRatio.toFixed(2)}:1 — a primary button would be unreadable`);
    }

    const apart = redmean(accent, accent2);
    if (apart < DISTINCT_MIN) {
      problems.push(`theme "${id}": accent ${accent} and accent2 ${accent2} are only ${apart.toFixed(0)} apart — they mark different things and would read as one colour`);
    }
  }
  if (themes < 10) problems.push(`themes: only parsed ${themes} palettes — the parser has stopped matching`);
  notes.push(`${themes} themes checked for contrast and accent distinctness`);
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

/* ── Hand-written -webkit- prefixes on backdrop-filter ───────────────────────
 *
 * Next minifies with Lightning CSS, which treats -webkit-backdrop-filter as the
 * prefixed variant of the same property. Given BOTH declarations it keeps the
 * -webkit- one ALONE and drops the standard property. Chromium supports
 * backdrop-filter but not -webkit-backdrop-filter, so the rule goes dead and
 * every glass surface silently loses its blur. Reproduced directly against
 * lightningcss: "both" compiles to -webkit- only, "standard alone" compiles to
 * both. Writing only the unprefixed property is correct for every target.
 *
 * The symptom is deceptive: a browser drops declarations it cannot parse, so
 * the rule reads back from the CSSOM as if a minifier had stripped it. This
 * check exists so nobody has to rediscover that. */
{
  const cssFiles = [];
  const walkCss = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walkCss(full);
      else if (e.name.endsWith(".css")) cssFiles.push(full);
    }
  };
  walkCss(join(ROOT, "src"));
  let scanned = 0;
  for (const f of cssFiles) {
    scanned++;
    const src = read(f);
    for (const m of src.matchAll(/-webkit-backdrop-filter\s*:/g)) {
      problems.push(
        `${rel(f)}:${lineAt(src, m.index)} — hand-written -webkit-backdrop-filter. ` +
        `Lightning CSS will keep this and DROP the standard backdrop-filter, killing the blur. ` +
        `Declare only "backdrop-filter" and let the minifier add prefixes.`,
      );
    }
  }
  notes.push(`${scanned} stylesheet${scanned === 1 ? "" : "s"} checked for prefix-collapse hazards`);
}

/* ── Icon-only buttons need an accessible name ───────────────────────────────
 *
 * A button whose entire content is an <Icon> renders as an empty button to a
 * screen reader. `title` is not a reliable substitute: it is announced
 * inconsistently across screen readers and never on touch, so this asks for an
 * explicit aria-label.
 *
 * Text inside a JSX expression counts as a label -- `{busy ? "Saving" : "Save"}`
 * is a perfectly good button. An earlier version of this check stripped
 * expressions before looking for text and reported twenty-five false positives
 * as a result, which is why the expression handling below is deliberate rather
 * than incidental. */
{
  let checked = 0;
  for (const f of files.filter((f) => f.endsWith(".tsx"))) {
    const src = read(f);
    for (const m of src.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
      checked++;
      const [, attrs, inner] = m;
      if (/aria-label\s*=/.test(attrs)) continue;
      const noTags = inner.replace(/<[^>]*\/>/g, "").replace(/<[^>]*>/g, "");
      const bare = noTags.replace(/\{[\s\S]*?\}/g, "").trim();
      const exprs = [...noTags.matchAll(/\{([\s\S]*?)\}/g)].map((x) => x[1]);
      const exprText = exprs.some((e) => /["'`]\s*\S/.test(e) || /\b(label|name|title|text)\b/.test(e));
      if (bare || exprText) continue;
      problems.push(
        `${rel(f)}:${lineAt(src, m.index)} — a button with no text needs aria-label; ` +
        `an <Icon> alone reads as an empty button.`,
      );
    }
  }
  notes.push(`${checked} buttons checked for an accessible name`);
}

/* ── Source files must be greppable ──────────────────────────────────────────
 *
 * A raw control byte in a string literal is valid UTF-8 and compiles fine, but
 * it makes the file "binary" to grep -- which then SKIPS IT SILENTLY. Searching
 * the repo for a symbol defined in such a file returns nothing at all, and the
 * obvious conclusion is that the symbol does not exist.
 *
 * harness/protocol.ts did exactly this with \u0000..\u0002 as fingerprint
 * separators, and cost a search that came back empty on a function that was
 * right there. Escape sequences are identical at runtime and stay searchable. */
{
  let scanned = 0;
  for (const f of files) {
    scanned++;
    const buf = readFileSync(f);
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      if (b < 32 && b !== 9 && b !== 10 && b !== 13) {
        const line = read(f).slice(0, i).split("\n").length;
        problems.push(
          `${rel(f)}:${line} — raw control byte 0x${b.toString(16).padStart(2, "0")} in source. ` +
          `grep skips binary files silently, so this module becomes unsearchable. Write it as an escape (\\u00${b.toString(16).padStart(2, "0")}).`,
        );
        break;
      }
    }
  }
  notes.push(`${scanned} source files checked for raw control bytes`);
}

/* ── Report ──────────────────────────────────────────────────────────────── */
for (const n of notes) console.error(`  · ${n}`);
if (problems.length) {
  console.error(`\nFAIL — ${problems.length} problem${problems.length === 1 ? "" : "s"}:`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.error(`\nOK  icons resolve | app ids resolve | modules exist | keys unique | names unique | themes legible | no emoji | no debug output`);
