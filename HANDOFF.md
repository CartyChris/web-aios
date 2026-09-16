# Web-AIOS — Development Handoff

Paste this whole file as your first message in a fresh Claude Code session to pick up
where the last one left off without breaking anything.

Every number and claim below was verified against the code at commit `a98e7e7`. The counts
in §1, the gate output in §5 and the full test suite (**204 pass, 0 fail**) were all re-run
on **2026-09-16**. If a later handoff exists, trust file contents over any of them.

---

## 0. If a build seems to hang, read this before debugging your change

This working copy lives in an **iCloud-synced `Desktop` folder**. macOS evicts synced files
it thinks are cold, replacing their contents with stubs. When a build then touches a few
hundred evicted files, every first read blocks on an iCloud fetch — so `tsc`, `next build`
and `npm test` can appear to hang for minutes, then work perfectly on the next run once the
files are rehydrated.

**That is the whole failure mode. It is transient, and it is not your change.**

Measured on 2026-09-16, in this order:

```bash
ls -lO node_modules/typescript/lib/tsc.js
# -rw-r--r--@ 1 chriscarty staff  -  267        <-- size column "-" = dataless stub
du -sh node_modules
# 10M                                           <-- should be ~500MB+; stubs allocate nothing

npx tsc -p tsconfig.test.json                   # 1st attempt: hung past 150s, killed
npx tsc -p tsconfig.test.json                   # after rehydration: completed, clean
node --test 'tests/*.test.mjs'                  # 204 tests, 204 pass, 0 fail
du -sh node_modules
# 16M                                           <-- partially rehydrated
```

**How to recognise it:** a command that normally takes two seconds returns nothing for
minutes, with no error. Confirm with `ls -lO node_modules/typescript/lib/tsc.js` — a `-`
in the size column, or `dataless` in the flags, means the file is a stub.

**What to do:** run it again. The second attempt usually succeeds. To force it up front:

```bash
find node_modules -name "*.js" -print0 | xargs -0 -P8 cat > /dev/null 2>&1   # warm the cache
```

**The permanent fix** is to move the project off iCloud. The README has recommended this
for months and this is the second distinct failure it has caused (the other is in §9):

```bash
mv "/Users/chriscarty/Desktop/All Finished Apps/Web-AIOS" ~/Developer/Web-AIOS
cd ~/Developer/Web-AIOS && rm -rf node_modules .next && npm install
```

**On disk space:** the local SSD is at **97%** — `df` reports 15 GB free of 494 GB, and
System Settings → General → Storage agrees (475.52 GB of 494.38 GB used). That is separate
from iCloud storage (133 of 200 GB, which is fine — the cloud is not the constraint, the
local disk is). Low free space makes macOS evict more aggressively, so it worsens the
above, but eviction happens on an iCloud-synced folder regardless. This project is only
18 MB itself; the space is going elsewhere.

---

## 0b. First five minutes — do this before planning anything

```bash
cd "/Users/chriscarty/Desktop/All Finished Apps/Web-AIOS"
npm install                 # if node_modules is absent
npm test                    # expect: OK gate line, then 204 pass / 0 fail
npx tsc --noEmit            # must be silent
npx eslint .                # must be silent — the baseline is ZERO
npx next dev -p 3131        # then open http://localhost:3131
```

If `npm test` hangs for more than ~90s, see §0 — run it again before assuming anything is
broken.

Then read §1 (what this is), §3 (the harness — the newest and least obvious part), and
§8 (what is NOT done). Everything else is reference; grep it when you need it.

---

## 1. What this is

A fully customizable AI/agent desktop operating system for the web. **29 apps** over a
small kernel, ~29,700 lines of TypeScript, deployed to Vercel as a Next.js app and
installable as a PWA.

| Fact | Value |
| --- | --- |
| Live | https://web-aios.vercel.app |
| Repo | https://github.com/CartyChris/web-aios (branch `main`) |
| Vercel | team `cloud-ops-game-time`, project `web-aios`, auto-deploys on push to `main` (~20-25s) |
| Local path | `/Users/chriscarty/Desktop/All Finished Apps/Web-AIOS` |
| Stack | Next.js 16.3.5 (App Router, Turbopack) · React 19.3 · TypeScript 5.9 strict · Tailwind v4 over CSS custom properties · zustand 5 + persist |
| Runtime deps | `clsx lucide-react next react react-dom tailwind-merge three zod zustand` |
| Tests | 13 files, **204 tests**, all passing, `node:test` only — no framework |

