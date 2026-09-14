/* ────────────────────────────────────────────────────────────────────────────
   Image and video generation.

   Text models all speak one of three chat dialects, which is why one transport
   covers twelve providers. Media models do not: OpenAI returns base64 from a
   synchronous POST, Google returns inline data from generateContent, and video
   on both is a long-running job you submit and then poll. So this is a small
   catalogue of models plus the four request shapes they actually use, rather
   than an abstraction pretending they are the same thing.

   Everything here runs through /api/ai/media. Unlike chat, there is no local
   provider to reach, and image payloads are large enough that the browser
   should not be holding a provider key and a multi-megabyte base64 blob at the
   same time.
   ──────────────────────────────────────────────────────────────────────────── */

export type MediaKind = "image" | "video";
export type MediaDialect = "openai-image" | "google-image" | "google-veo" | "openai-video" | "openrouter-image";

export interface MediaModel {
  id: string;
  /** True when the id is whatever the user typed rather than a catalogue
   *  entry — OpenRouter adds image models faster than any list can track. */
  custom?: boolean;
  name: string;
  provider: string;
  kind: MediaKind;
  dialect: MediaDialect;
  /** Wire model name, when it differs from the id shown in the picker. */
  model: string;
  sizes?: string[];
  /** Roughly, per image or per second of video. Shown before you spend it. */
  approxUsd?: number;
  note?: string;
}

export const MEDIA_MODELS: MediaModel[] = [
  {
    id: "gpt-image-1", name: "GPT Image 1", provider: "openai", kind: "image", dialect: "openai-image",
    model: "gpt-image-1", sizes: ["1024x1024", "1536x1024", "1024x1536"], approxUsd: 0.04,
    note: "Strong at text inside images and at following a long brief.",
  },
  {
    id: "dall-e-3", name: "DALL·E 3", provider: "openai", kind: "image", dialect: "openai-image",
    model: "dall-e-3", sizes: ["1024x1024", "1792x1024", "1024x1792"], approxUsd: 0.04,
    note: "Rewrites your prompt before drawing it, which helps novices and fights experts.",
  },
  {
    id: "gemini-image", name: "Gemini 3 Pro Image", provider: "google", kind: "image", dialect: "google-image",
    model: "gemini-3-pro-image-preview", approxUsd: 0.04,
    note: "Conversational editing — describe a change and it redraws the same subject.",
  },
  {
    id: "imagen-4", name: "Imagen 4", provider: "google", kind: "image", dialect: "google-image",
    model: "imagen-4.0-generate-001", sizes: ["1024x1024"], approxUsd: 0.04,
    note: "Photographic. The best of these at faces and natural light.",
  },
  {
    id: "grok-image", name: "Grok Image", provider: "xai", kind: "image", dialect: "openai-image",
    model: "grok-2-image-1212", approxUsd: 0.07,
    note: "OpenAI-compatible endpoint, so it needs no special handling.",
  },
  /* OpenRouter routes image generation through the ordinary chat endpoint:
     ask for the "image" modality and the picture comes back as a data URL in
     the message. One key, one endpoint, and every image model any vendor
     ships on OpenRouter becomes available without new code here. */
  {
    id: "or-gemini-3-pro-image", name: "Gemini 3 Pro Image", provider: "openrouter", kind: "image", dialect: "openrouter-image",
    model: "google/gemini-3-pro-image", approxUsd: 0.04,
    note: "Through OpenRouter. Conversational editing — describe a change and it redraws the same subject.",
  },
  {
    id: "or-gemini-flash-image", name: "Gemini 3.1 Flash Image", provider: "openrouter", kind: "image", dialect: "openrouter-image",
    model: "google/gemini-3.1-flash-image", approxUsd: 0.02,
    note: "Through OpenRouter. Fast and cheap; good for iterating on a look.",
  },
  {
    id: "or-gpt-image", name: "GPT-5 Image", provider: "openrouter", kind: "image", dialect: "openrouter-image",
    model: "openai/gpt-5-image", approxUsd: 0.05,
    note: "Through OpenRouter. Strongest of these at text inside an image.",
  },
  {
    id: "or-custom", name: "Any OpenRouter model…", provider: "openrouter", kind: "image", dialect: "openrouter-image",
    model: "", custom: true,
    note: "Paste any OpenRouter model id that can output images. The picker marks those with an image badge.",
  },
  {
    id: "veo-3", name: "Veo 3", provider: "google", kind: "video", dialect: "google-veo",
    model: "veo-3.0-generate-preview", approxUsd: 0.4,
    note: "Eight seconds with audio. Submitted as a job and polled — a minute or two is normal.",
  },
  {
    id: "sora-2", name: "Sora 2", provider: "openai", kind: "video", dialect: "openai-video",
    model: "sora-2", sizes: ["1280x720", "720x1280"], approxUsd: 0.5,
    note: "Submitted as a job and polled. Rendering takes minutes, not seconds.",
  },
];

