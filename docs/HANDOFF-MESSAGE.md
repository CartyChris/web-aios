# Web-AIOS — paste this into a fresh Claude Code session

You're continuing a long-running project: **Web-AIOS**, a desktop operating system that runs
in a browser tab. The goal of this session is to upgrade it substantially while keeping every
existing feature and test working.

```
Repo:   /Users/chriscarty/Desktop/All Finished Apps/Web-AIOS
Remote: https://github.com/CartyChris/web-aios.git   (branch: main)
Live:   https://web-aios.vercel.app     — Vercel auto-deploys main. A push to main is a production deploy.
Stack:  Next.js 16.3.5 App Router · React 19.3 · TypeScript 5.9 strict · Tailwind v4 over CSS vars · zustand 5 + persist
```

**Verified state on 2026-09-23:** HEAD `dbb4dce` = `origin/main`, working tree clean,
`npm test` **853/853 pass**, `npm run check` green. Also green at that commit: `tsc --noEmit`,
ESLint (0 errors, 0 warnings) and `next build`.

---

## 1. Do these three things before anything else

**a) Stop iCloud from hanging your tools.** The repo lives in an iCloud-synced folder, so the
macOS File Provider mediates every file read. Once `node_modules` holds about 28,000 files, it
saturates and every tool stalls. When this happens, `tsc`, `next build` and even `git commit`
hang at **0% CPU**. That is the tell: a slow process burns CPU, a blocked one doesn't. Run once:

```bash
cd "/Users/chriscarty/Desktop/All Finished Apps/Web-AIOS"
xattr -w 'com.apple.fileprovider.ignore#P' 1 node_modules
mkdir -p .next && xattr -w 'com.apple.fileprovider.ignore#P' 1 .next
```

Measured effect of those two commands: `npm test` 52s → 1.2s; `tsc` hung >10 min → 2.7s;
`next build` hung >20 min → 6.5s.

- If `node_modules` is evicted (`ls -lO node_modules/next/dist/bin/next` shows `dataless`),
  run `npm ci`. It takes about 4 seconds from the local cache, and warming the files instead
  takes about 90 minutes.
- Source files can be evicted too. If `git commit` fails with `Operation timed out`, run
  `find src tests scripts -type f -flags +dataless -print0 | xargs -0 cat >/dev/null` and retry.
- Use `./node_modules/.bin/next`, not `npx next`. The `npx` version has hung with no worker process.

**b) Read `docs/HANDOFF-2026-09-20.md`.** It is the living source of truth, 600+ lines,
maintained through every session. Section map:
- §2 standing rules
- §4 open items
- §5 the environment
- §6 house rules
- §7 bug catalogue ("do not rediscover these")
- §9 routing table: want X → edit Y
- §10–15 the newest subsystems

`HANDOFF.md` at the repo root is stale and has a banner that points to the docs file.

**c) Prove the baseline yourself:**

```bash
npm run check        # integrity gate, ~0.3s
npm test             # 853 pass
./node_modules/.bin/tsc --noEmit
npm run lint         # must be 0 errors AND 0 warnings
./node_modules/.bin/next build
```

---

## 2. Chris's standing rules — these are not style preferences

1. **No emoji, anywhere.** That covers code, UI and commit messages. `npm run check` fails the
   build on one. Icons are drawn glyphs via `<Icon name=…/>`, and the gate checks that every
   name resolves.
2. **Verify with a check that can fail, then say plainly what you did NOT verify.** Never
   report a success you didn't measure. This matters more than shipping fast.
3. **Never run a local model server (Ollama / LM Studio).** It has crashed his machine. He
   tests those himself.
4. **Never read `openai-api-key.txt`** in the iCloud "Agentic AI OS : Apps" folder. It has
   deliberately never been opened.
5. **Additive only.** Never delete a feature or a test to make something pass. If you fix a
   test, fix the test's mistake and keep what it covers.
6. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Write
   them as prose explaining *why*; the existing history is the style guide.
7. Every number shown on screen must be a real measured result, pinned by a test.
8. Chris checks claims. Be honest about what's unverified. When he pushes back, re-measure
   instead of defending.

---

## 3. House rules for the code (the ones that bite)

- **`src/lib/**` is pure.** No `@/` imports, no DOM, React or zustand, and no `Date.now()`,
  `Math.random()` or `performance.now()`. The caller injects those. Relative imports have
  **no** `.js` extension.
