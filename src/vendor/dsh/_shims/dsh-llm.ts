/**
 * Web-AIOS shim (NOT upstream code). Stands in for `@deepseek-ai/dsh-llm`'s package
 * entry, whose index.ts defines the Cordis `LlmRuntime` service. Re-exports the same
 * vocabulary the upstream index re-exports, minus attribution.ts (node:module) and
 * retry-policy.ts (schemastery), which were not vendored.
 */
export * from '../packages/llm/llm/src/brand.ts'
export * from '../packages/llm/llm/src/error.ts'
export * from '../packages/llm/llm/src/api-key.ts'
export * from '../packages/llm/llm/src/types.ts'
export * from '../packages/llm/llm/src/content.ts'
export * from '../packages/llm/llm/src/assistant-stream.ts'
export * from '../packages/llm/llm/src/message.ts'
export * from '../packages/llm/llm/src/adapter-failure.ts'
export { BlockAssembler } from '../packages/llm/llm/src/assembler.ts'
export { callConfigEquals, isAgentLoopRequest, markAgentLoopRequest } from '../packages/llm/llm/src/call-config.ts'
export type { LlmCallConfig, LlmCallConfigAdapterDefaults } from '../packages/llm/llm/src/call-config.ts'
