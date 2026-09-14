# Web-AIOS

A fully customizable AI/agent desktop operating system for the web. Nineteen single-file
harnesses and bundles, consolidated onto one kernel and deployable to Vercel as a single
Next.js app — installable as a PWA on desktop and iPhone.

```bash
npm install
npm run dev          # http://localhost:3000
npm test             # 77 tests: transport, vision, SSRF, deflate, zip, preview, 3D
```

Rebuilding the WebAssembly compressor is optional — `public/deflate.wasm` is
committed, so a clone needs no Rust toolchain:

```bash
rustup target add wasm32-unknown-unknown
cargo build --release --target wasm32-unknown-unknown --manifest-path wasm/deflate/Cargo.toml
cp wasm/deflate/target/wasm32-unknown-unknown/release/waios_deflate.wasm public/deflate.wasm
```

---

## What it is

A real desktop metaphor in the browser, not a dashboard that looks like one:

- **Window manager** — drag, resize from eight edges, edge-snap to halves and quadrants,
  maximize, minimize to a tray, cascade, tile, pin across workspaces, nine workspaces,
  full session restore.
- **A real desktop** — drag a rubber band to select icons, move one or a whole selection
  anywhere, rename, nudge with arrow keys, tidy to a grid. Pin any app, any app *you*
  built in Studio, or any file, dropped exactly where you right-clicked.
- **Widgets you describe in a sentence** — the model writes one, it runs sandboxed on
  your desktop, and it exports as a standalone HTML file you can open or embed anywhere.
- **AI Studio** — build *anything* with a model, across **15 targets**: a page, a React
  app, a full-stack product, an installable PWA, a canvas game, a three.js scene, React
  Three Fiber, an Express or FastAPI service, a Node CLI, or a Godot / Unity / Unreal
  project. Plus image and video generation.
- **Live preview for everything with a browser runtime** — React, TypeScript, JSX and
  three.js are transpiled and linked *in your browser*, so a generated project runs
  before you have installed anything. Install it and it becomes a real app with a
  desktop icon, still exportable as source.
- **Forge 3D** — describe assets, NPCs, player models, whole maps, particle effects or
  a lighting setup, and a model builds them. Then **let it look**: the viewport renders
  to a PNG and goes back to a vision model, which can see that the roof floats and fix it.
- **Asset Studio** — describe a prop and a model composes it out of primitives, with a
  real lit thumbnail rendered from its own geometry.
- **28 apps**, every one code-split and loaded on first open.
- **An arcade** — Snake, Breakout, 2048 and Minesweeper, keyboard and touch, plus eight
  secrets hidden around the OS.
- **17 selectable OS profiles** — Web-AIOS, WebOS All-Out, GenAI-OS, NovaOS, Aurora
  Mycelium, Mac OS Platinum, Aqua, Sequoia, Windows 95, Vista Aero, Windows 11 Fluent,
  Ubuntu Yaru, Tokyo Night, CRT Phosphor, Swiss Paper, Amiga Workbench, Night City.
- **Customization down to the token** — 16 palettes, 11 procedural wallpapers, fonts,
  radius, glass blur, UI scale, density, window opacity, dock position and contents,
  widgets, keybindings. Every CSS custom property is editable by hand.
- **37 desktop pets** that talk back — three fidelities from flat outline to blinking,
  breathing and tail-swaying, eight personalities, and a one-sentence reply from
  whichever model you have loaded when you click one (capped at 60 tokens, with written
  fallbacks so it still has something to say offline).
- **A voice for the assistant** — eight tone presets and an "about you" note, layered
  over the task prompt in every app that talks to a model.
- **A bespoke icon set** — 100+ glyphs drawn for this OS on a 24×24 grid, stroked at
  1.6 in `currentColor`. No emoji anywhere: emoji are a different picture on every
  platform, carry their own colour that fights the active theme, and sit on a baseline
  instead of a grid. Every icon inherits its app's accent and re-colours with the theme.
- **Provider-agnostic AI** — 12 providers including local Ollama and LM Studio, with BYO
  keys that never leave your browser.
- **Phone shell** — below 768px the OS becomes a phone OS: home screen, pages, app
  switcher, safe-area insets. Same kernel, same apps.

---

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Framework | Next.js 16.3 (App Router, Turbopack) | Vercel-native; route handlers give the AI relay and fetch proxy a home |
| UI | React 19.3 | `useSyncExternalStore` for viewport/hydration; the new hooks lint caught real bugs |
| Styling | Tailwind v4 over CSS custom properties | Theming is token substitution, so a theme change is instant and total |
| State | zustand 5 + `persist` | Small, no provider tree, and survives reload |
| Types | TypeScript 5.9 strict | — |
| Transport | Hand-rolled multi-dialect streaming client | See below — text *and* vision |
| Compression | Rust → WebAssembly (`wasm/deflate`) | ~12 KB of wasm instead of 40-90 KB of JS, fetched only on export |
| 3D | Software painter on a 2D canvas | Zero dependency, identical on a phone, real per-face lighting |

