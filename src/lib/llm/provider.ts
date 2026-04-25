import { resolveModel, type ModelRole, type ResolvedModel } from "./config";
import { RetryableHttpError, isRetryableStatus, withRetry } from "./retry";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StreamCompletionInput {
  role?: ModelRole;
  messages: ChatMessage[];
  temperature?: number;
  signal?: AbortSignal;
}

export interface StreamChunk {
  delta: string;
  raw: unknown;
}

/**
 * Streams an OpenAI-compatible chat completion and yields text deltas.
 *
 * Works against any provider whose endpoint speaks OpenAI's
 * /v1/chat/completions wire format (OpenRouter, Groq, OpenAI, LiteLLM proxy,
 * Ollama, etc). Provider/model/baseURL/apiKey are resolved per call via
 * `resolveModel(role)`, so swapping providers is one env-var change.
 */
export async function* streamCompletion(
  input: StreamCompletionInput
): AsyncGenerator<StreamChunk, void, void> {
  const model = resolveModel(input.role);

  const response = await withRetry(() => openCompletionStream(model, input), {
    signal: input.signal,
  });

  if (!response.body) {
    throw new Error("LLM response had no body");
  }

  yield* readSSEChunks(response.body, input.signal);
}

async function openCompletionStream(
  model: ResolvedModel,
  input: StreamCompletionInput
): Promise<Response> {
  const res = await fetch(`${model.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${model.apiKey}`,
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      model: model.modelId,
      messages: input.messages,
      stream: true,
      temperature: input.temperature ?? 0.7,
    }),
    signal: input.signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const msg = `LLM HTTP ${res.status} from ${model.provider}: ${body.slice(0, 500)}`;
    if (isRetryableStatus(res.status)) throw new RetryableHttpError(res.status, msg);
    throw new Error(msg);
  }
  return res;
}

async function* readSSEChunks(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<StreamChunk, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nlIndex: number;
      while ((nlIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nlIndex).replace(/\r$/, "");
        buffer = buffer.slice(nlIndex + 1);
        if (!line.startsWith("data:")) continue;

        const payload = line.slice(5).trim();
        if (payload === "" || payload === "[DONE]") {
          if (payload === "[DONE]") return;
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }

        const delta = extractDelta(parsed);
        if (delta) yield { delta, raw: parsed };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function extractDelta(parsed: unknown): string {
  if (!parsed || typeof parsed !== "object") return "";
  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const choice = choices[0] as { delta?: { content?: unknown } };
  const content = choice.delta?.content;
  return typeof content === "string" ? content : "";
}
