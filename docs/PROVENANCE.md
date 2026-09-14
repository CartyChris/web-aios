# Provenance

Where each source app went. Nineteen inputs, one OS.

| Source | Became | What was kept |
| --- | --- | --- |
| `WebOS_All_Out_Edition.html` | **the shell itself** + WebOS All-Out profile | The whole desktop metaphor: 21-app model, dock, start menu, workspaces, widget layer, glass/radius/scale sliders, desktop pets, 10 themes |
| `aurora-os.html` | **17 OS profiles**, Memory Vault, Observatory, Bridge | The insight that an OS skin is a bundle, not a palette. Its 14 skins are the backbone of `kernel/profiles.ts` |
| `GenAI-OS-V2.html` | GenAI-OS profile, app-registry shape | Gradient-tile app registry, left-rail layout |
| `NovaOS/index.html` | HTML Studio, NovaOS profile | The four refinement passes (graphics / features / bugfix / custom) and the generator system prompt |
| `illumine-agent-swarm.html` | **Agent Swarm** | Named agent roles, formations, budget caps, activity log. Added: bounded concurrency and a hard budget stop |
| `Astro-Atlas-Research-Harness.html` | **Atlas**, parts of Chat | Source-tagged claims, corroboration-derived confidence, lead export — the refusal to let prose float free of sources |
| `DeepseekHarnessMobile.html` | **Deep Work** | Staged execution with per-stage verification status and downstream invalidation |
| `MyTermz.html` | **Code Studio** | Tabs over a shared filesystem, live preview, AI edits, snapshots before every edit |
| `universal_3d_game_editor_harness_v7.html` | **Forge 3D** | Entity/transform/physics scene model and export format. Renderer rewritten as a software isometric canvas so it costs zero dependencies and works on a phone |
| `asset_forge_library.zip` | **Asset Library** | The `.asset.json` schema verbatim, so exports round-trip |
| `ai-social-media-profiler.zip` | **Profiler** | Three-stage analysis. Tightened: every line is labelled observed or inferred, and it never searches for a person |
| `forge-harness-0.1.0.zip` | **Agent Loop** | plan → act → verify → learn with a session ledger, and an *independent* verifier that sees only the objective and the result |
| `Arcwright-Beta-0.4-Deep-Work-Kit.zip` | **Builder Labs** | Six labs. The value was the prompt shape — each asks for an auditable artifact, not an essay |
| `add-fifteen-new-features.zip-A.zip` | **Signals** | Signal feed, severity, country/trend views. Seeded demo data dropped: a chart of invented numbers is worse than an empty one |
| `media-deck.html` | **Media Deck** | Decks, shuffle/repeat, visualizer |
| `MyTermzCodex` / terminal halves | **Terminal** | A shell that reaches the real stores — `open`, `theme`, `profile`, `ask` genuinely change the running system |
| `aurora-bridge.js` + `Start-Aurora-OS.command` | **Bridge** | Loopback-only daemon, token that dies with the process, command allowlist, workspace-confined file access. Shipped as copyable source |
| `Chat-AI-UI.html`, `nexus-ai-pro.html` | **Chat** | Threaded multi-provider chat |
| `BUILD_REPORT.md`, `GATES.md` | Deep Work's gate model | "A stage cannot be marked verified by assertion" |

## Deliberate omissions

- **Seeded demo data** (Signals) — removed. Fake data that looks real is a liability.
- **The 3D editor's WebGL pipeline** — replaced with a software renderer. The scene graph,
  entity model and export format are faithful; the shader pipeline is not. A full WebGL
  editor belongs in its own app, not inside an OS that must stay fast to boot.
- **Bundled game demos** (Neon Crime City, Vector FPS) — not ported. They are complete
  games, not OS features, and HTML Studio can install them as user apps.
- **Per-app bespoke theming** — every app now reads OS tokens instead. That is what makes
  twenty-seven ports look like one product.
- **Emoji icons** — every source used them; none survive. They render differently on each
  platform, bring their own palette, and cannot take an accent colour. Replaced with a
  drawn set in `src/shell/icons.tsx`, including the desktop pets.