- **Every new pure module must be added to the `include` array in `tsconfig.test.json`**, or
  its tests won't compile. Tests import from `../.test-build/<name>.js`.
- **React Compiler lint rules are errors:** `set-state-in-effect`, `refs` (no `ref.current`
  reads or writes during render), `preserve-manual-memoization`, `purity`, `static-components`.
  - For data fetching, let the effect own the whole lifecycle and use a reload token.
    `NewsWidget` and `DataWidget` are the reference.
  - To pick up a changed prop without an effect, adjust during render against the last value
    taken. `AIStudio`'s `runUserApp` is the reference.
- **`ask()` traps:**
  - A `role:"system"` message inside `messages` is silently dropped; use the `system` option.
  - `persona` defaults to true; pass `persona:false` for machine-shaped output.
  - A budget stop throws.
- **CSS: write `backdrop-filter` unprefixed only.** Given both forms, Lightning CSS keeps the
  `-webkit-` one alone, and Chromium ignores that. This killed the glass blur in production. The
  gate enforces it. Dev mode doesn't minify, so verify CSS in the built output.
- **Right-click:** there is one capture-phase listener (`src/shell/useGlobalContextMenu.ts`). Don't add
  another `contextmenu` handler. Contribute a section with `registerContextTarget(el, builder)`
  from `@/kernel/ctxmenu`, or put `data-ctx-skip` on a surface that uses the right button itself.
- **Themes:** list them with `allThemes(useCustomThemes(s => s.themes))`, never bare `THEMES`, or
  generated themes disappear.

---

## 4. How to verify in a browser (this is where sessions go wrong)

Use the built-in browser against a **production** build (`next build` then `next start -p 3190`).
Dev mode hides minifier bugs.

- The pane often reports a **0×0 viewport**, so nothing renders and all geometry reads as
  negative. Call `resize_window` (for example 1280×800) first.
- **The screenshot coordinate frame is often NOT the viewport, and can be anisotropic.**
  Readings of 1.6× wide by 1.333× tall have been measured. Before any coordinate click, arm a
  `pointermove` listener and hover a known point to measure the real mapping. An earlier
  session filed a false bug because it clicked the wrong element.
- `window.__aios` is the verification surface: `stores` (settings, wm, vfs, userApps, widgets,
  mcp, eggs, triggers, updates, customThemes, scenes), `open()`, `close()`, `bus`, `ask`,
  `snapshot()`, `waitFor()`. Drive state through it rather than by clicking.
- Register predictions **before** you act, then compare. Past sessions verified drag-to-restore
  to within 0.5px this way.
- Before filing a bug, check your selector and read the cleanup path. Several "bugs" were a
  wrong selector or a case-sensitive `innerText` check (`.os-label` uppercases via CSS).
- Before trusting a new test, make it fail against the old code. Before trusting a scanner,
  spot-check its hits: an accessibility scanner once reported 25 violations and the real count
  was 1.
- **Don't poll the production site in a loop.** About 45 requests in 15 minutes tripped Vercel's
  Security Checkpoint (403) for automated clients. Chris confirmed the site worked fine in his
  own browser.

---

## 5. What exists now (most recent first)

| Subsystem | Where | Handoff § |
|---|---|---|
| Harness **Patterns** tab: mines runs for recurrent failures, each with its run ids as receipts | `src/lib/harness/patterns.ts` | 15 |
| **MCP 2026-07-28:** stateless `_meta`, `Mcp-Method`/`Mcp-Name` headers, cacheable lists. Negotiates and speaks whatever the server answers | `src/lib/mcp-wire.ts` | 14 |
| **Context folding:** a counted ledger for long ReAct runs. Folds the prompt only; the receipt stays whole | `src/lib/harness/fold.ts` | 13 |
| **Right-click everywhere:** ARIA menu pattern, Shift+F10, submenus, type-ahead, flips at screen edges | `src/lib/ctxmenu.ts`, `src/shell/ContextMenu.tsx` | 12 |
| Accessibility: reduced-motion, reduced-transparency and contrast preferences honoured; `aria-label` gate | `globals.css`, `scripts/check.mjs` | 11 |
| **AI System Updates:** a model proposes themes/widgets/tuning → preview → edit → apply → revert | `src/lib/sysupdate.ts`, `src/apps/Updates.tsx` | 10 |
| **Zones:** 7 tiling layouts, top-bar menu, Cmd/Ctrl+Alt+1..7 | `src/lib/zones.ts` | 1 |
| **Scenes:** save and restore the whole desktop, resolution-independent | `src/lib/scenes.ts` | 1 |
| ReAct harness, swarm with DoD and bidding, 42 free data services, MCP hub, pets, 50 themes, 33 apps | see routing table §9 | 3 |