**Why not the Vercel AI SDK.** Ollama and LM Studio run on the user's own localhost,
which a serverless function physically cannot reach — those calls have to leave from the
browser. Since a second, client-side code path was unavoidable, one transport that both
the route handler and the browser import (`src/lib/ai-transport.ts`) is simpler and more
portable than two. It speaks three wire dialects (OpenAI, Anthropic, Google) and
therefore accepts any OpenAI-compatible base URL you paste in.

---

## Architecture

```
src/
├── kernel/          the OS itself — no rendering
│   ├── wm.ts            window manager: geometry, z-order, workspaces, snapping
│   ├── settings.ts      every customization field + token resolution
│   ├── profiles.ts      the 17 OS personalities
│   ├── themes.ts        palettes, wallpapers, pets, font stacks
│   ├── registry.tsx     app manifests; each entry is a lazy import
│   ├── vfs.ts           one filesystem every app shares
│   ├── bus.ts           typed pub/sub so apps talk without importing each other
│   └── types.ts
├── shell/           the desktop
│   ├── Desktop.tsx      root, token application, keybindings, cross-app messaging
│   ├── MobileShell.tsx  the phone paradigm
│   ├── Window.tsx       chrome, drag, 8-way resize, snap zones
│   ├── Dock.tsx  TopBar.tsx  Launcher.tsx  CommandPalette.tsx
│   ├── Widgets.tsx      7 draggable desktop widgets
│   ├── Wallpaper.tsx    11 procedural wallpapers on one canvas
│   ├── DesktopIcons.tsx marquee selection, multi-drag, free placement
│   ├── PinPicker.tsx    pin any app, built app or file to the desktop
│   └── icons.tsx        the drawn icon set + desktop pets
│   ├── pets.ts          37 species as descriptions, not drawings
│   └── userapps.ts      apps you built — html documents and real projects
├── apps/            28 modules, one file each
├── lib/             transport, providers, hooks, zip + deflate, project targets,
│                    the browser bundler, the MCP client, the 3D renderer
├── wasm/deflate/    a DEFLATE encoder in Rust, compiled to WebAssembly
└── app/api/         ai/chat · ai/models · ai/media · mcp · proxy
```

Three ideas carry the whole thing:

1. **Everything visual is a CSS custom property.** No component knows a theme exists;
   they read tokens. That is what makes "fully customizable" tractable instead of a maze
   of conditionals — and why the Tokens tab can expose raw values safely.
2. **A profile is a bundle of those tokens plus layout.** Picking "Windows 95" changes
   palette, corner radius, titlebar style, dock position and glass in one move, because
   a theme that only changes colour leaves you with macOS traffic lights in teal.
3. **The kernel never renders and the shell never computes.** Which is why the same app
   file works unchanged in a floating window and full-screen on a phone.

An app also never learns its own size. The window body is a CSS container, so a two-pane
app stacks when its *surface* is narrow — in a 380px window on a desktop just as much as
full-screen on a phone — without a single viewport media query in any app file.

---

## The apps

**AI & agents** — Chat (threads, personas, 12 providers) · Agent Swarm (five formations,
bounded concurrency, budget stop, reconciliation pass) · Deep Work (staged plans with
gates that can fail) · Agent Loop (plan → act → verify → learn, with an independent
verifier) · Memory Vault (capture, reflect, recall) · Observatory (span trees, local
heuristics, cost)

**Research** — Atlas (crawl, extract claims, derive confidence from corroboration, cite
everything) · Profiler (staged analysis that labels every line observed or inferred) ·
Signals (feeds, severity, 7-day histogram, brief)

**Build** — **AI Studio** (15 targets, live preview, image and video, MCP) · Code Studio
(editor, live preview, AI edits with automatic snapshots) · **Forge 3D** (AI world
building, real lighting, particles, vision review) · **Asset Studio** (describe a prop,
AssetForge-compatible schema) · Builder Labs (blueprint, test matrix, release pilot,
dependency sentinel, design system, game feel)

**Games** — Arcade (Snake, Breakout, 2048, Minesweeper, and the secrets)

**Productivity & system** — Notes · Task Board · Focus · Calculator · Files · Terminal ·
Browser · Media · Media Deck · Personalize · Settings · System Monitor · Bridge

---

## How AI Studio actually previews a project

