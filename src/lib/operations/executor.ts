import { type ChatMessage, streamCompletion } from "@/lib/llm/provider";
import type { ModelRole } from "@/lib/llm/config";
import type { ParseResult } from "@/lib/parsers";

export interface DeltaContext {
  accumulated: string;
  attempt: number;
}

export interface ExecuteInput<T> {
  /** System prompt for the LLM. */
  system: string;
  /** User/assistant turns including the current user message. */
  messages: ChatMessage[];
  /** Parses the final accumulated text into a typed value. */
  parser: (text: string) => ParseResult<T>;
  /** Optional corrective-hint generator used on parse failure. If present
   *  AND maxAttempts > 1, the executor retries with the model's failed
   *  output as an assistant turn followed by the corrective user message. */
  correctiveHint?: (reason: string) => string;
  signal?: AbortSignal;
  role?: ModelRole;
  /** Maximum attempts including initial call. Default 2. */
  maxAttempts?: number;
  /** Streamed token callback. `attempt` starts at 1 — only emit
   *  client-visible events on attempt 1 unless duplicate output is OK. */
  onDelta?: (delta: string, ctx: DeltaContext) => void;
  /** Called when an attempt fails parsing and another attempt is starting. */
  onRetry?: (reason: string, attempt: number) => void;
}

export interface ExecuteResult<T> {
  value: T;
  rawText: string;
  attempts: number;
}

/**
 * The single point that calls the LLM for an operation. Streams the
 * response, accumulates the full text, runs the parser, and retries with a
 * corrective hint on parse failure (up to maxAttempts).
 *
 * Caller is responsible for assembling `system` and `messages` — typically
 * via `buildContext` from the Context Builder.
 */
export async function execute<T>(input: ExecuteInput<T>): Promise<ExecuteResult<T>> {
  const maxAttempts = input.maxAttempts ?? 2;

  let messages: ChatMessage[] = [
    { role: "system", content: input.system },
    ...input.messages,
  ];
  let lastError = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let accumulated = "";
    for await (const chunk of streamCompletion({
      role: input.role,
      messages,
      signal: input.signal,
    })) {
      accumulated += chunk.delta;
      input.onDelta?.(chunk.delta, { accumulated, attempt });
    }

    const parsed = input.parser(accumulated);
    if (parsed.ok) {
      return { value: parsed.value, rawText: accumulated, attempts: attempt };
    }

    lastError = parsed.error;
    const canRetry = attempt < maxAttempts && Boolean(input.correctiveHint);
    if (!canRetry) break;

    input.onRetry?.(parsed.error, attempt + 1);

    messages = [
      ...messages,
      { role: "assistant", content: accumulated },
      { role: "user", content: input.correctiveHint!(parsed.error) },
    ];
  }

  throw new Error(`Operation failed after ${maxAttempts} attempts: ${lastError}`);
}
