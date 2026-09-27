# Web-AIOS — paste this into a fresh Claude Code session

You're continuing a long-running project: **Web-AIOS**, a desktop operating system that runs
in a browser tab. This session's goal is the next round of upgrades, while keeping every
existing feature and test working.

```
Repo:   /Users/chriscarty/Desktop/All Finished Apps/Web-AIOS
Remote: https://github.com/CartyChris/web-aios.git   (branch: main)
Live:   https://web-aios.vercel.app     — Vercel auto-deploys main. A push to main is a production deploy.
Stack:  Next.js 16.3.5 App Router · React 19.3 · TypeScript 5.9 strict · Tailwind v4 over CSS vars · zustand 5 + persist
```

**Verified state on 2026-09-27:** HEAD is the docs commit right after `245be2c`, working tree
clean. **Not pushed:** `origin/main` is `9974135` unless Chris has pushed since (`git status -sb`
shows how far ahead). All five checks were green together:

| Check | Result |
|---|---|
| `npm run check` | OK: 45 apps, 58 themes, 658 buttons with accessible names |
| `npm test` | 1446/1446 |
| `tsc --noEmit` | clean |
| ESLint | 0 errors, 0 warnings |
| `next build` | OK |

The work since the last hand-off is ten commits, `1d78a9a` to `245be2c`, plus the docs commit
(HANDOFF §22). `git log -11` explains each one in prose, including how it was verified.

---

## 0. Your first ten minutes

1. **Rematerialize the repo from iCloud**, before anything else (see §1a).
2. **Read these, in this order:**
   - `docs/HANDOFF-2026-09-20.md` §16–§22. That's everything built in the last six sessions, what was verified, and what wasn't.
   - `docs/ROADMAP-2026-09-25.md`. It lists the 10 roadmap features and their sources. All 10 have a first slice.
3. **Prove the baseline yourself** (§1c). If a number differs from the table above, find out why before you change anything.
4. **Write a numbered stage plan**, giving each stage a check that can fail. Then build.
5. **Ask Chris which items from §7 to do first**, unless the request already says.

---

## 1. Do these before anything else

### a) Keep iCloud from hanging your tools

The repo lives under `~/Desktop`, which iCloud syncs. The macOS File Provider evicts files
to "dataless" placeholders, even mid-build, and then `tsc`, `next build`, `git commit` and
plain `cat` hang at **0% CPU**. That is the tell: a slow process burns CPU, a blocked one doesn't.
This happened **three times** in the 09-25 session (122 files mid-build), and on 09-26 about
**300 files within minutes**, enough to time out `git commit` writing `index.lock`. On a long
session, run a keeper loop in the background (read-only; stop it when done):

```bash
end=$(( $(date +%s) + 14400 )); while [ "$(date +%s)" -lt "$end" ]; do
  find src tests scripts docs public .git -type f -flags +dataless -print0 | xargs -0 -n 20 -P 8 cat >/dev/null 2>&1; sleep 20; done
```

```bash
cd "/Users/chriscarty/Desktop/All Finished Apps/Web-AIOS"
# bring evicted files back (safe to run any time; run it again whenever something hangs)
find src tests scripts docs .git -type f -flags +dataless -print0 | xargs -0 -n 20 -P 8 cat >/dev/null
# already set, but re-set if missing (check with: xattr -l node_modules)
xattr -w 'com.apple.fileprovider.ignore#P' 1 node_modules
mkdir -p .next && xattr -w 'com.apple.fileprovider.ignore#P' 1 .next
```

- **Wrap anything that might hang** so it can't hang forever:
  `perl -e 'alarm shift; exec @ARGV' 300 ./node_modules/.bin/next build`
- **If `node_modules` itself is evicted** (`ls -lO node_modules/next/dist/bin/next` shows
  `dataless`), run `npm ci`. It takes about 4 seconds from cache.
- **Use `./node_modules/.bin/next`, not `npx next`.**
- **The durable fix is Chris's decision:** Finder "Keep Downloaded" on the folder, or moving the
  repo off Desktop. Mention it once; don't move the repo yourself.

### b) The living source of truth

