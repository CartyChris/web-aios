import { NextRequest } from "next/server";
import { checkBaseUrl, deploymentKeyAllowed } from "@/lib/server-guard";
import { getProvider } from "@/lib/providers";
import { streamChat, type ChatMessage, type ToolSpec } from "@/lib/ai-transport";

// Node runtime: Next 16 deprecates the edge runtime, and streaming works
// identically here.
export const runtime = "nodejs";
export const maxDuration = 300;

/** Server-side relay for cloud providers.
 *
 *  Two reasons it exists: a deployment can hold its own keys in env vars so a
 *  visitor never needs one, and browser CORS blocks several provider APIs
 *  outright. Local providers (Ollama, LM Studio) are never routed here — the
 *  browser calls those directly, because this function has no route to the
 *  user's machine. */
export async function POST(req: NextRequest) {
  let body: {
    provider?: string;
    model?: string;
    messages?: ChatMessage[];
    temperature?: number;
    maxTokens?: number;
    apiKey?: string;
    baseUrl?: string;
    web?: boolean;
    reasoningEffort?: string;
    tools?: ToolSpec[];
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Malformed JSON body." }, 400);
  }

  const provider = getProvider(body.provider ?? "openai");
  if (!provider) return json({ error: `Unknown provider "${body.provider}".` }, 400);
  if (provider.local) return json({ error: "Local providers are called directly from the browser, not via the server." }, 400);
  if (!Array.isArray(body.messages) || body.messages.length === 0) return json({ error: "messages[] is required." }, 400);

  // The caller's own key wins; the deployment key is the fallback.
  const envKey = provider.envKey && deploymentKeyAllowed(body.baseUrl, provider.baseUrl) ? process.env[provider.envKey] : "";
  const apiKey = body.apiKey?.trim() || envKey || "";
  if (!apiKey) {
    return json(
      { error: `No API key for ${provider.name}. Add one in Settings → Providers, or set ${provider.envKey} on the deployment.` },
      401,
    );
  }

  const baseUrl = body.baseUrl?.trim() || provider.baseUrl;
  if (!baseUrl) return json({ error: "No base URL configured for this provider." }, 400);
  const blocked = await checkBaseUrl(body.baseUrl, provider.baseUrl);
  if (blocked) return json({ error: blocked }, 403);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      try {
        for await (const chunk of streamChat({
          dialect: provider.dialect,
          baseUrl,
          apiKey,
          model: body.model ?? provider.models[0],
          messages: body.messages!,
          temperature: body.temperature,
          maxTokens: body.maxTokens,
          web: body.web,
          noRedirects: !deploymentKeyAllowed(body.baseUrl, provider.baseUrl),
          reasoningEffort: body.reasoningEffort === "low" || body.reasoningEffort === "medium" || body.reasoningEffort === "high" ? body.reasoningEffort : undefined,
          ...(Array.isArray(body.tools) && body.tools.length ? { tools: body.tools } : {}),
          signal: req.signal,
        })) {
          if (chunk.delta) send({ delta: chunk.delta });
          // Native tool-call fragments are relayed raw; the client folds them.
          if (chunk.toolCalls) send({ toolCalls: chunk.toolCalls });
          // Thinking and the stop reason travel too: a client that never sees
          // them cannot tell "said nothing" from "ran out of room thinking".
          if (chunk.reasoning) send({ reasoning: chunk.reasoning });
          if (chunk.finish) send({ finish: chunk.finish });
          if (chunk.usage) send({ usage: chunk.usage });
          if (chunk.done) break;
        }
        send({ done: true });
      } catch (e) {
        // Errors are streamed rather than thrown so the client shows the real
        // provider message instead of a blank response.
        send({ error: e instanceof Error ? e.message : "Upstream request failed." });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
