/**
 * Web-AIOS shim (NOT upstream code). Stands in for `@deepseek-ai/dsh-session`'s package
 * entry, whose index.ts defines the Cordis `SessionStore` service. Re-exports the same
 * framework-free names the upstream index re-exports.
 */
export { buildForkSeed } from '../packages/core/session/src/fork.ts'
export * from '../packages/core/session/src/types.ts'
export type { AssistantMessage, DeveloperMessage, SystemMessage, ToolResultMessage, UserMessage } from './dsh-llm.ts'
export { interruptedTurnClosers, TOOL_NOT_STARTED, TOOL_OUTCOME_UNKNOWN } from '../packages/core/session/src/repair.ts'
export type { SessionSurface, SurfaceFoldReplacement, SurfaceFoldResult, SessionMessageProjection, SessionMessageProjectionContext } from '../packages/core/session/src/surface.ts'
export { deriveEventMessage, foldSurface, isAppendSurfaceEvent, isReplacementSurfaceEvent, isSurfaceEvent, isSurfaceEligibleType } from '../packages/core/session/src/surface.ts'
export { canonicalHeader, foldRequestHeader, headerEquals } from '../packages/core/session/src/request-header.ts'
export { KNOWN_SESSION_EVENT_TYPES } from '../packages/core/session/src/known-event-types.ts'
export { decodeSeqRanges, encodeSeqRanges } from '../packages/core/session/src/seq-ranges.ts'

import type { SessionEvent, SessionSeq } from '../packages/core/session/src/types.ts'
import type { SessionSurface } from '../packages/core/session/src/surface.ts'
/**
 * Upstream `Session` is a class inside the Cordis-bound SessionStore module. The
 * vendored compaction/tool-pairing.ts reads exactly `eventAt()` and `surface` from it,
 * so this is that structural contract; dsh-lite's `DshSessionView` implements it.
 */
export interface Session {
  eventAt(seq: SessionSeq): SessionEvent | undefined
  readonly surface: SessionSurface
}
