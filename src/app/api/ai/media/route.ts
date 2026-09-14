import { NextRequest } from "next/server";
import { getProvider } from "@/lib/providers";
import { getMediaModel, type MediaJob, type MediaModel } from "@/lib/media";

export const runtime = "nodejs";
export const maxDuration = 300;

/* ────────────────────────────────────────────────────────────────────────────
   Image and video generation relay.

   Unlike chat there is no local provider to consider, so everything goes
   through here. Two things make that the right call rather than a convenience:
   a deployment key can serve a visitor who has none, and a generated image
   arrives as multiple megabytes of base64 that has no business being
   assembled in the same place the key is held.

   Video is a job, not a request. Submit returns a handle; the client polls.
   ──────────────────────────────────────────────────────────────────────────── */

interface Body {
  op?: "generate" | "poll";
  modelId?: string;
  prompt?: string;
  size?: string;
  handle?: string;
  apiKey?: string;
}

export async function POST(req: NextRequest) {
  let body: Body;
  try { body = await req.json(); } catch { return json({ error: "Malformed JSON body." }, 400); }

  const model = getMediaModel(body.modelId ?? "");
  if (!model) return json({ error: `Unknown media model "${body.modelId}".` }, 400);

  const provider = getProvider(model.provider);
  const apiKey = body.apiKey?.trim() || (provider?.envKey ? process.env[provider.envKey] : "") || "";
  if (!apiKey) {
    return json(
      { error: `No API key for ${provider?.name ?? model.provider}. Add one in Settings → Providers, or set ${provider?.envKey} on the deployment.` },
      401,
    );
  }
  const baseUrl = provider?.baseUrl ?? "";

  try {
    if (body.op === "poll") {
      if (!body.handle) return json({ error: "handle is required to poll." }, 400);
      return json(await poll(model, baseUrl, apiKey, body.handle));
    }
    const prompt = body.prompt?.trim();
    if (!prompt) return json({ error: "A prompt is required." }, 400);
    return json(await generate(model, baseUrl, apiKey, prompt, body.size));
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Generation failed." }, 502);
  }
}

/* ── Generation ───────────────────────────────────────────────────────────── */

