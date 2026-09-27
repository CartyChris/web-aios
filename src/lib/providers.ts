/** Provider catalogue shared by the server routes and the settings UI.
 *
 *  Every provider here speaks an OpenAI-compatible chat-completions dialect
 *  except Anthropic and Google, which get their own request shapes. Sticking to
 *  one wire format for the long tail is what lets a user paste in any
 *  OpenAI-compatible base URL — including a local Ollama or LM Studio — and
 *  have it work without new code. */
export interface ProviderDef {
  id: string;
  name: string;
  /** "openai" = /v1/chat/completions, "anthropic" = /v1/messages, "google" = generateContent. */
  dialect: "openai" | "anthropic" | "google";
  baseUrl: string;
  /** Env var consulted when the user has not supplied their own key. */
  envKey?: string;
  models: string[];
  /** Local providers need no key and must not be proxied through the server. */
  local?: boolean;
  docs?: string;
}

/* Model catalogue verified 2026-09-23 against each provider's own docs (URLs
 * beside each list). Order is "current first": the first id is the default a
 * provider switch picks. Older ids stay (additive only) after the current ones,
 * even where the provider has since retired them — a user may still have one
 * saved, and the live refresh flags ids a provider no longer lists.
 * The picker's refresh button replaces this list with the provider's live
 * /models listing (merged, see src/lib/model-lists.ts) whenever a key allows. */
