import { NextRequest } from "next/server";
import { checkBaseUrl, deploymentKeyAllowed } from "@/lib/server-guard";
import { getProvider, PROVIDERS } from "@/lib/providers";
import { parseAnthropicModels, parseGoogleModels } from "@/lib/model-lists";

export const runtime = "nodejs";

/** Live model list for a provider, so a picker never goes stale against a
 *  hard-coded array. Falls back to the catalogue when the provider has no
 *  listing endpoint or the key is missing.
 *
 *  Each entry carries what a picker needs to be useful on a list of five
 *  hundred: a label, the context window, whether it can see, and the price.
 *  OpenRouter publishes all of that and needs no key to ask, which is why the
 *  picker can show its whole catalogue before you have signed up for anything. */
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("provider") ?? "openai";
  const provider = getProvider(id);
  if (!provider) return Response.json({ error: "Unknown provider" }, { status: 400 });

  const envKey = provider.envKey && deploymentKeyAllowed(req.nextUrl.searchParams.get("baseUrl"), provider.baseUrl) ? process.env[provider.envKey] : "";
  const apiKey = req.headers.get("x-api-key") || envKey || "";
  const baseUrl = req.nextUrl.searchParams.get("baseUrl") || provider.baseUrl;

  // Every fallback says why, so the UI can tell the user plainly instead of
  // silently showing the built-in list as if it were live.
  const catalog = (reason: string) => Response.json({ models: provider.models.map(asEntry), source: "catalog", reason });

  // Local providers are listed from the browser: this server (possibly on
  // Vercel) has no route to the user's localhost, and must not try.
  if (provider.local) return catalog(`${provider.name} is listed from this browser, not the server`);
  if (!baseUrl) return catalog("no base URL set");
  const blocked = await checkBaseUrl(req.nextUrl.searchParams.get("baseUrl"), provider.baseUrl);
  if (blocked) return catalog(blocked);

  // OpenRouter's catalogue is public, so the picker works before you have a
  // key. Everything else needs one to list anything.
  const keyless = provider.id === "openrouter";
  if (!apiKey && !keyless) return catalog(`no API key for ${provider.name}`);

  const root = baseUrl.replace(/\/+$/, "");

  // Anthropic: GET /v1/models with its own auth headers. Pages of up to 1000,
  // which is every Claude model there is.
  if (provider.dialect === "anthropic") {
    try {
      const res = await fetch(`${root}/models?limit=1000`, {
        redirect: "manual",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) return catalog(`${provider.name} answered ${res.status}`);
      const models = parseAnthropicModels(await res.json());
      return models.length ? Response.json({ models, source: "live" }) : catalog(`${provider.name} listed no models`);
    } catch {
      return catalog(`could not reach ${provider.name}`);
    }
  }

  // Google: GET /v1beta/models?key=…, "models/" prefixed names, and only the
  // ones that can generateContent are chat models.
  if (provider.dialect === "google") {
    try {
      const res = await fetch(`${root}/models?pageSize=1000&key=${encodeURIComponent(apiKey)}`, {
        redirect: "manual",
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) return catalog(`${provider.name} answered ${res.status}`);
      const models = parseGoogleModels(await res.json());
      return models.length ? Response.json({ models, source: "live" }) : catalog(`${provider.name} listed no chat models`);
    } catch {
      return catalog(`could not reach ${provider.name}`);
    }
  }

  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
        redirect: "manual",
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return catalog(`${provider.name} answered ${res.status}`);
    const data = (await res.json()) as { data?: RawModel[] };
    const models = (data.data ?? []).map(normalise).filter((m) => m.id);
    // Newest first where the provider says, then alphabetical. A picker sorted
    // purely by id buries this week's model in the middle of the list.
    models.sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || a.id.localeCompare(b.id));
    if (!models.length) return catalog(`${provider.name} listed no models`);
    return Response.json({ models, source: "live" });
  } catch {
    return catalog(`could not reach ${provider.name}`);
  }
}

interface RawModel {
  id?: string;
  name?: string;
  created?: number;
  description?: string;
  context_length?: number;
  architecture?: { input_modalities?: string[]; output_modalities?: string[]; modality?: string };
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
}

export interface ModelEntry {
  id: string;
  name: string;
  created?: number;
  context?: number;
  /** Can take an image as input. */
  vision?: boolean;
  /** Can return an image. */
  image?: boolean;
  /** Supports tool calling. */
  tools?: boolean;
  /** USD per million input / output tokens. */
  inUsd?: number;
  outUsd?: number;
  free?: boolean;
}

const asEntry = (id: string): ModelEntry => ({ id, name: id });

function normalise(m: RawModel): ModelEntry {
  const id = m.id ?? "";
  const inputs = m.architecture?.input_modalities ?? [];
  const outputs = m.architecture?.output_modalities ?? [];
  const modality = m.architecture?.modality ?? "";
  // Per-token strings from OpenRouter; ×1e6 is the number people think in.
  const price = (v?: string) => {
    const n = Number(v);
    return Number.isFinite(n) ? n * 1_000_000 : undefined;
  };
  const inUsd = price(m.pricing?.prompt);
  const outUsd = price(m.pricing?.completion);
  return {
    id,
    name: m.name ?? id,
    created: m.created,
    context: m.context_length,
    // Declared modalities, not a guess from the name: "gpt-5-image" generates
    // images and "image-to-text-ocr" does not, and only the metadata knows.
    vision: inputs.includes("image") || modality.includes("image") && modality.includes("->text"),
    image: outputs.includes("image") || modality.endsWith("->image"),
    tools: (m.supported_parameters ?? []).includes("tools"),
    inUsd,
    outUsd,
    free: id.endsWith(":free") || (inUsd === 0 && outUsd === 0),
  };
}

export async function POST() {
  return Response.json({ providers: PROVIDERS.map(({ id, name, models, local, docs }) => ({ id, name, models, local, docs })) });
}