There is no backend. Everything is in the browser except four route handlers
(`/api/ai/chat`, `/api/ai/models`, `/api/ai/media`, `/api/mcp`, `/api/proxy`), which exist
only to hold optional deployment keys and to dodge CORS.

---

## 2. Architecture in one screen

```
src/
├── kernel/          the OS itself — no rendering
│   ├── wm.ts            window manager: geometry, z-order, workspaces, snapping
│   ├── settings.ts      every customization field + token resolution
│   ├── profiles.ts      17 OS personalities
│   ├── themes.ts        palettes, wallpapers, font stacks
│   ├── pets.ts          37 species as DESCRIPTIONS, not drawings
│   ├── registry.tsx     app manifests; each entry is a lazy import
│   ├── vfs.ts           one filesystem every app shares
│   ├── userapps.ts      apps the user built in AI Studio
│   ├── harness.ts       harness run ledger (metadata only — bodies go to the VFS)
│   ├── bus.ts           typed pub/sub, 29 lines
│   └── types.ts
├── shell/           the desktop
│   ├── Desktop.tsx      root, token application, keybindings, easter eggs
│   ├── MobileShell.tsx  the phone paradigm below 768px
│   ├── ModelPicker.tsx  searchable list of every model a provider offers
│   ├── pets.tsx         parametric sprite renderer, 3 fidelities
│   ├── icons.tsx        107 drawn glyphs. NO EMOJI ANYWHERE
│   └── …
├── apps/            29 modules, one file each
├── lib/
│   ├── harness/         THE HARNESS — 15 pure modules, 8,146 lines (see §3)
│   ├── harness-runtime.ts  binds the pure harness to ask()/VFS/bus
│   ├── aios-api.ts      window.__aios — the external control surface (see §5)
│   ├── useAI.ts         ask() — the ONLY model call path. Emits spans.
│   ├── forge-*.ts       the WebGL 3D engine (geometry/scene/viewport/thumbnail)
│   ├── preview.ts       the in-browser bundler for AI Studio
│   ├── zip.ts + deflate.ts   ZIP writer over a Rust/WASM DEFLATE
│   └── mcp.ts           MCP client (JSON-RPC over Streamable HTTP)
├── wasm/deflate/    a DEFLATE encoder in Rust → public/deflate.wasm (committed)
└── scripts/check.mjs  the integrity gate (see §5)
```

**Three ideas carry the whole thing.** Learn these before editing anything:

1. **Everything visual is a CSS custom property.** No component knows a theme exists;
   they read tokens. That is what makes "fully customizable" tractable.
2. **A profile is a bundle of tokens plus layout.** Picking "Windows 95" changes palette,
   radius, titlebar style, dock position and glass in one move.
3. **The kernel never renders and the shell never computes.** Which is why the same app
   file works in a floating window and full-screen on a phone.

An app never learns its own size — the window body is a CSS container
(`.app-split` / `.app-sidebar` / `.app-aside`), so a two-pane app stacks when its
*surface* is narrow. **Never write a viewport media query in an app file.**

---

## 3. The harness — the newest and least obvious subsystem

`src/lib/harness/` is a ReAct agent loop built from scratch. It is the six-layer harness
model made concrete:

| Layer | Question it answers | File |
| --- | --- | --- |
| Trigger | What started this, and was it a duplicate? | `types.ts` (`TriggerEvent.dedupeKey`) |
| Orchestration | How far may the agent go? | `loop.ts` + `config.ts` |
| Tools | Which numbers are computed, not improvised? | `tools.ts`, `fixtures.ts` |
| Trusted context | What may it see, what was withheld? | `context.ts` |
| Control | Who decides it is done? | `dod.ts`, `bid.ts` |
| Runtime | Can I read the receipt of a bad run? | `trace.ts`, spans in `useAI.ts` |

### Hard rules that must not regress