---

## 6. The upgrade backlog, in priority order

**Fix first. These are known and real.**

1. **Right-click on phones shows nothing.** `useGlobalContextMenu()` runs at `Desktop.tsx:40`,
   before the `if (vp.isPhone) return <MobileShell />` at line 219. So it suppresses the
   browser menu, but `<ContextMenuHost />` is rendered only in the desktop tree (line 239) and
   never in `MobileShell`. Found by reading the code, not yet reproduced. Confirm at a 375px
   viewport, then render the host in `MobileShell`. Also consider long-press as the touch
   equivalent.
2. **Two snap-geometry implementations:** `snapGeometry` in `src/kernel/wm.ts` and `zoneRect` in
   `src/lib/zones.ts`. The drag decision already goes through `zoneAt()`. Route `wm.snap` through
   `zoneRect` too, so there's one tested geometry.
3. `wm.setArgs` has no callers. It's a dead API; either give it a caller or leave it documented.

**Verify with live evidence.** Each of these needs an API key or a live endpoint, which the
last session didn't have:

4. Drive one **AI System Update** with a real model reply through `parseUpdate`. Apply and
   revert are proven only against a hand-built proposal.
5. Send a **folded prompt** to a real model on a long run, and check the ledger actually helps a
   looping agent.
6. Point the **MCP client at a real 2026-07-28 server.** The wire format is tested both ways,
   but only against constructed responses.
7. Exercise `PetMaker`'s model-error path.

**Big upgrades. This is where "massively" lives.**

8. **Per-app right-click menus.** Files (rename/move/delete/open-with), IDE (format, go to
   definition, ask AI about the selection), Notes, Browser (back/forward/reload/open in new
   window) and Chat (copy message, regenerate). The mechanism is ready (§12); none of these
   contribute a section yet.
9. **Live preview of a system update.** Apply it to the whole OS for about 15 seconds with a
   Keep/Revert bar that auto-reverts, like changing display resolution. Let updates propose
   Scenes and layouts too. `parseScene` is already written for untrusted input.
10. **MCP MRTR.** The 2026-07-28 spec replaces server-initiated elicitation and sampling with
    Multi Round-Trip Requests. The client doesn't implement MRTR yet.
11. **Harness self-improvement loop** (Lil'Log, "Harness Engineering for Self-Improvement",
    2026-07). Feed recurrent Patterns into bounded harness-edit proposals, each paired with a
    falsifiable prediction. Validate on held-in and held-out splits of the golden set before
    accepting. Never let the edit touch the verifier.
12. **Subagent context modes** for Swarm: isolated (fresh) vs forked (inherits the supervisor's
    context), per the 2026 harness literature.
13. **Keyboard-first OS.** Make keybinds user-editable in Settings, including the layout chords,
    and add a visible cheat-sheet overlay.
14. **Performance pass.** Measure first: bundle size per app chunk, time to interactive, and
    re-render counts on window drag. Then fix what the numbers say.

---

## 7. How to work so the next session inherits a clean state

- Before editing, write a short stage plan. Give each stage a check that can fail.
- Don't ship tested-but-unused code. Past sessions caught themselves twice: `zoneAt` and `fold`
  were each built, tested and then left unwired.
- When a test fails, ask first whether the *test* is wrong. It has been several times: digit
  normalization collapsing fixtures, and an incidental magic number.
- Use `git commit -F <file>` for long messages. A heredoc containing control characters is
  rejected by the tool.
- When finished:
  - Update `docs/HANDOFF-2026-09-20.md`: §1 state, §4 open items, §7 new bug classes, §8 next
    moves, plus a new numbered section per subsystem.
  - Re-run all five checks and state the counts.
  - Push, then **ask Chris to confirm the live site in his browser**, because automated checks
    against production get challenged.