A single HTML file previews itself. Everything else would normally need
`npm install && npm run dev` before you could see one pixel, which makes "generate a
project" feel like filing paperwork. So `src/lib/preview.ts` bundles in the browser:
inside a sandboxed iframe it transpiles each file with Babel, walks the import graph
depth-first, turns each module into a blob URL with its specifiers rewritten to point at
its dependencies' blob URLs, and maps bare imports through an import map to a CDN.

Depth-first is not a style choice — a blob URL's contents are fixed when it is created,
so a module can only be built once every module it imports already has a URL.

Two details that are load-bearing: `react-dom` is pinned with `?external=react`, because
otherwise the CDN serves it a second copy of React and every hook throws "invalid hook
call" in a project that is perfectly correct; and `node:` specifiers are never mapped,
because a 404 in an import map takes the whole page down silently.

The exported project has none of this. It is ordinary source with a real `package.json`.

## Driving a real engine

Godot, Unity and Unreal are programs, not APIs. AI Studio's **Engines & MCP** tab speaks
the Model Context Protocol over Streamable HTTP: initialize, `tools/list`, `tools/call`.
Point it at a running editor's MCP server and a prompt can open a scene, add a node or
build the project.

Tool calls are requested from the model as a JSON block rather than through each vendor's
own function-calling schema. That is deliberate: it works identically on all twelve
providers including a local Ollama, and a desktop OS whose headline feature only works on
two vendors is not much of an OS.

A localhost MCP server is called straight from the browser — a serverless function has no
route to your machine — so it must send CORS headers for this origin. Public servers can
go through `/api/mcp`, which applies the same resolved-IP SSRF check as the fetch proxy
and therefore refuses private addresses by design.

---

## Deploying to Vercel

```bash
npx vercel          # preview
npx vercel --prod   # production
```

Or push to GitHub and import the repo — Vercel detects Next.js and needs no
configuration. `vercel.json` only adds security headers and service-worker caching rules.

**Environment variables are entirely optional.** Set any of these to give visitors a
working desktop without their own key:

```
OPENAI_API_KEY   ANTHROPIC_API_KEY   GOOGLE_API_KEY   OPENROUTER_API_KEY
GROQ_API_KEY     DEEPSEEK_API_KEY    MISTRAL_API_KEY  XAI_API_KEY
TOGETHER_API_KEY
```

A key the user enters in Settings always takes precedence over the deployment's.

> **If you deploy publicly, set at most one key you are willing to have used by
> anyone who finds the URL** — `/api/ai/chat` has no authentication, by design, because
> the app is built to be used with your own key. Add Vercel's Deployment Protection, or
> leave the env vars unset and let each visitor bring their own.

---

## Installing as a PWA

**iPhone** — open in Safari → Share → *Add to Home Screen*. It launches full-screen with
`viewport-fit=cover`, a translucent status bar, and `env(safe-area-inset-*)` respected on
every fixed edge, so the Dynamic Island and home indicator never cover content. Verified
at 402 × 874 (iPhone Air).

**Desktop Chrome/Edge** — the install icon in the address bar.

The service worker is network-first for navigations (a deploy is picked up immediately)
and stale-while-revalidate for assets. `/api/*` is never cached: a cached model response
or a cached proxied page would be actively wrong.

---

## Privacy

- API keys live in this browser's `localStorage` and nowhere else. They go only to the
  provider you pick, on a request you make, and are **stripped from every profile
  export** so a shared profile cannot leak credentials.
- `/api/proxy` resolves each hostname and refuses private, loopback, link-local,
  carrier-grade-NAT and cloud-metadata addresses — checking the resolved IP, not just the
  name, because DNS can lie. Redirects are followed manually so every hop is re-checked.
  It sends none of your cookies.
- No analytics, no telemetry, no accounts. Files, chats and settings are local.

---

## Verification

Everything below was run against this code, not assumed.