- **Every module under `src/lib/harness/` is PURE.** It imports nothing from `@/`, touches
  no `window`/DOM/React/zustand, and never calls `Date.now()`, `Math.random()` or
  `performance.now()` directly — those arrive as injected dependencies. This is what makes
  204 tests possible against a scripted fake model with no browser, and what would let the
  same tool code serve an MCP route. **Breaking this silently makes the module untestable.**
- **Relative imports inside `src/lib/**` carry NO `.js` extension** (`from "./types"`).
  The test build emits CommonJS.
- **Every orchestration limit is a `LoopConfig` field, never a literal in the loop body.**
  How far the agent may go is configuration, or it is not a policy at all.
- **A definition of done that cannot fail is rejected** (`dodValidate`). One that always
  passes is worse than none — it manufactures confidence.
- **Cap exhaustion answers `""`.** Never a best guess. A fabricated answer at the limit is
  how a harness reports success it did not achieve. A test pins this.
- **`taskFromFailure` refuses an unsigned correction.** An unsigned correction is an
  opinion, not a decision.
- **The judge must not share the worker's model** (`mergeConfig` swaps it). A verifier
  running the producer's own weights agrees with it, and that looks exactly like success.

### The loop's stop conditions (complete)

`finished` · `cap_exhausted` · `budget_stopped` · `timeout` · `tool_error_cascade` ·
`loop_detected` · `aborted` · `failed`. Every one has a test that drives it.

### Tools

10 built-ins, **9 deterministic**: `kpi calc table_query policy_check date_math
search_docs read_doc lookup write_artifact think`. `finish` is deliberately NOT a
registered tool — it changes run state rather than producing an observation.

Deliberate design choices that look like bugs but are not:
- `calc` is a hand-written shunting-yard parser. **No `eval`, no `Function`** — that is an
  injection surface in a page that concatenates model output.
- `search_docs` is **deliberately weak** lexical scoring that can miss. The near-miss is
  what forces the model to reformulate in a visible thought, which is the mechanism ReAct
  exploits. Do not "improve" it into a strong semantic retriever.
- `read_doc` returns a **5-sentence window**, not the whole document. The budget creates
  the reasoning pressure.
- `date_math` takes its clock from `ToolContext.now`, never `Date.now()`, so a trace is
  replayable.

### Traces

`ask()` emits a span for **every model call in the entire OS** — open before the request,
closed after, **same id** (Observatory upserts by id). A call that hangs or throws is still
visible; a span only written on success would make exactly the runs you need to debug the
ones that leave no trace.

Full traces are written to the VFS at `/harness/runs/<runId>.md` with API keys redacted at
write time. `kernel/harness.ts` keeps only a summary plus the path — a full trace per run
in localStorage will exhaust the shared origin quota and take unrelated stores down.

### Verified end-to-end on production, with no API key

```
status: failed · answer: "" (empty, not guessed) · pass: false
reason: 0/1 criteria met. FAILED (required) "kpi was called": "kpi called 0x (need >= 1)"
spans: 8 · receipt written · 1,271 bytes
```

That is the thesis working on the failure path. **No run has yet driven a live model.**

---

## 4. Required workflow — read before editing anything

1. **Explore first.** `grep -n "export function" src/lib/harness/loop.ts` gives a module's
   API in a dozen lines. Do not read 1,600-line files whole.
2. **Edit with assert-guarded replacement, never blind line ranges.**
   ```python
   s = open(p).read()
   assert s.count(old) == 1, f"anchor matched {s.count(old)}x"
   s = s.replace(old, new)
   open(p, "w").write(s)
   ```
   The assert is load-bearing — it stops a silent multi-match corruption.
3. **Run the full gate after every meaningful edit:**
   ```bash
   npm test && npx tsc --noEmit && npx eslint .
   ```
   All three must be silent. The eslint baseline is **zero**; any new warning is a regression.
4. **Verify in a real browser over http://localhost, driving the app.** Static review has
   missed real bugs here repeatedly — see §7. Use `window.__aios` (§5), not DOM poking.
5. **Only then commit.** Deploy is automatic on push to `main`.

---

## 5. The two mechanisms that make verification possible

### `window.__aios` — the external control surface

Installed by `Desktop.tsx` on mount. Borrowed from the sibling GlassBox project, where
module internals were invisible to automation.

