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

export const PROVIDERS: ProviderDef[] = [
  {
    id: "openai",
    name: "OpenAI",
    dialect: "openai",
    baseUrl: "https://api.openai.com/v1",
    envKey: "OPENAI_API_KEY",
    models: ["gpt-5.2", "gpt-5.2-mini", "gpt-5.1", "gpt-4.1", "o4-mini"],
    docs: "https://platform.openai.com/api-keys",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    dialect: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    envKey: "ANTHROPIC_API_KEY",
    models: ["claude-opus-5", "claude-sonnet-5", "claude-fable-5-1", "claude-haiku-4-5-20251001"],
    docs: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "google",
    name: "Google Gemini",
    dialect: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    envKey: "GOOGLE_API_KEY",
    models: ["gemini-3-pro", "gemini-3-flash", "gemini-2.5-pro"],
    docs: "https://aistudio.google.com/apikey",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    dialect: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
    models: ["anthropic/claude-opus-5", "openai/gpt-5.2", "google/gemini-3-pro", "meta-llama/llama-4-maverick", "deepseek/deepseek-v3.2"],
    docs: "https://openrouter.ai/keys",
  },
  {
    id: "groq",
    name: "Groq",
    dialect: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    envKey: "GROQ_API_KEY",
    models: ["llama-4-maverick-17b", "llama-3.3-70b-versatile", "qwen3-32b"],
    docs: "https://console.groq.com/keys",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    dialect: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    envKey: "DEEPSEEK_API_KEY",
    models: ["deepseek-chat", "deepseek-reasoner"],
    docs: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "mistral",
    name: "Mistral",
    dialect: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    envKey: "MISTRAL_API_KEY",
    models: ["mistral-large-latest", "mistral-small-latest", "codestral-latest"],
    docs: "https://console.mistral.ai/api-keys",
  },
  {
    id: "xai",
    name: "xAI Grok",
    dialect: "openai",
    baseUrl: "https://api.x.ai/v1",
    envKey: "XAI_API_KEY",
    models: ["grok-4", "grok-4-fast", "grok-3"],
    docs: "https://console.x.ai",
  },
  {
    id: "together",
    name: "Together",
    dialect: "openai",
    baseUrl: "https://api.together.xyz/v1",
    envKey: "TOGETHER_API_KEY",
    models: ["meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8", "Qwen/Qwen3-235B-A22B"],
    docs: "https://api.together.ai/settings/api-keys",
  },
  {
    id: "ollama",
    name: "Ollama (local)",
    dialect: "openai",
    baseUrl: "http://localhost:11434/v1",
    models: ["llama3.2", "qwen3:14b", "devstral", "gemma3:12b"],
    local: true,
    docs: "https://ollama.com",
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
 *  meter. It is an estimate and is labelled as one in the UI. */
export const PRICE_PER_MTOK: Record<string, { in: number; out: number }> = {
  "gpt-5.2": { in: 1.25, out: 10 },
  "gpt-5.2-mini": { in: 0.25, out: 2 },
  "claude-opus-5": { in: 5, out: 25 },
  "claude-sonnet-5": { in: 3, out: 15 },
  "claude-haiku-4-5-20251001": { in: 1, out: 5 },
  "gemini-3-pro": { in: 1.25, out: 10 },
  "gemini-3-flash": { in: 0.3, out: 2.5 },
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
