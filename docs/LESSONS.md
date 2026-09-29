# Lessons: what to do, what not to do

One page of hard-won rules for anyone (person or agent) changing Web-AIOS. Each one cost a
session to learn. The long versions live in `docs/HANDOFF-MESSAGE.md` §2 to §5 and in
`docs/HANDOFF-2026-09-20.md` ("Traps" in each section); this page is the index.

## Phones and the installed iPhone app (measured 2026-09-28, iOS 27 simulator, iPhone Air)

- **Do** keep the opaque status bar (`apple-mobile-web-app-status-bar-style` = `default`, setting
  "Standard"). With it the page starts below the status bar and fills to the bottom edge.
- **Don't** default to `black-translucent`. On iOS 26 and later it leaves the bottom band (68px
  on an iPhone Air) outside what any page can draw, and puts the top 68px under a status bar
  that swallows taps.
- **Don't** try to stretch over that band (100lvh, `innerHeight + inset`, fixed `bottom:0`).
  Measured: nothing is drawn below the reported height, so a stretched root only hides the
  dock. Only the page's background colour shows there.
- **Don't** use `black` either: never measured, and documented as black symbols on a black bar.
- **Remember** iOS reads the status-bar style once, when the app is added to the Home Screen.
  Changing the meta later does nothing until the icon is removed and added again. An installed
  app keeps its own storage, so point people at Settings > Storage > Download full backup
  first (and Restore from backup afterwards).
- **Do** keep every control out of `env(safe-area-inset-*)`. Use the `--sa-t/r/b/l` and
  `--os-top` variables in `globals.css` for CSS, and `safeArea()` (kernel/viewport.ts) or
  `useViewport().safe*` for pixel layout (`wm.workArea`).
- **Don't** hide a feature behind `lg:` or `md:` on the assumption that phones don't need it.
  The main-model chip was `hidden lg:inline-flex`, so no phone could change the model from
  the top bar. Show a compact form instead.
- **Don't** trust Tailwind's `hidden` against a component class that sets `display`
  (`.os-chip`); the component class wins. Hide with an attribute selector
  (`[data-narrow-hide]`) or don't render.
- **Remember** the global `* { min-width: 0 }` lets flex items squash into each other. A row of
  controls needs `flex-shrink: 0` on its items (see `[data-topbar] > *`).
- **Don't** autofocus a text field in a dialog on a touch screen: the keyboard covers half the
  dialog. Gate it on `useViewport().touch`.
- **Don't** put lists over glass: a dialog with a list gets `--panel-solid`.

## How to test the iPhone app for real

- **Do** use the iPhone Air simulator (`xcrun simctl list devices`) and install from Safari:
  Share, View More, Add to Home Screen. Serve the build on the Mac's LAN address (`ipconfig
  getifaddr en0`) or `localhost`. A LAN address changes when the network does, which strands
  the installed copy on a white screen.
- **Do** measure with a probe page before believing any article: a page that reports
  `innerHeight`, `100dvh/lvh/svh`, the insets and tap positions to a local receiver, and paints
  a ruler. The 2026-09-28 probe settled in ten minutes what three write-ups disagreed on.
- **Remember** simulator screenshots lag the screen by a second or two. Wait, take two, and only
  then tap by coordinate.

## Verifying anything

- **Do** give every stage a check that can fail, and prove each new test fails against the old
  behaviour (plant the regression, watch it fail, restore it).
- **Do** run a production build (`next build` + `next start -p 3190`), restart the server by
  port (`lsof -ti tcp:3190 | xargs kill`), and check its start time. Dev mode and stale servers
  have both lied before.
- **Don't** report unverified things as done. Say what was not verified (a real device, real
  Office, real CLIs, a real model).
- **Remember** browser-pane quirks: `type` fires no keydown, `Cmd+K` is taken by the pane,
  WebGL reads back blank, and big return values flood the context (post them to a local
  receiver instead).

## Code

- **Do** keep `src/lib/**` pure (no `@/`, no DOM, no clock or randomness) and add each new
  module to `tsconfig.test.json`.
- **Do** treat everything read back from storage, files, backups or models as untrusted and
  validate it (`parse*`, persist `merge`, `readBackup`).
- **Don't** break the React Compiler rules: no refs or impure calls in render, and no
  synchronous `setState` in effects. `useSyncExternalStore` suits browser state.
- **Remember** a `*/` inside a JSDoc comment ends the comment.

## Process

- **Don't** push to `main` unless asked: it deploys production (web-aios.vercel.app). After a
  push, ask Chris to check the live site; don't poll it.
- **Never** run a local model server or download a local model, and never read or print API keys.
- **Do** rematerialize the repo from iCloud before tools run (HANDOFF-MESSAGE §1a). A "file not
  found" from `tsc` on a file that exists is usually iCloud, so run it again.
- **Do** make subagent work durable (notes files as they go), and only spawn agents when asked.
- **No** emoji anywhere. Commit messages are prose, via `git commit -F`.