```js
const a = window.__aios;
a.version                       // "3.0.0"
a.stores                        // { settings, wm, vfs, userApps, widgets, mcp, eggs } — live zustand handles
a.apps, a.getApp, a.providers   // registry + provider catalogue
a.bus, a.ask                    // pub/sub and the model call path
a.open("calc")                  // returns a window id
a.close(windowId)
a.snapshot()                    // everything, API keys REDACTED
await a.waitFor(() => cond, { timeout: 8000, label: "…" })
a.harness                       // { startRun, tools, runs, defaultConfig } once Harness mounts
```

Note: GlassBox needs hand-written getter/setter pairs per mutable binding or the export
goes stale. **Here that class cannot occur** — every store is a zustand handle whose
`getState()` always reads current, so the surface exposes stores directly.

### `npm run check` — the integrity gate

Catches what a type-checker and a linter cannot: **wiring that is perfectly well-typed and
points at nothing.** Six checks, each printing what it scanned so a check that silently
stops matching is visible rather than quietly passing:

1. Every `<Icon name="…">` and bare `icon: "…"` resolves (107 glyphs). `Icon` falls back
   silently, so a typo is otherwise invisible.
2. Every `appId: "…"` and `wm.open("…")` exists in the registry.
3. Every registry lazy import resolves on disk.
4. Persist keys are unique (17 keys) — two stores sharing one silently clobber.
5. No emoji in `src/`.
6. No `console.log` outside a template literal.

It found two real bugs on its first run. **If it reports a false positive, widen the check
to understand context — do not whitelist the file.** That is how check #6 learned about
template literals (Bridge.tsx legitimately emits `console.log` inside the Node daemon
source it generates).

---

## 6. Conventions a new module MUST follow

- **Store:** `zustand` + `persist`, key `webaios.<name>.vN`, unique across the repo.
  Cap every growing array **at write time** (`.slice(0, 200)`) or a long session fills the
  quota and breaks an unrelated feature.
- **Register an app:** one entry in `src/kernel/registry.tsx` with a `lazy(() => import(…))`
  component and `ssr: false`. Launcher, dock, palette, pin picker, mobile shell and monitor
  all light up from that single entry.
- **UI vocabulary:** `src/apps/_ui.tsx` — `Tabs Empty ErrorNote Spinner Markdown CopyButton
  Field Slider Toggle AppShell`. Classes: `os-btn os-card os-chip os-input os-label`.
  Colors are tokens (`var(--accent)`, `var(--muted)`, …), never literals.
- **Render model output through `<Markdown>`**, never raw — it escapes before introducing
  tags, so model output cannot inject markup into the OS.
- **`ask()` traps:** a `role: "system"` entry inside `messages` is silently DROPPED (put it
  in the `system` option); `persona` defaults **true** and prepends the user's voice —
  pass `persona: false` for any verifier or judge; the budget stop **throws**; cost is
  already committed inside `ask` so never double-count `res.costUsd`.
- **Comments explain WHY, never what.** No decorative banners beyond one file header.

### ESLint rules enforced as ERRORS (react-hooks 7.x, React Compiler)

These bite constantly and the baseline is zero:

- `set-state-in-effect` — no synchronous `setState` in an effect body. Sanctioned escapes
  already exist: `useNow(ms)` for clocks, `useHydrated()`, and remounting via `key=`.
  A bus subscription that calls setState is fine (external subscription).
- `refs` — never read `ref.current` during render, **including building an array of
  closures that read one**. Use stable `useCallback`s or separate components.
- `preserve-manual-memoization` — a state updater must be PURE. Never call another
  `setState` inside `set(x => …)`. Compute first, commit after.
- `purity` — no `Date.now()`, `Math.random()`, `performance.now()` in a render body.
- `static-components` — never define a component inside another component's body.

---

## 7. Bug classes that recur here — check for these first

- **Self-defeating guards.** A validity check computed from a quantity that moves *opposite*
  to the thing it exists to catch. For any threshold or gate: name the exact input it exists
  to handle, confirm it passes, and write both a positive test and a **negative control**.
- **State written from inside a state updater.** Found in two arcade games; React warns and
  it double-counts in StrictMode.