`docs/HANDOFF-2026-09-20.md` (~880 lines). Section map:

| § | Contents |
|---|---|
| 2 | Rules |
| 4 | Open items |
| 5 | Environment |
| 6 | House rules |
| 7 | Bug catalogue ("do not rediscover these") |
| 9 | Routing table (want X → edit Y) |
| 10–15 | Updates, a11y, context menus, folding, MCP, Patterns |
| 16 | Jobs, AIOS Chat, phone/desktop |
| 17 | Agent Loop, System One, browser |
| 18 | Security, Desk, For You/Intel |
| 19 | Roadmap build |
| 20 | Dock, video sound |
| 21 | Snap geometry, Rewind v2, Timeline tool, chart/timeline/diff panels, cheat sheet, startup -18% |
| 22 | iPhone fit, office suite, Bridge CLI provider, ThreeUI + Effects, pets, resumable AIOS Chat |

`HANDOFF.md` at the repo root is stale and has a banner pointing to the docs file.
There's no `docs/WORKLOG.md` here; that convention belongs to the sibling Eigenstate project.

### c) Baseline

```bash
npm run check                      # integrity gate, under a second
npm test                           # 1446 pass (gate + tsc -p tsconfig.test.json + node --test)
./node_modules/.bin/tsc --noEmit
npm run lint                       # must be 0 errors AND 0 warnings
./node_modules/.bin/next build
```

---

## 2. Chris's standing rules. These are not style preferences.

1. **No emoji, anywhere.** That covers code, UI and commit messages. `npm run check` fails on one.
   Icons are drawn glyphs via `<Icon name=…/>` from `src/shell/icons.tsx`, and every name must resolve.
2. **Verify with a check that can fail, then say plainly what you did NOT verify.** Never report a
   success you didn't measure. Chris checks claims. When Chris pushes back, re-measure instead of defending.
3. **Never run a local model server (Ollama / LM Studio)** or download or run a local model. That
   includes Chrome's on-device Gemini Nano. It has crashed Chris's machine, and Chris tests those.
4. **Never read `openai-api-key.txt`** (in the iCloud "Agentic AI OS : Apps" folder). Never print,
   copy or commit an API key or secret.
5. **Additive only.** Never delete a feature or a test to make something pass. If a test is
   wrong, fix the test's mistake and keep what it covers.