async function generate(m: MediaModel, baseUrl: string, key: string, prompt: string, size?: string): Promise<MediaJob> {
  switch (m.dialect) {
    /* OpenAI-compatible: one POST, base64 back. xAI speaks this too. */
    case "openai-image": {
      const res = await fetch(`${baseUrl}/images/generations`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: m.model, prompt, n: 1,
          ...(size && m.sizes ? { size } : {}),
          // dall-e-3 needs to be asked for base64; gpt-image-1 always returns it
          // and rejects the parameter outright.
          ...(m.model === "dall-e-3" ? { response_format: "b64_json" } : {}),
        }),
      });
      const data = await readJson(res);
      const first = (data as { data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }> })?.data?.[0];
      if (first?.b64_json) return { status: "done", mime: "image/png", dataUrl: `data:image/png;base64,${first.b64_json}`, revisedPrompt: first.revised_prompt };
      if (first?.url) return { status: "done", mime: "image/png", dataUrl: first.url, revisedPrompt: first.revised_prompt };
      throw new Error("The provider returned no image.");
    }

    /* Google splits these: Imagen has :predict, Gemini image has
       :generateContent. Same key, same host, different shape. */
    case "google-image": {
      const imagen = m.model.startsWith("imagen");
      const url = imagen
        ? `${baseUrl}/models/${m.model}:predict?key=${encodeURIComponent(key)}`
        : `${baseUrl}/models/${m.model}:generateContent?key=${encodeURIComponent(key)}`;
      const payload = imagen
        ? { instances: [{ prompt }], parameters: { sampleCount: 1 } }
        : { contents: [{ role: "user", parts: [{ text: prompt }] }] };
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const data = await readJson(res);

      if (imagen) {
        const pred = (data as { predictions?: Array<{ bytesBase64Encoded?: string; mimeType?: string }> })?.predictions?.[0];
        if (pred?.bytesBase64Encoded) {
          const mime = pred.mimeType ?? "image/png";
          return { status: "done", mime, dataUrl: `data:${mime};base64,${pred.bytesBase64Encoded}` };
        }
      } else {
        const parts = (data as { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> } }> })
          ?.candidates?.[0]?.content?.parts ?? [];
        const inline = parts.find((p) => p.inlineData?.data)?.inlineData;
        if (inline?.data) {
          const mime = inline.mimeType ?? "image/png";
          return { status: "done", mime, dataUrl: `data:${mime};base64,${inline.data}` };
        }
      }
      throw new Error("The provider returned no image.");
    }

    /* Long-running: submit now, poll later. */
    case "google-veo": {
      const res = await fetch(`${baseUrl}/models/${m.model}:predictLongRunning?key=${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instances: [{ prompt }], parameters: { sampleCount: 1 } }),
      });
      const data = await readJson(res);
      const name = (data as { name?: string })?.name;
      if (!name) throw new Error("The provider did not return an operation to poll.");
      return { status: "pending", handle: name };
    }

    case "openai-video": {
      const res = await fetch(`${baseUrl}/videos`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: m.model, prompt, ...(size ? { size } : {}) }),
      });
      const data = await readJson(res);
      const id = (data as { id?: string })?.id;
      if (!id) throw new Error("The provider did not return a job id.");
      return { status: "pending", handle: id };
    }
  }
}

/* ── Polling ──────────────────────────────────────────────────────────────── */

async function poll(m: MediaModel, baseUrl: string, key: string, handle: string): Promise<MediaJob> {
  if (m.dialect === "google-veo") {
    const res = await fetch(`${baseUrl}/${handle}?key=${encodeURIComponent(key)}`);
    const data = await readJson(res) as {
      done?: boolean;
      error?: { message?: string };
      response?: { generateVideoResponse?: { generatedSamples?: Array<{ video?: { uri?: string } }> } };
    };
    if (data.error?.message) return { status: "error", error: data.error.message };
    if (!data.done) return { status: "pending", handle };
    const uri = data.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
    if (!uri) return { status: "error", error: "The job finished but returned no video." };
    // The file endpoint needs the key, and the browser must not hold it — so
    // the bytes come back through here as a data URL.
    const file = await fetch(`${uri}${uri.includes("?") ? "&" : "?"}key=${encodeURIComponent(key)}`);
    if (!file.ok) return { status: "error", error: `Could not download the video (${file.status}).` };
    const buf = Buffer.from(await file.arrayBuffer());
    return { status: "done", mime: "video/mp4", dataUrl: `data:video/mp4;base64,${buf.toString("base64")}` };
  }

  const res = await fetch(`${baseUrl}/videos/${encodeURIComponent(handle)}`, { headers: { authorization: `Bearer ${key}` } });
  const data = await readJson(res) as { status?: string; error?: { message?: string } };
  if (data.error?.message) return { status: "error", error: data.error.message };
  if (data.status === "failed") return { status: "error", error: "The provider reported the job failed." };
  if (data.status !== "completed") return { status: "pending", handle };

  const content = await fetch(`${baseUrl}/videos/${encodeURIComponent(handle)}/content`, { headers: { authorization: `Bearer ${key}` } });
  if (!content.ok) return { status: "error", error: `Could not download the video (${content.status}).` };
  const buf = Buffer.from(await content.arrayBuffer());
  return { status: "done", mime: "video/mp4", dataUrl: `data:video/mp4;base64,${buf.toString("base64")}` };
}

/** Parse a provider response, surfacing its own error text rather than a bare
 *  status code — "billing hard limit reached" is actionable, "400" is not. */
async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* handled below */ }
  if (!res.ok) {
    const msg = (parsed as { error?: { message?: string } | string })?.error;
    const detail = typeof msg === "string" ? msg : msg?.message;
    throw new Error(detail ?? `${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 240)}` : ""}`);
  }
  if (parsed === null) throw new Error("The provider returned an empty response.");
  return parsed;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
