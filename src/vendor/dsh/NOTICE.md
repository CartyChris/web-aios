# Vendored from DeepSeek Harness

Source: https://github.com/deepseek-ai/deepseek-harness
Upstream commit: `477b4f420553e8a52c2fbccc464d7561b239c443`
License: MIT (copied verbatim to `LICENSE` in this folder). Copyright (c) 2026 DeepSeek.
Vendored on 2026-09-24 for the Web-AIOS "DeepSeek Harness" app.

## What is here, and what is not

Every file under `packages/` is a verbatim copy of the upstream file at the same
relative path, with ONE kind of change: package specifiers were rewritten to
relative paths (listed below). Nothing else was edited: not code, not comments,
not formatting.

Only framework-free files were taken. Upstream's orchestration (the Cordis
plugin framework, the agent loop, the session store, subagents, goals,
Ralph) is bound to Cordis and `node:*` and is NOT vendored; Web-AIOS
re-implements it as dsh-lite in `src/lib/dsh/` (our code, not upstream's).

`_shims/` and `package.json` are Web-AIOS files, not upstream code:

- `_shims/dsh-llm.ts`, `_shims/dsh-session.ts`, `_shims/dsh-attachment.ts`: stand-ins
  for those packages' entry points (whose `index.ts` define Cordis services),
  re-exporting only the vendored framework-free files. `dsh-session.ts` and
  `dsh-attachment.ts` also declare the minimal structural `Session` and
  `AttachmentStore` interfaces the vendored files use as types.
- `_shims/ambient.d.ts`: empty ambient modules for `@deepseek-ai/cordis`,
  `@deepseek-ai/dsh-typert-protocol` and `@deepseek-ai/dsh-session-projection/types`,
  so upstream's `declare module` augmentations (kept verbatim) type-check.
- `package.json` `{ "type": "module" }`: lets Node's type stripping load these
  files in tests without a warning.

## Running

- Type-checked with the app (`tsconfig.json` has `allowImportingTsExtensions`,
  because upstream imports carry `.ts` extensions).
- `tests/dsh-vendor.test.mjs` imports json-schema, token-meter estimate,
  pruner config, time-context timestamp and known-event-types directly (Node 24
  strips types). Two files cannot run under strip-only Node because they use
  TypeScript parameter properties: `compaction-basic/src/config.ts` and
  `session/src/surface.ts` (its `SurfaceManager` class). They are covered by
  `tsc` and run in the Next bundle.
- Used at runtime by `src/lib/dsh/runtime.ts`: `validateJsonSchemaValue` /
  `assertSupportedJsonSchema` (tool argument validation), `estimateContent` /
  `ROLE_OVERHEAD` (token meter and compaction trigger), pruner `DEFAULTS` /
  `PRUNE_MARKER` (tool-result pruning budgets), compaction-basic
  `resolveConfig` (threshold ratio), `createTimestampFormatter` /
  `formatTimestamp` (time context). The remaining files are vendored so those
  compile (their import closure) and for reference; they are type-checked but
  not called.

## Files

| File | Lines |
|---|---|
| `packages/attachment/attachment/src/brand.ts` | 27 |
| `packages/attachment/attachment/src/error.ts` | 86 |
| `packages/attachment/attachment/src/request-projection.ts` | 62 |
| `packages/attachment/attachment/src/types.ts` | 163 |
| `packages/compaction/compaction-basic/src/config.ts` | 362 |
| `packages/compaction/compaction-basic/src/types.ts` | 80 |
| `packages/compaction/compaction-tool-result-pruner/src/config.ts` | 77 |
| `packages/compaction/compaction-tool-result-pruner/src/types.ts` | 41 |
| `packages/compaction/compaction/src/tool-pairing.ts` | 126 |
| `packages/context/time-context/src/request-zone.ts` | 81 |
| `packages/context/time-context/src/timestamp.ts` | 37 |
| `packages/core/session/src/fork.ts` | 30 |
| `packages/core/session/src/known-event-types.ts` | 87 |
| `packages/core/session/src/repair.ts` | 177 |
| `packages/core/session/src/request-header.ts` | 69 |
| `packages/core/session/src/seq-ranges.ts` | 73 |
| `packages/core/session/src/surface.ts` | 718 |
| `packages/core/session/src/tool-history.ts` | 75 |
| `packages/core/session/src/types.ts` | 523 |
| `packages/core/tools/src/json-schema.ts` | 656 |
| `packages/core/tools/src/presentation.ts` | 389 |
| `packages/core/tools/src/ts-types.ts` | 317 |
| `packages/core/tools/src/types.ts` | 60 |
| `packages/llm/llm/src/adapter-failure.ts` | 107 |
| `packages/llm/llm/src/api-key.ts` | 41 |
| `packages/llm/llm/src/assembler.ts` | 208 |
| `packages/llm/llm/src/assistant-stream.ts` | 534 |
| `packages/llm/llm/src/brand.ts` | 76 |
| `packages/llm/llm/src/call-config.ts` | 78 |
| `packages/llm/llm/src/content.ts` | 492 |
| `packages/llm/llm/src/error.ts` | 175 |
| `packages/llm/llm/src/message.ts` | 307 |
| `packages/llm/llm/src/types.ts` | 553 |
| `packages/llm/token-meter/src/estimate.ts` | 102 |
| `packages/llm/token-meter/src/projection.ts` | 77 |
| `packages/llm/token-meter/src/route-pricing.ts` | 76 |
| `packages/llm/token-meter/src/surface-fold.ts` | 142 |
| `packages/llm/token-meter/src/types.ts` | 54 |
| `packages/util/brand/src/index.ts` | 39 |
| `packages/util/crypto/src/index.ts` | 41 |
| `packages/util/values/src/index.ts` | 306 |
| `packages/workflow/workflow/src/types.ts` | 131 |

Total: 42 files, 7855 lines.

## Import rewrites (the only changes)

```
  packages/attachment/attachment/src/brand.ts:3  @deepseek-ai/dsh-brand -> ../../../util/brand/src/index.ts
  packages/llm/llm/src/brand.ts:13  @deepseek-ai/dsh-brand -> ../../../util/brand/src/index.ts
  packages/llm/llm/src/types.ts:7  @deepseek-ai/dsh-brand -> ../../../util/brand/src/index.ts
  packages/llm/llm/src/types.ts:8  @deepseek-ai/dsh-attachment -> ../../../../_shims/dsh-attachment.ts
  packages/llm/llm/src/message.ts:3  @deepseek-ai/dsh-util-crypto -> ../../../util/crypto/src/index.ts
  packages/llm/llm/src/message.ts:4  @deepseek-ai/dsh-brand -> ../../../util/brand/src/index.ts
  packages/llm/llm/src/message.ts:5  @deepseek-ai/dsh-util-values -> ../../../util/values/src/index.ts
  packages/llm/llm/src/content.ts:8  @deepseek-ai/dsh-attachment -> ../../../../_shims/dsh-attachment.ts
  packages/llm/llm/src/content.ts:9  @deepseek-ai/dsh-util-values -> ../../../util/values/src/index.ts
  packages/llm/llm/src/assembler.ts:9  @deepseek-ai/dsh-brand -> ../../../util/brand/src/index.ts
  packages/llm/llm/src/assembler.ts:10  @deepseek-ai/dsh-util-values -> ../../../util/values/src/index.ts
  packages/llm/llm/src/assistant-stream.ts:8  @deepseek-ai/dsh-util-values -> ../../../util/values/src/index.ts
  packages/core/session/src/types.ts:1  @deepseek-ai/dsh-brand -> ../../../util/brand/src/index.ts
  packages/core/session/src/types.ts:16  @deepseek-ai/dsh-llm -> ../../../../_shims/dsh-llm.ts
  packages/core/session/src/types.ts:17  @deepseek-ai/dsh-util-values -> ../../../util/values/src/index.ts
  packages/core/session/src/surface.ts:11  @deepseek-ai/dsh-llm -> ../../../../_shims/dsh-llm.ts
  packages/core/session/src/tool-history.ts:3  @deepseek-ai/dsh-llm -> ../../../../_shims/dsh-llm.ts
  packages/core/session/src/tool-history.ts:4  @deepseek-ai/dsh-util-values -> ../../../util/values/src/index.ts
  packages/core/session/src/repair.ts:11  @deepseek-ai/dsh-brand -> ../../../util/brand/src/index.ts
  packages/core/session/src/repair.ts:12  @deepseek-ai/dsh-llm -> ../../../../_shims/dsh-llm.ts
  packages/core/session/src/repair.ts:13  @deepseek-ai/dsh-util-values -> ../../../util/values/src/index.ts
  packages/core/session/src/request-header.ts:10  @deepseek-ai/dsh-llm -> ../../../../_shims/dsh-llm.ts
  packages/core/session/src/request-header.ts:11  @deepseek-ai/dsh-llm -> ../../../../_shims/dsh-llm.ts
  packages/core/tools/src/json-schema.ts:14  @deepseek-ai/dsh-llm -> ../../../../_shims/dsh-llm.ts
  packages/core/tools/src/json-schema.ts:15  @deepseek-ai/dsh-util-values -> ../../../util/values/src/index.ts
  packages/core/tools/src/presentation.ts:8  @deepseek-ai/dsh-llm -> ../../../../_shims/dsh-llm.ts
  packages/core/tools/src/ts-types.ts:9  @deepseek-ai/dsh-llm -> ../../../../_shims/dsh-llm.ts
  packages/core/tools/src/types.ts:7  @deepseek-ai/dsh-llm/brand -> ../../../llm/llm/src/brand.ts
  packages/core/tools/src/types.ts:8  @deepseek-ai/dsh-llm/types -> ../../../llm/llm/src/types.ts
  packages/core/tools/src/types.ts:27  @deepseek-ai/dsh-session/types -> ../../session/src/types.ts
  packages/compaction/compaction/src/tool-pairing.ts:8  @deepseek-ai/dsh-session -> ../../../../_shims/dsh-session.ts
  packages/compaction/compaction-basic/src/config.ts:7  @deepseek-ai/dsh-llm -> ../../../../_shims/dsh-llm.ts
  packages/compaction/compaction-basic/src/config.ts:8  @deepseek-ai/dsh-util-values -> ../../../util/values/src/index.ts
  packages/compaction/compaction-basic/src/types.ts:7  @deepseek-ai/dsh-llm -> ../../../../_shims/dsh-llm.ts
  packages/compaction/compaction-tool-result-pruner/src/config.ts:3  @deepseek-ai/dsh-util-values -> ../../../util/values/src/index.ts
  packages/compaction/compaction-tool-result-pruner/src/types.ts:1  @deepseek-ai/dsh-llm -> ../../../../_shims/dsh-llm.ts
  packages/compaction/compaction-tool-result-pruner/src/types.ts:2  @deepseek-ai/dsh-session/types -> ../../../core/session/src/types.ts
  packages/llm/token-meter/src/estimate.ts:9  @deepseek-ai/dsh-llm -> ../../../../_shims/dsh-llm.ts
  packages/llm/token-meter/src/estimate.ts:10  @deepseek-ai/dsh-session -> ../../../../_shims/dsh-session.ts
  packages/llm/token-meter/src/surface-fold.ts:17  @deepseek-ai/dsh-session -> ../../../../_shims/dsh-session.ts
  packages/llm/token-meter/src/surface-fold.ts:18  @deepseek-ai/dsh-session -> ../../../../_shims/dsh-session.ts
  packages/llm/token-meter/src/surface-fold.ts:19  @deepseek-ai/dsh-llm -> ../../../../_shims/dsh-llm.ts
  packages/llm/token-meter/src/route-pricing.ts:8  @deepseek-ai/dsh-llm -> ../../../../_shims/dsh-llm.ts
  packages/llm/token-meter/src/types.ts:7  @deepseek-ai/dsh-llm -> ../../../../_shims/dsh-llm.ts
  packages/llm/token-meter/src/types.ts:8  @deepseek-ai/dsh-session/types -> ../../../core/session/src/types.ts
  packages/context/time-context/src/request-zone.ts:3  @deepseek-ai/dsh-llm -> ../../../../_shims/dsh-llm.ts
  packages/context/time-context/src/request-zone.ts:4  @deepseek-ai/dsh-util-values -> ../../../util/values/src/index.ts
  packages/workflow/workflow/src/types.ts:9  @deepseek-ai/dsh-brand -> ../../../util/brand/src/index.ts
  packages/workflow/workflow/src/types.ts:10  @deepseek-ai/dsh-session/types -> ../../../core/session/src/types.ts
```