export const PROVIDERS: ProviderDef[] = [
  {
    id: "openai",
    name: "OpenAI",
    dialect: "openai",
    baseUrl: "https://api.openai.com/v1",
    envKey: "OPENAI_API_KEY",
    // https://developers.openai.com/api/docs/models (GPT-6 Astra / Sol / Luna)
    models: ["gpt-6-sol", "gpt-6-astra", "gpt-6-luna", "gpt-5.2", "gpt-5.2-mini", "gpt-5.1", "gpt-4.1", "o4-mini"],
    docs: "https://platform.openai.com/api-keys",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    dialect: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    envKey: "ANTHROPIC_API_KEY",
    // https://platform.claude.com/docs/en/about-claude/models/overview
    models: ["claude-opus-5-5", "claude-sonnet-5", "claude-fable-5-1", "claude-haiku-4-5-20251001", "claude-opus-5"],
    docs: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "google",
    name: "Google Gemini",
    dialect: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    envKey: "GOOGLE_API_KEY",
    // https://ai.google.dev/gemini-api/docs/models ("gemini-3-pro" / "gemini-3-flash"
    // were never stable codes there; kept because users may have them saved).
    models: ["gemini-3.8-flash", "gemini-3.1-pro-preview", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3-flash-preview", "gemini-3-pro", "gemini-3-flash", "gemini-2.5-pro"],
    docs: "https://aistudio.google.com/apikey",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    dialect: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
    // https://openrouter.ai/api/v1/models (public listing, read 2026-09-23)
    models: [
      "anthropic/claude-opus-5.5", "openai/gpt-6-sol", "google/gemini-3.8-flash", "deepseek/deepseek-v4.1-flash",
      "anthropic/claude-sonnet-5", "anthropic/claude-fable-5.1", "openai/gpt-6-astra", "openai/gpt-6-luna",
      "google/gemini-3.1-pro-preview", "x-ai/grok-4.7", "deepseek/deepseek-v4-pro", "moonshotai/kimi-k3",
      "z-ai/glm-5.3", "qwen/qwen3.8-max-0902",
      "anthropic/claude-opus-5", "openai/gpt-5.2", "google/gemini-3-pro", "meta-llama/llama-4-maverick", "deepseek/deepseek-v3.2",
    ],
    docs: "https://openrouter.ai/keys",
  },
  {
    id: "groq",
    name: "Groq",
    dialect: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    envKey: "GROQ_API_KEY",
    // https://console.groq.com/docs/models (production, then preview)
    models: ["openai/gpt-oss-120b", "llama-3.3-70b-versatile", "openai/gpt-oss-20b", "llama-3.1-8b-instant", "qwen/qwen3.8-27b", "minimaxai/minimax-m2.7", "llama-4-maverick-17b", "qwen3-32b"],
    docs: "https://console.groq.com/keys",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    dialect: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    envKey: "DEEPSEEK_API_KEY",
    // https://api-docs.deepseek.com/ (deepseek-chat / deepseek-reasoner no longer
    // documented there; kept, after the current names)
    models: ["deepseek-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"],
    docs: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "mistral",
    name: "Mistral",
    dialect: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    envKey: "MISTRAL_API_KEY",
    // https://docs.mistral.ai/getting-started/models (current generation: Medium 3.5,
    // Small 4, Large 3); "-latest" alias names cross-checked at
    // https://mastra.ai/models/providers/mistral
    models: ["mistral-medium-latest", "mistral-large-latest", "mistral-small-latest", "magistral-medium-latest", "codestral-latest", "ministral-8b-latest"],
    docs: "https://console.mistral.ai/api-keys",
  },
  {
    id: "xai",
    name: "xAI Grok",
    dialect: "openai",
    baseUrl: "https://api.x.ai/v1",
    envKey: "XAI_API_KEY",
    // https://docs.x.ai/docs/models
    models: ["grok-4.7", "grok-4.6", "grok-4.3", "grok-4.20-0309-reasoning", "grok-4.20-0309-non-reasoning", "grok-build-0.1", "grok-4", "grok-4-fast", "grok-3"],
    docs: "https://console.x.ai",
  },
  {
    id: "together",
    name: "Together",
    dialect: "openai",
    baseUrl: "https://api.together.xyz/v1",
    envKey: "TOGETHER_API_KEY",
    // https://docs.together.ai/docs/serverless-models
    models: [
      "deepseek-ai/DeepSeek-V4.1-Flash", "moonshotai/Kimi-K3", "zai-org/GLM-5.3", "Qwen/Qwen3.7-Max", "Qwen/Qwen3.8-Flash",
      "deepseek-ai/DeepSeek-V4-Pro-0813", "openai/gpt-oss-120b", "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8", "Qwen/Qwen3-235B-A22B",
    ],
    docs: "https://api.together.ai/settings/api-keys",
  },
  {
    id: "ollama",
    name: "Ollama (local)",
    dialect: "openai",
    baseUrl: "http://localhost:11434/v1",
    // Pull names from https://ollama.com/library. Whatever is actually pulled
    // on this machine comes from the refresh button (GET /v1/models, browser-side).
    models: ["llama3.2", "qwen3:14b", "devstral", "gemma3:12b", "gemma4", "qwen3.5", "gpt-oss:20b", "llama3.1", "deepseek-r1"],
    local: true,
    docs: "https://ollama.com",
  },
  {
    // Chrome's built-in Prompt API (Gemini Nano): runs on this device, no key,
    // offline once downloaded. Feature-detected in lib/ondevice.ts.
    id: "browser",
    name: "On-device (Chrome built-in)",
    dialect: "openai",
    baseUrl: "",
    models: ["gemini-nano"],
    local: true,
    docs: "https://developer.chrome.com/docs/ai/prompt-api",
  },
  {
    // A local AI CLI (Claude Code or Codex) through the Bridge companion
    // daemon (lib/bridge-cli.ts). The "key" is the Bridge pairing token; the
    // "model" names the CLI, optionally with its own model: "claude:sonnet".
    id: "bridge",
    name: "Bridge (local CLI: Claude Code, Codex)",
    dialect: "openai",
    baseUrl: "http://127.0.0.1:8787",
    models: ["claude", "claude:sonnet", "claude:opus", "codex"],
    local: true,
    docs: "https://docs.claude.com/en/docs/claude-code/cli-reference",
  },
  {
    id: "lmstudio",
    name: "LM Studio (local)",
    dialect: "openai",
    baseUrl: "http://localhost:1234/v1",
    models: ["local-model"],
    local: true,
    docs: "https://lmstudio.ai",
  },
  {
    id: "custom",
    name: "Custom endpoint",
    dialect: "openai",
    baseUrl: "",
    models: [],
    docs: "",
  },
];

export const getProvider = (id: string): ProviderDef | undefined => PROVIDERS.find((p) => p.id === id);

/** Rough cost model, USD per 1M tokens, used only for the on-screen budget
 *  meter. It is an estimate and is labelled as one in the UI.
 *
 *  Prices checked 2026-09-23, standard (non-batch) tier, text, short prompts:
 *   OpenAI     https://developers.openai.com/api/docs/models
 *   Anthropic  https://platform.claude.com/docs/en/about-claude/models/overview
 *   Google     https://ai.google.dev/gemini-api/docs/pricing (3.8 Flash is a
 *              promotional price through 2026-12-31; $1.50 / $7.50 after)
 *   DeepSeek   https://api-docs.deepseek.com/quick_start/pricing (PEAK rates;
 *              off-peak is half, so the meter errs high)
 *   xAI        https://docs.x.ai/docs/models (under 200k-token prompts)
 *   OpenRouter https://openrouter.ai/api/v1/models (its own per-token pricing)
 *  The older rows (gpt-5.2, gemini-3-pro, ...) predate this check and are unchanged. */
export const PRICE_PER_MTOK: Record<string, { in: number; out: number }> = {
  "gpt-5.2": { in: 1.25, out: 10 },
  "gpt-5.2-mini": { in: 0.25, out: 2 },
  "gpt-6-astra": { in: 10, out: 50 },
  "gpt-6-sol": { in: 2, out: 10 },
  "gpt-6-luna": { in: 0.1, out: 0.5 },
  "claude-opus-5-5": { in: 4, out: 20 },
  "claude-fable-5-1": { in: 10, out: 50 },
  "claude-opus-5": { in: 5, out: 25 },
  // Was 3 / 15; the Anthropic overview lists Sonnet 5 at 2 / 10.
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-haiku-4-5-20251001": { in: 1, out: 5 },
  "gemini-3-pro": { in: 1.25, out: 10 },
  "gemini-3-flash": { in: 0.3, out: 2.5 },
  "gemini-3.8-flash": { in: 0.75, out: 3.75 },
  "gemini-3.5-flash": { in: 1.5, out: 9 },
  "gemini-3.5-flash-lite": { in: 0.3, out: 2.5 },
  "gemini-3.1-pro-preview": { in: 2, out: 12 },
  "gemini-3.1-flash-lite": { in: 0.25, out: 1.5 },
  "deepseek-flash": { in: 0.3, out: 1.2 },
  "deepseek-v4-pro": { in: 1.32, out: 3.96 },
  "grok-4.7": { in: 2, out: 6 },
  "grok-4.6": { in: 2, out: 6 },
  "grok-4.3": { in: 1.25, out: 2.5 },
  "grok-build-0.1": { in: 1, out: 2 },
  "anthropic/claude-opus-5.5": { in: 4, out: 20 },
  "anthropic/claude-sonnet-5": { in: 2, out: 10 },
  "anthropic/claude-fable-5.1": { in: 10, out: 50 },
  "openai/gpt-6-sol": { in: 2, out: 10 },
  "openai/gpt-6-astra": { in: 10, out: 50 },
  "openai/gpt-6-luna": { in: 0.1, out: 0.5 },
  "google/gemini-3.8-flash": { in: 0.75, out: 3.75 },
  "deepseek/deepseek-v4.1-flash": { in: 0.15, out: 0.6 },
  "x-ai/grok-4.7": { in: 1.6, out: 4.8 },
  "moonshotai/kimi-k3": { in: 3, out: 15 },
  "z-ai/glm-5.3": { in: 0.84, out: 2.64 },
  // Runs on this device: it costs nothing, so the budget meter must say nothing.
  "gemini-nano": { in: 0, out: 0 },
  default: { in: 1, out: 5 },
};

export function estimateCost(model: string, inTok: number, outTok: number): number {
  const p = PRICE_PER_MTOK[model] ?? PRICE_PER_MTOK.default;
  return (inTok / 1e6) * p.in + (outTok / 1e6) * p.out;
}

/** Cheap token estimate — ~4 chars/token is close enough for a budget meter and
 *  costs nothing, unlike shipping a tokenizer to the browser. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/** A model to verify with that is not the model that produced the work.
 *
 *  A verifier running the producer's own weights agrees with it far more often
 *  than an independent one does, and that agreement is indistinguishable from
 *  success. Where the provider offers an alternative, take it.
 *
 *  Returns `shared: true` when it could not find one, so a caller can say so
 *  rather than implying an independence it does not have. */
export function pickJudgeModel(providerId: string, producerModel: string): { model: string; shared: boolean } {
  const provider = getProvider(providerId);
  const alt = provider?.models.find((m) => m !== producerModel);
  return alt ? { model: alt, shared: false } : { model: producerModel, shared: true };
}