- **Listeners that re-subscribe on every state change.** The easter-egg key-sequence
  listener depended on the whole settings object, so any settings write wiped the partial
  sequence — and party mode writes one every 120ms. Depend on the narrow field; read the
  rest through `getState()`.
- **Pointer capture swallowing clicks.** `setPointerCapture` on an ancestor retargets the
  compatibility mouse events, so a child's `onClick`/`onDoubleClick` never fire. This is why
  desktop icons did nothing. Decide activation in `pointerup` yourself.
- **Painter's-algorithm depth sorting.** Killed by moving Forge 3D to WebGL. Do not
  reintroduce centroid sorting for anything that can overlap.
- **Magic numbers in tests.** Assert the *property* ("a naive sum exceeds wall time"), not a
  constant derived from the fixture.
- **iCloud conflict duplicates.** See §9.

---

## 8. Honest status — what is NOT done

**Nothing has ever run against a live model.** No API key was used in any session. This is
the single biggest gap and the first thing to close.

Built to each provider's documented shape but **never executed against the live service**:
- Image generation (`/api/ai/media`, OpenAI + Google + OpenRouter dialects)
- Video generation and its polling loop (Google Veo, OpenAI Sora)
- AI project generation and widget generation in AI Studio
- Forge 3D's build pass and its vision review
- Asset Studio's composer
- The desktop pet's one-sentence reply
- **The harness loop's actual model call.** The loop is proven against a scripted fake;
  the call itself is covered only by transport tests.

Also not verified:
- A real MCP handshake against a running Godot/Unity/Unreal server. The client is written
  to the 2025-06-18 spec and handles both JSON and SSE reply forms, but no editor answered it.
- The Bridge companion daemon has never been executed; it ships as source.
- Service-worker registration was blocked by the preview browser's sandbox.

**Known-incomplete from the last session:** five build subagents died mid-run on the
account's monthly spend limit. All 14 harness modules landed, but only 3 of 9 intended test
files did. The replacement is `tests/harness-core.test.mjs` (38 tests) written by hand. The
six missing per-module files were folded into that one; coverage is good but not identical
to the original plan. Spec sections 3.12-3.15 (`harness-mcp.ts`, `/api/harness/mcp` route,
`harness-triggers.ts`) were **never built**.

### Highest-value next steps, in order

1. **Add an API key and drive one harness run end to end.** Everything above unblocks.
   Settings → Providers. Then Harness → Run.
2. **Wire Swarm to the harness.** Swarm still has no definition of done and no bidding
   pass; `dod.ts` and `bid.ts` exist and are tested but nothing calls them. This was
   explicitly requested: *"swarms must ALWAYS have a definition of done."*
3. **Build the trigger layer** (`harness-triggers.ts`): bus events, schedules, VFS path
   watches. Layer 1 is currently the only one with no runtime.
4. **Expose the deterministic tools as an MCP server** (`/api/harness/mcp`) so other
   clients get the same numbers. The tool code is already pure and portable by design.
5. **Run the golden set.** `evals.ts` + `tasks.ts` hold 14+ seed tasks with anti-cases and
   a suite runner; no UI runs them yet.
6. **Give Observatory the harness store** as its source of truth. It currently keeps a
   400-span component-local ring buffer, so closing the window loses the trace.

---

## 9. Environment hazards that will waste your time

**This has caused two distinct failures.** §0 covers the first (dataless `node_modules`,
builds stall on first run).

The second: iCloud drops **conflict duplicates** (`CURRENT 3`,
`route.js 2.map`) into `.next/`, which kills the dev server with an opaque
*"Failed to open database"*. Fix:

```bash
rm -rf .next && npx next dev -p 3131
```

`.gitignore` covers `* [0-9]` and `* [0-9].*`, so they never reach git — but they still
break local builds. Symptom to recognise: dev server exits immediately, or serves stale
content, or reports a compile error in a file you already fixed.

**Other traps:**
- A dev server can hold a stale compile error after you fix it. If `next build` passes but
  dev does not, restart dev.
- Kill dev servers by port, not by name: `lsof -nP -tiTCP:3131 | xargs -r kill -9`.
- `scripts/check.mjs` uses `fileURLToPath`, not `.pathname` — the project path contains a
  space and `.pathname` yields `%20`, which every `fs` call then fails to find.