export const getMediaModel = (id: string) => MEDIA_MODELS.find((m) => m.id === id);
export const imageModels = () => MEDIA_MODELS.filter((m) => m.kind === "image");
export const videoModels = () => MEDIA_MODELS.filter((m) => m.kind === "video");

export interface MediaJob {
  /** "done" carries a data URL; "pending" carries a handle to poll with. */
  status: "done" | "pending" | "error";
  dataUrl?: string;
  mime?: string;
  handle?: string;
  error?: string;
  /** What the provider actually drew, when it rewrote your prompt. */
  revisedPrompt?: string;
}

interface GenerateArgs {
  modelId: string;
  prompt: string;
  size?: string;
  apiKey?: string;
  /** Overrides the catalogue's wire model — used by the "any model" entry. */
  model?: string;
  /** Give the generating model live web access where the provider supports it. */
  web?: boolean;
  signal?: AbortSignal;
}

async function post(body: Record<string, unknown>, signal?: AbortSignal): Promise<MediaJob> {
  const res = await fetch("/api/ai/media", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const json = (await res.json().catch(() => ({ error: `${res.status} ${res.statusText}` }))) as MediaJob & { error?: string };
  if (!res.ok || json.error) return { status: "error", error: json.error ?? `${res.status} ${res.statusText}` };
  return json;
}

export function generateMedia({ modelId, prompt, size, apiKey, model, web, signal }: GenerateArgs): Promise<MediaJob> {
  return post({ op: "generate", modelId, prompt, size, apiKey, model, web }, signal);
}

export function pollMedia(modelId: string, handle: string, apiKey?: string, signal?: AbortSignal): Promise<MediaJob> {
  return post({ op: "poll", modelId, handle, apiKey }, signal);
}

/** Poll a job to completion, reporting each attempt so the UI can say something
 *  more useful than a spinner. Video jobs run for minutes; a caller that cannot
 *  show progress will look hung. */
export async function awaitMedia(
  modelId: string,
  job: MediaJob,
  opts: { apiKey?: string; signal?: AbortSignal; onTick?: (seconds: number) => void; timeoutMs?: number } = {},
): Promise<MediaJob> {
  if (job.status !== "pending" || !job.handle) return job;
  const timeout = opts.timeoutMs ?? 10 * 60_000;
  const started = Date.now();
  let delay = 4000;
  while (Date.now() - started < timeout) {
    if (opts.signal?.aborted) return { status: "error", error: "Cancelled." };
    await new Promise((r) => setTimeout(r, delay));
    opts.onTick?.(Math.round((Date.now() - started) / 1000));
    const next = await pollMedia(modelId, job.handle, opts.apiKey, opts.signal);
    if (next.status !== "pending") return next;
    // Back off gently: a Veo job is not going to finish in the first 10s.
    delay = Math.min(delay * 1.4, 15000);
  }
  return { status: "error", error: "Timed out waiting for the provider. The job may still finish on their side." };
}