6. **Commit messages are prose explaining *why*** and end with
   `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Use `git commit -F <file>`: heredocs
   with control characters get rejected.
7. **Every number shown on screen must be a real measured result**, pinned by a test.
8. **Pushing to main deploys to production.** Push when the request says to, or ask. After pushing,
   **ask Chris to confirm the live site in Chris's own browser.** Don't poll production in a loop:
   about 45 requests in 15 minutes tripped Vercel's Security Checkpoint (403).
9. **Subagent and workflow work must be durable** (global rule in `~/.claude/CLAUDE.md`, after a
   run lost millions of tokens on 2026-09-25):
   - Every agent prompt tells the agent to append each finding or change *as it goes* to
     `~/.claude/agent-salvage/notes/<run>/<label>.md`.
   - Agents write a first draft after at most about 15 tool calls.
   - On any failure, run `python3 ~/.claude/scripts/salvage-agents.py --recent 6` and read the
     salvage before re-running or claiming loss. Hooks already run it on SubagentStop, Stop and
     StopFailure.
   - Commit integrated work before launching the next wave.
   - Don't spawn agents or workflows unless the request asks for them.

---

## 3. House rules for the code (the ones that bite)

- **`src/lib/**` is pure:**
  - No `@/` imports, no DOM, React or zustand.
  - No `Date.now()`, `Math.random()` or `performance.now()`; the caller injects them.
  - Relative imports have **no** `.js` extension.
- **Every new pure module must be added to the `include` array in `tsconfig.test.json`**, or its
  tests won't compile. Tests import from `../.test-build/<name>.js`.
- **React Compiler lint rules are errors:** `set-state-in-effect`, `refs`,
  `preserve-manual-memoization`, `purity` and `static-components`.
  - For fetching, the effect owns the whole lifecycle with a reload token (`NewsWidget` is the reference).
  - Adjust to a changed prop during render, against the last value taken.
- **`ask()` traps:**
  - A `role:"system"` message inside `messages` is dropped; use the `system` option.
  - `persona` defaults to true; pass `persona:false` for machine-shaped output.
  - A budget stop throws.
- **CSS:**
  - Write `backdrop-filter` unprefixed only. Lightning CSS otherwise ships the `-webkit-` form
    alone, and Chromium ignores it. The gate enforces this.
  - Verify CSS in the built output, not dev.
- **Right-click:** one capture-phase listener (`src/shell/useGlobalContextMenu.ts`). Contribute a
  section with `registerContextTarget(el, builder)` from `@/kernel/ctxmenu`. Never add another
  `contextmenu` handler.
- **Themes:** list with `allThemes(useCustomThemes(s => s.themes))`, never bare `THEMES`.
- **Work in flight goes through the jobs kernel** (`src/kernel/jobs.ts`), so the user always sees it:
  - `useJobs` has start/update/finish/remove.
  - `progress` undefined draws a spinner, never a fake bar.
  - A blocked job carries Approve/Deny actions.
  - `goTo(target)` focuses the exact window.
  - Notifications: `bus.emit("notify", { title, body, target, jobId })`, where the target is
    serializable because it persists.
- **Useful bus events:**
  - `app:open` `{appId,args}`
  - `aios-chat:ask` `{prompt, context:{label,text}}`: context goes in as fenced data, never as instructions.
  - `shell:show-app`
- **AI-written files must carry provenance.** Write through `aiMark()` in `src/kernel/vfs.ts`, so
  Files shows the AI badge.
- **Model output is untrusted.** Render it as text, never as HTML. Any HTML it produces goes in a
  sandboxed iframe **without** `allow-same-origin`.

---

## 4. Security invariants. Tests fail if you loosen these; don't.

| Invariant | Where |
|---|---|
| The env (deployment) API key goes ONLY to the provider's built-in URL. A custom base URL needs the caller's own key. | `deploymentKeyAllowed` in `src/lib/server-guard.ts`, used by `/api/ai/chat` and `/api/ai/models` |
| User base URLs must be http(s) and public. DNS is re-checked at connect time (anti-rebinding). Redirects are refused. | `checkBaseUrl`, `pinnedFetch` in `server-guard.ts` |
| Proxied web pages: iframe sandbox without `allow-same-origin`, AND a `CSP: sandbox` header on every `/api/web` response. localStorage holds the keys. | `src/lib/webproxy.ts`, `src/app/api/web/[sid]/[...path]` |
| postMessage from iframes is trusted only by `event.source` | Browser, `McpAppView.tsx`, Loop preview |
| MCP App views: CSP meta tag first, sandboxed, may call only their own server's tools | `src/lib/mcp-apps.ts` |
| AIOS Chat tools that change things block on Approve/Deny and time out at 60s with Redo. Email is only ever a draft plus mailto. | `src/lib/aios-agent.ts`, `src/shell/AiosChat.tsx` |
| A handed-off desktop URL is parsed as untrusted and asks before opening anything | `src/lib/handoff.ts` |
| Steel cloud-browser keys stay per-browser (`ai.keys.steel`) or env | `src/lib/cloudbrowser.ts` |
| A self-improvement proposal may not touch eval, judge or verifier paths | `src/lib/harness/frozen-eval.ts` |

---

## 5. How to verify in a browser (this is where sessions go wrong)

1. **Run a production build**, not dev: `next build`, then `./node_modules/.bin/next start -p 3190`.
   Dev mode hides minifier bugs.
2. **Call `resize_window` first** (e.g. 1280×800 or 402×874 for a phone). The pane often
   reports a 0×0 viewport.
3. **After switching sizes, reload.** `useViewport` also listens to `(pointer: coarse)` now.
4. **Screenshot coordinates can be scaled anisotropically** (1.6× by 1.333× has been measured).
   Probe with a `pointermove` listener before any coordinate click, or drive state through `window.__aios`:
   - `stores`: settings, wm, vfs, jobs, userApps, widgets, mcp, and more
   - `open()`, `close()`, `bus`, `ask`, `snapshot()`, `waitFor()`
   - `webmcp` status
5. **No real model? Use the scripted stub** (the method used for every AIOS Chat, Agent Loop and
   System One verification): `node scripts/stub-model.mjs [rules.json] [port]`.
   - An OpenAI-compatible server on `:3199` that returns canned replies chosen by regex rules. It
     is **not** a model, so it doesn't break rule 3. Rule files kept in `scripts/`: `stub-panels.json`, `stub-office.json`, `stub-resume.json`.
   - Point provider `lmstudio` at `http://localhost:3199/v1` in the test browser's settings, and
     put Chris's provider back afterwards (it was `openai` / `gpt-5.2`). Save the old values in
     localStorage, not on `window`: a reload loses `window`.
6. **Register predictions before you act**, then compare.
7. **Before trusting a new test, make it fail against the old code.** A mutation that "doesn't
   apply" usually means the compiled line was split; check `.test-build`.
8. **Traps already hit:**
   - **Restart the server by port, never by name.** `pkill -f "next start"` never matches (Next
     renames itself `next-server`), the new server dies on EADDRINUSE, and you test the OLD build.
     Use `lsof -ti tcp:3190 | xargs kill`, and check the server's start time after restarting.
   - Pane automation: `key "shift+slash"` sends an empty key (use `key "?"`); `type` fires no
     keydown and lands wherever focus is (it once changed the saved model); `Cmd+K` is taken by
     the pane; screenshots can lag the DOM by a frame.
   - Hit-testing can't see a painted-over overlap (MCP Hub); use a screenshot.
   - Phone "overflow" is often a sideways-scrolling strip.
   - `.os-label` uppercases via CSS, so case-sensitive `innerText` checks fail.
   - The in-app pane blocks sandboxed subresources (ERR_BLOCKED_BY_CLIENT), so the Browser's
     Web mode looks broken there but works in real Chrome.

---

## 6. What exists now (newest first; details in HANDOFF §)

| Subsystem | Where | § |
|---|---|---|
| **Office suite:** Office start centre, Writer, Sheets, Impress, Draw, Math, Base, each with an AI panel; .docx .xlsx .pptx and ODF in/out | `src/lib/office/*` (pure), `src/apps/office/*` | 22 |
| **Bridge CLI provider:** AI through local Claude Code / Codex via the Bridge daemon's `/ai` | `src/lib/bridge-cli.ts`, `useAI.ts` "bridge" branch | 22 |
| **iPhone installed-app fit:** iOS 26 gap cover, status-bar choice, live readout | `lib/viewport-fit.ts`, `kernel/viewport.ts`, `shell/ScreenFit.tsx` | 22 |
| **ThreeUI wallpapers + Effects tab** (grain, vignette, cursor, window animation, icon shape, sounds, day/night) | `lib/customize.ts`, `shell/CustomizeLayer.tsx`, `shell/ThreeUIWallpaper.tsx` | 22 |
| **Pets with a life:** needs, bond levels, accessories, tricks, fetch, OS reactions | `lib/petlife.ts`, `kernel/petlife.ts`, `shell/pets.tsx` | 22 |
| **Resumable AIOS Chat:** per-step checkpoints, kept transcript, "Resume from step N" | `lib/aios-resume.ts`, `shell/AiosChat.tsx` | 22 |
| **Startup diet:** harness runtime, Desk and data/news widgets load on first use (338 to 276 KB gz); a graph test keeps it that way | `src/lib/harness-triggers.ts`, `src/shell/Widgets.tsx`, `tests/shell-graph.test.mjs` | 21 |
| **Global cheat sheet:** `?` or `mod+/` anywhere, palette command, filter by keys | `src/shell/ShortcutSheet.tsx`, `sheetRows` in `src/lib/keyhelp.ts` | 21 |
| **Chart, timeline and diff panels** (app-drawn from data) and **Pin to Desk** | `src/lib/panelchart.ts`, `src/shell/PanelView.tsx`, `src/kernel/deskpins.ts` | 21 |
| **Timeline tool** in AIOS Chat and DeepSeek Harness, fuzzy dates, provenance lines | `parseWhen` / `timelineAnswer` in `src/lib/timeline.ts` | 21 |
| **Rewind v2:** per-file restore, side-by-side Compare, named = pinned, per-file undo | `src/lib/rewind.ts`, `src/lib/textdiff.ts`, `src/shell/DiffTable.tsx` | 21 |
| **Scripted model stub** for verifying agent flows without a key | `scripts/stub-model.mjs` | 21 |
| **One dock on phones:** minimized windows live inside the dock under 768px (`NARROW_DOCK`); the tray only on wide screens | `src/shell/Dock.tsx`, `Desktop.tsx` | 20 |
| **Video with sound:** cloud (Steel) live view is picture-only, so "Play with sound here" opens YouTube, Vimeo or direct media in its official player locally | `src/lib/media-embed.ts`, `src/apps/Browser.tsx` | 20 |
| **Rewind:** IndexedDB snapshots every 10 min when changed; exact diff, restore, undo | `src/kernel/rewind.ts`, `src/apps/Rewind.tsx`, `src/lib/rewind.ts` | 19 |
| **WebMCP:** 6 read-only tools via `document.modelContext.registerTool`, feature-detected | `src/shell/webmcp.ts` | 19 |
| **On-device model:** provider "browser" = Chrome Prompt API; status and download button in Settings > AI | `src/lib/ondevice.ts`, `src/shell/OnDeviceSetup.tsx` | 19 |
| **Timeline memory:** dated, sourced entries; "yesterday", "tuesday notes", "last week loop" | `src/lib/timeline.ts`, Desk, WebMCP `aios_timeline` | 19 |
| **Generative panels in AIOS Chat:** allowlisted table, checklist, choices and form; text only | `parsePanel` in `src/lib/aios-agent.ts` | 19 |
| **Voice:** push-to-talk (SpeechRecognition) and read-aloud | `src/shell/AiosChat.tsx` | 19 |
| **Provenance:** AI writes marked, an edit keeps the mark with `editedAt`, AI badge in Files | `src/lib/provenance.ts`, `aiMark()` | 19 |
| **MCP Apps:** `ui://` views in a sandboxed iframe over JSON-RPC postMessage; demo `calc` view | `src/lib/mcp-apps.ts`, `src/apps/McpAppView.tsx` | 19 |
| **Frozen-eval gate** for harness self-improvement: sealed baseline, held-out third, no per-task regressions | `src/lib/harness/frozen-eval.ts` | 19 |
| **Resume** a DeepSeek Harness turn from its log | `src/apps/DeepSeekHarness.tsx` | 19 |
| **Desk:** "what needs you", computed rather than written by a model, plus "what I cannot see" | `src/apps/Desk.tsx`, `src/lib/desk.ts` | 18 |
| **For You** (manifest of what would be sent), **Intel** watches, **Media Deck** shuffle bag | `src/lib/foryou.ts`, `intel-watch.ts` | 18 |
| **DeepSeek Harness:** 42 MIT files vendored verbatim, plus dsh-lite; unified **Harness Hub** | `src/vendor/dsh/` (NOTICE.md), `src/lib/dsh/*`, `src/apps/HarnessHub.tsx` | 17–18 |
| **Agent Loop:** always a result (verified, final-pass, best-attempt or fallback), price cap, stop-when-done, Gauntlet, Jev and LLM judge panel separate from the builder, per-round Preview/Run/Download | `src/lib/agent-loop.ts`, `loop-policy.ts`, `src/apps/Loop.tsx` | 17 |
| **Reasoning-model transport:** reasoning and finish parsing, empty-answer rescue, max_tokens step-down, Gemini thought signatures, DeepSeek `reasoning_content`, unique tool-call ids | `src/lib/ai-transport.ts`, `src/lib/useAI.ts` | 17–18 |
| **System One + Harness Router:** Jev decides (or emulated / scripted), a combiner merges harness outputs | `src/lib/s1/*`, `src/lib/s1-os.ts`, `src/apps/SystemOne.tsx`, `/api/ai/systemone` | 17 |
| **Browser opens anything:** auto, frame, web (rewriting proxy), reader, and cloud (Steel Chromium over CDP) | `src/lib/webproxy.ts`, `src/lib/cloudbrowser.ts`, `src/apps/Browser.tsx` | 17 |
| Refreshable model lists per provider; 8 WebGL2 shader wallpapers and themes; desktop hand-off by URL fragment | `model-lists.ts`, `ModelRefresh.tsx`, `wallpaper-shaders.ts`, `lib/handoff.ts` | 17 |
| **Live jobs + clickable notifications**, **AIOS Chat** agent in the top bar, phone/desktop switching | `src/kernel/jobs.ts`, `src/shell/AiosChat.tsx`, `src/lib/shell-mode.ts` | 16 |
| Older, still load-bearing: MCP MRTR, Swarm context modes, editable keybinds, per-app right-click menus, update trial with Keep/Revert, Patterns, context folding, MCP 2026-07-28, Zones, Scenes, AI System Updates | `mcp-mrtr.ts`, `swarm-context.ts`, `_updateTrial.tsx`, … | 10–15 |

---

## 7. Next upgrades, in priority order

### A. Close the "not verified" gaps (live evidence; most need Chris's keys or devices)

Ask Chris to supply these. Never go looking for keys yourself.

1. A **real model** driving AIOS Chat, the Agent Loop (including judges) and System One. So far
   they've only been driven by the scripted stub.
2. **Real Jev** with a TypeSafe key (`POST https://api.typesafe.ai/v1/systemone`, model `jev-latest`).
3. A **live Steel session** (release-endpoint path is from SDK naming) and the web proxy's cookie
   jar on Vercel under third-party-cookie blocking.
4. An **MCP App calling `tools/call` back through the host** (only the router is tested), and the MCP
   client against a real 2026-07-28 server.
5. **Resume** in a live DeepSeek Harness run, and the **frozen-eval gate** on a real eval run.
6. **Voice** with a real microphone, and audible YouTube playback. Chris can test these on a phone.
7. **On-device generation.** Chris runs it; you don't (rule 3).
8. An AI System Update from a real model through `parseUpdate`, and PetMaker's model-error path.

### B. Known debt (small, real)

Done since the last hand-off: **24** backwards window cycling. Still open:

10. **`wm.setArgs` has no callers.** Give it one (Files opening a path in an open Notes window).
25. **DNS-rebinding pinning** for custom base URLs (review #7, second half).
26. **Drag re-renders:** only if a slow device shows jank (1.45 ms per move with 15 windows).
27. **Office fidelity:** docx/odt carry no comments, tracked changes, headers/footers or page size
    choices; pptx exports no speaker notes (odp does); xlsx exports no cell styles beyond a percent
    format; Draw imports nothing. Each is a bounded exporter change with a round-trip test.
28. **Gemini CLI** in the Bridge allowlist: install it, read its `--help`, add fixed arguments and a
    test with a fake binary, as for claude/codex.

### C. Second slices still open

14. WebMCP write tools. 16. The self-improvement proposer. 20. On-device beyond Chrome (Chris
tests). 21. C2PA (verify a signer exists first). 22. Realtime voice (Chris's key). 23. Third-party
MCP Apps. And 15b: **Agent Loop checkpoints**, the other half of resumable runs.

### D. Implementation map (updated 2026-09-27)

**1. Verify the iPhone fix on the device (minutes, Chris).** Settings > Phone & Screen on the
iPhone Air: read "Gap" and "Covering it with". If a band remains with Full-bleed, try Solid and
reopen from the Home Screen. Record the numbers in HANDOFF; if 100lvh did not recover the band,
make Solid the default for iOS 26 standalone.

**2. C15b Agent Loop checkpoints (half a session).** Reuse `lib/aios-resume.ts`: checkpoint each
round in `src/lib/agent-loop.ts`'s caller, clear on completion, offer "Resume from round N" in
`src/apps/Loop.tsx`. A round that was building code re-runs; a round that was spending money asks
first. Check: a stub-driven loop reloaded mid-round resumes and the stub log shows the rounds
carried.

**3. Office second slices (a session).**
- Stage 1: pptx speaker notes (notesMaster + notesSlide parts), with a python-pptx read-back.
- Stage 2: xlsx cell styles (bold, fills, number formats) via a real styles.xml, with an
  openpyxl read-back of the styles.
- Stage 3: Writer headers/footers and page size/margins.
- Stage 4: Writer comments (docx comments.xml; odt office:annotation).
- Stage 5: Sheets conditional formatting and freeze panes.

Every stage must keep the round-trip tests exact.

**4. C14 WebMCP write tools (half a session).** As in the previous map: re-read the spec, register
write tools behind `requestApproval` (export an `approveThenRun` from AIOS Chat), tests for
denial and timeout.

**5. C16 self-improvement proposer (a session).** As in the previous map (proposal prompt and
parser, run on a copy through `gateProposal`, a Proposals tab); needs a real model to mean
anything.

**6. Needs Chris:** the real CLIs through the Bridge (his accounts), C20 (model download), C22
(key, microphone), and C21 (confirm a browser-side C2PA signer exists first).

When you finish a stage, append a numbered section to `docs/HANDOFF-2026-09-20.md` (next is
**§23**). Use the format of §16–§22: what was built, how it was verified, and what was **not** verified.

---

## 8. Sources (used by past sessions or cited in code; re-fetch before relying on them)

**Specs and APIs**
- WebMCP:
  - https://github.com/webmachinelearning/webmcp
  - https://developer.chrome.com/blog/ai-webmcp-origin-trial
- Chrome Prompt API (on-device): https://developer.chrome.com/docs/ai/prompt-api
- MCP 2026-07-28:
  - https://modelcontextprotocol.io/specification/2026-07-28/basic/index
  - MRTR: https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr
- MCP Apps (ext-apps, 2026-01-26): https://github.com/modelcontextprotocol/ext-apps
- A2UI v0.9 (generative UI): https://developers.googleblog.com (search "A2UI v0.9")
- Jev / TypeSafe System One: https://docs.typesafe.ai
- Steel:
  - https://docs.steel.dev/llms-full.txt
  - https://docs.steel.dev/overview/sessions-api/configuration
  - https://steel.apidocumentation.com/api-reference
- Browserbase (alternative cloud browser):
  - https://docs.browserbase.com/reference/api/create-a-session
  - https://docs.browserbase.com/reference/api/session-live-urls
- YouTube embed parameters: https://developers.google.com/youtube/player_parameters
- OpenAI Realtime: https://developers.openai.com/api/docs/guides/realtime
- transformers.js v4: https://huggingface.co/blog/transformersjs-v4
- WebGPU status: https://github.com/gpuweb/gpuweb/wiki/Implementation-Status

**Code we build on**
- DeepSeek Harness (MIT, vendored at `477b4f4`): https://github.com/deepseek-ai/deepseek-harness.
  See `src/vendor/dsh/NOTICE.md`.
- SystemOneHarness / HarnessRouter (Apache-2.0, design ported): https://github.com/HarnessRouter/SystemOneHarness

**Research behind the roadmap**
- arXiv 2607.26041, OSWorld 2.0. Long-horizon agents complete about 20.6%, which is why runs must be resumable.
- arXiv 2606.09498. Harness tampering in self-improving agents, which is why the eval is frozen.
- arXiv 2608.08055, SodaMem. Evidence-grounded temporal memory, which is why every Timeline entry has a source.
- Lil'Log, "Harness Engineering for Self-Improvement" (2026-07).
- C2PA 2.2 (content credentials).

---

## 9. How to finish a session so the next one inherits a clean state

1. **Don't ship tested-but-unused code.** Past sessions caught `zoneAt` and `fold` built, tested
   and left unwired.
2. **When a test fails, first ask whether the *test* is wrong.** It has been, several times.
3. **Re-run all five checks and state the counts.**
4. **Update the docs:**
   - Append §23+ to `docs/HANDOFF-2026-09-20.md`.
   - Update this file's "Verified state" block and §6–§7.
   - Keep `docs/ROADMAP-2026-09-25.md` status honest.
5. **Commit with a prose message** (`git commit -F`). Push only if asked, then ask Chris to confirm
   the live site.
6. **Tell Chris plainly what was not verified.**
