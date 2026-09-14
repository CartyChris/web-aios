# Web-AIOS

A fully customizable AI/agent desktop operating system for the web. Nineteen single-file
harnesses and bundles, consolidated onto one kernel and deployable to Vercel as a single
Next.js app — installable as a PWA on desktop and iPhone.

```bash
npm install
npm run dev          # http://localhost:3000
npm test             # transport + SSRF guard
```

---

## What it is

A real desktop metaphor in the browser, not a dashboard that looks like one:

- **Window manager** — drag, resize from eight edges, edge-snap to halves and quadrants,
  maximize, minimize to a tray, cascade, tile, pin across workspaces, nine workspaces,
  full session restore.
- **27 apps**, every one code-split and loaded on first open.
- **17 selectable OS profiles** — Web-AIOS, WebOS All-Out, GenAI-OS, NovaOS, Aurora
  Mycelium, Mac OS Platinum, Aqua, Sequoia, Windows 95, Vista Aero, Windows 11 Fluent,
  Ubuntu Yaru, Tokyo Night, CRT Phosphor, Swiss Paper, Amiga Workbench, Night City.
- **Customization down to the token** — 16 palettes, 11 procedural wallpapers, fonts,
  radius, glass blur, UI scale, density, window opacity, dock position and contents,
  widgets, desktop pets, keybindings. Every CSS custom property is editable by hand.
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
| Transport | Hand-rolled multi-dialect streaming client | See below |

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
│   └── icons.tsx        the drawn icon set + desktop pets
├── apps/            27 modules, one file each
├── lib/             transport, providers, hooks, helpers
└── app/api/         ai/chat · ai/models · proxy
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

**Build** — Code Studio (editor, live preview, AI edits with automatic snapshots) ·
HTML Studio (prompt → self-contained app → install into the OS) · Forge 3D (scene editor,
software isometric renderer, physics preview) · Asset Library (AssetForge-compatible
schema) · Builder Labs (blueprint, test matrix, release pilot, dependency sentinel,
design system, game feel)

**Productivity & system** — Notes · Task Board · Focus · Calculator · Files · Terminal ·
Browser · Media · Media Deck · Personalize · Settings · System Monitor · Bridge

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
| `npm test` | **14/14 pass** — streaming transport (3 dialects, split frames, CRLF, usage, errors) and SSRF guard |
| `tsc --noEmit` | clean |
| `next build` (from a deleted `.next`) | clean, zero warnings |
| `eslint .` | **0 errors, 0 warnings** |
| All 27 apps mount and render | 27/27, no blank panes, no console errors |
| Calculator expression parser | 6/6 including right-associative `2^3^2 = 512` |
| SSRF guard | 10/10 attack vectors refused (incl. `169.254.169.254`, `::1`, `file://`) |
| API error paths | 400/401 with actionable messages |
| Proxy on a real public URL | 200, title and readable text extracted |
| Phone shell at 402 × 874 | renders; switches live at the 768px breakpoint; no horizontal scroll |
| OS profile switching | verified end-to-end (Windows 95 transforms the whole shell) |
| Icon coverage | 0 emoji in `src/`; every app surface renders drawn SVG glyphs |

**Not verified:** a live call to a paid provider — no API key was used, so the transport
is covered by tests against recorded frames rather than a real socket. The Bridge
companion daemon was never executed; it ships as source for you to run.
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
