import { NextRequest } from "next/server";
import { getProvider, PROVIDERS } from "@/lib/providers";

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

  const apiKey = req.headers.get("x-api-key") || (provider.envKey ? process.env[provider.envKey] : "") || "";
  const baseUrl = req.nextUrl.searchParams.get("baseUrl") || provider.baseUrl;

  // OpenRouter's catalogue is public, so the picker works before you have a
  // key. Everything else needs one to list anything.
  const keyless = provider.id === "openrouter";
  if (provider.local || provider.dialect !== "openai" || (!apiKey && !keyless) || !baseUrl) {
    return Response.json({ models: provider.models.map(asEntry), source: "catalog" });
  }

  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return Response.json({ models: provider.models.map(asEntry), source: "catalog" });
    const data = (await res.json()) as { data?: RawModel[] };
    const models = (data.data ?? []).map(normalise).filter((m) => m.id);
    // Newest first where the provider says, then alphabetical. A picker sorted
    // purely by id buries this week's model in the middle of the list.
    models.sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || a.id.localeCompare(b.id));
    return Response.json({
      models: models.length ? models : provider.models.map(asEntry),
      source: models.length ? "live" : "catalog",
    });
  } catch {
    return Response.json({ models: provider.models.map(asEntry), source: "catalog" });
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