- Rust/WASM: `public/deflate.wasm` is **committed**, so a clone needs no Rust toolchain.
  Only rebuild it if you change `wasm/deflate/src/lib.rs`:
  ```bash
  rustup target add wasm32-unknown-unknown
  cargo build --release --target wasm32-unknown-unknown --manifest-path wasm/deflate/Cargo.toml
  cp wasm/deflate/target/wasm32-unknown-unknown/release/waios_deflate.wasm public/deflate.wasm
  ```

---

## 10. Testing

```bash
npm test     # gate + tsc -p tsconfig.test.json + node --test 'tests/*.test.mjs'
```

**Only pure modules under `src/lib/` can be tested.** `tsconfig.test.json` has
`rootDir: "src/lib"`, no `paths` mapping, `module: nodenext`, no DOM lib. A testable module
may not use `@/…` imports, `window`, zustand or JSX. **A new module must be added to the
`include` array explicitly** — it is a file list, not a glob.

Tests import the flat compiled output: `from "../.test-build/harness/loop.js"`.

Current coverage (204 tests, 13 files): the multi-dialect SSE transport, vision message
translation across all three dialects, the SSRF guard, the Rust DEFLATE round-tripped
through Node's `zlib`, the ZIP writer, the in-browser bundler, 3D geometry and scene
building, model-output coercion, project scaffolds, and the harness (loop, tools, dod, bid,
trace, context, resilience, evals).

**No app, store, bus, VFS or window-manager code is unit-tested.** There is no jsdom.
Those are verified in a real browser through `window.__aios`.

### The testing standard here

Every check that exists to catch a specific failure has **both** a positive case and a
**negative control** proving it can still say no. A check that passes everything is worse
than no check. This is enforced by convention, and in the golden set it is enforced by code:
every eval task carries a mandatory anti-case, and a suite is green only when every task
passes AND every anti-case fails.

---

## 11. Deploying

Push to `main`. Vercel auto-deploys in ~20-25s.

```bash
npx vercel ls web-aios --yes        # check status
curl -s -o /dev/null -w "%{http_code}\n" https://web-aios.vercel.app/
```

`vercel.json` only adds security headers and service-worker caching rules. Environment
variables are entirely optional — a key the user enters in Settings always takes precedence
over the deployment's.

> If you deploy publicly, set at most one key you are willing to have used by anyone who
> finds the URL. `/api/ai/chat` has no authentication, by design, because the app is built
> to be used with your own key.

**Always verify on the production URL, not just localhost.** Several bugs in this project's
history were only visible in the real deployment.

---

## 12. The user's standing preferences

Learned across many sessions. These are not negotiable defaults:

- **No emoji, anywhere.** Icons must be drawn glyphs fitting the app. `npm run check`
  enforces it.
- **Verify with checks that can fail**, then say plainly what was NOT verified. Never
  report success you did not measure.
- **Never run local model servers** (Ollama / LM Studio) from a session — it has crashed
  the machine. The user tests those personally.
- **A plaintext `openai-api-key.txt` exists** in the iCloud "Agentic AI OS : Apps" folder.
  It has been deliberately never read and must stay that way.
- Wants deep, thorough work with many parallel agents when the task is large — but note the
  account hit its monthly spend limit doing exactly that on 2026-09-15.
- Commit messages end with:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

---

## 13. Where the source material lives

Sibling projects in `/Users/chriscarty/Desktop/All Finished Apps/` worth reading before
inventing something:

- **`GlassBox-HANDOFF.md`** — the densest single document. The `window.__gb` export surface,
  `check.py`, the six confirmed self-defeating-guard instances, storage tiering, and the
  bug-class catalogue. Two of its mechanisms are already ported here (§5).
- `GlassBox.html` — 3.3MB single-file app, ~206 region banners. Navigate with
  `grep -n '═══════════════════ [A-Z]'`; never read it whole.
- `gb-repo/glassbox.d.ts` — ~1,100-symbol type surface.
- `docs/PROVENANCE.md` in this repo — where each of the 19 original source apps went and
  what was deliberately omitted.

