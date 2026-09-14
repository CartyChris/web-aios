import { NextRequest } from "next/server";
import { getProvider, PROVIDERS } from "@/lib/providers";

export const runtime = "nodejs";

/** Live model list for a provider, so a picker never goes stale against a
 *  hard-coded array. Falls back to the catalogue when the provider has no
 *  listing endpoint or the key is missing. */
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("provider") ?? "openai";
  const provider = getProvider(id);
  if (!provider) return Response.json({ error: "Unknown provider" }, { status: 400 });

  const apiKey = req.headers.get("x-api-key") || (provider.envKey ? process.env[provider.envKey] : "") || "";
  const baseUrl = req.nextUrl.searchParams.get("baseUrl") || provider.baseUrl;

  if (provider.local || provider.dialect !== "openai" || !apiKey || !baseUrl) {
    return Response.json({ models: provider.models, source: "catalog" });
  }

  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return Response.json({ models: provider.models, source: "catalog" });
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    const models = (data.data ?? []).map((m) => m.id).filter(Boolean).sort();
    return Response.json({ models: models.length ? models : provider.models, source: models.length ? "live" : "catalog" });
  } catch {
    return Response.json({ models: provider.models, source: "catalog" });
  }
}

export async function POST() {
  return Response.json({ providers: PROVIDERS.map(({ id, name, models, local, docs }) => ({ id, name, models, local, docs })) });
}