| Check | Result |
| --- | --- |
| `npm test` | **77/77 pass** — transport, vision translation, SSRF guard, DEFLATE, ZIP, the browser bundler, 3D lighting and particles, project scaffolds |
| `tsc --noEmit` | clean |
| `next build` (from a deleted `.next`) | clean, zero warnings |
| `eslint .` | **0 errors, 0 warnings** |
| WASM DEFLATE round-trip | every case re-inflates byte-identically through Node's `zlib.inflateRawSync` — the same libz every `unzip` links against |
| Compression ratio | 389 KB of this project's own source → 117 KB (30%); a 5 KB JS file → 1.7% |
| WASM in a real browser | fetched as `application/wasm`, instantiated, compressed — 20 KB module |
| **Live preview: React + TypeScript** | a typed multi-file project renders, `useState` increments 0 → 3, a relative import of a second module resolves, imported CSS applies |
| **Live preview: three.js** | a lit torus knot renders in WebGL with `OrbitControls` resolved from the addons path to the same pinned version |
| **Forge 3D lighting** | with the key light at 0 / 1.05 / 2.8 the crate's top face reads 66 / 206 / 255, and the face pointing away from it stays at 72 throughout — the N·L term is real, not a gradient |
| **Forge 3D ambient** | at ambient 0 the unlit face is 19; at 0.9 it is 167 |
| Forge 3D particles | emitters spawn, age, fall under gravity, blend additively, and honour a pool budget |
| Asset thumbnails | six seed assets render as lit geometry, framed by their projected bounding box |
| Arcade | Snake 0 → 10 with death detection · 2048 0 → 304 across 24 moves · Minesweeper 144 cells, flood-fill reveal · Breakout 3 lives |
| Easter eggs | Konami summons a dragon · "matrix" swaps the theme and reverts · "drop" drops every icon to the floor · "party" toggles cleanly on and off |
| Desktop pet | click produces a speech bubble; with no key it falls back to a written line instead of an error |
| All 28 apps mount and render | opened every one from the OS terminal: 29 surfaces (Terminal twice), **0 blank panes**, 0 stuck loaders |
| Console on boot and through a full session | **0 errors** |
| Calculator expression parser | 6/6 including right-associative `2^3^2 = 512` |
| SSRF guard | 10/10 attack vectors refused (incl. `169.254.169.254`, `::1`, `file://`) |
| Phone shell at 402 × 874 | renders; AI Studio's 15 targets stack with no horizontal overflow (`scrollWidth === innerWidth`) |
| Icon coverage | 0 emoji in `src/`; five places that printed an icon *name* as text now render the glyph |
| Marquee + multi-drag | 5/5 selected by rubber band; group moves with identical deltas |
| Widget sandbox | frame is `allow-scripts` only; reaching the parent throws `SecurityError` |
| ZIP output | `unzip -t` verifies CRCs; method 8 and method 0 entries both parse |

### Three bugs this pass found by measuring rather than guessing

1. **Desktop icons did nothing when clicked.** `setPointerCapture` on the surface — which
   the drag needs — makes the browser retarget the compatibility mouse events to the
   capture element, so an icon's own `onClick` and `onDoubleClick` could never fire. A
   real double-click logged `click@SURFACE, click@SURFACE, dblclick@SURFACE` and opened
   nothing. Activation is now decided in `pointerup`, which also gets touch right.
2. **Two arcade games updated state from inside a state updater.** `setScore` within
   `setGrid`'s updater updates one component while another renders; React logged it, and
   it would double-count in StrictMode. Both now compute the whole move first and commit
   after.
3. **Every easter egg but one was unreachable.** The key-sequence listener depended on the
   whole settings object, so any settings write re-subscribed it and wiped the partial
   sequence — and party mode writes an accent every 120ms. It now reads settings through
   `getState()` and depends only on `funMode`.

**Not verified: anything that needs a provider key.** No API key was used, so every model
call in this OS is covered by tests against the request bodies and recorded frames rather
than a real socket. Concretely, these are built to each provider's documented shape and
have **never been run against the live service**: image generation, video generation and
its polling loop, AI project and widget generation, Forge 3D's build and vision-review
passes, Asset Studio's composer, and the pet's one-sentence reply. What *is* proven is
everything downstream of the model: the exact JSON that goes on the wire in all three
dialects including images, that a project parses and links and runs, that a scene applies
and renders, and that each of them degrades to something sensible when the call fails.

**Also not verified:** a live MCP handshake against a real Godot, Unity or Unreal server
— the client is written to the 2025-06-18 spec and handles both the JSON and SSE response
forms, but no editor was running to answer it. The Bridge companion daemon was never
executed; it ships as source for you to run.

One thing the test harness could not reach: **clicking inside a widget's iframe.** Its
synthetic clicks do not cross an iframe boundary at all — a same-origin control frame
ignored them too — so this is a limitation of the automation, not of the sandbox. What
*is* proven is that scripts run inside the frame, that DOM APIs work there, and that the
frame cannot reach the host page. Ordinary mouse input into an iframe is standard browser
behaviour that does not depend on this code.
Service-worker registration was blocked by the preview browser's sandbox; the worker and
manifest are served correctly with the right MIME types, so install it in a real browser
to confirm.

---

## A note on where this lives

Keep this project **outside iCloud Drive**. The Desktop and Documents folders are synced
by default, and macOS will make `node_modules` files "dataless" — builds then fail with
`ETIMEDOUT` or `Need authenticator (os error 81)` on random files. Move it to
`~/Developer/` or exclude the folder from sync if builds start failing for no reason.

---

## Provenance

Every source app and where it went: [`docs/PROVENANCE.md`](docs/PROVENANCE.md).
