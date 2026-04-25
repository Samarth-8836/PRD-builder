import { getPrompt, type PromptSlug } from "@/lib/prompts";
import { type ChatMessage, streamCompletion } from "@/lib/llm/provider";
import type { ModelRole } from "@/lib/llm/config";
import type { ParseResult } from "@/lib/parsers";

export interface DeltaContext {
  accumulated: string;
  attempt: number;
}

export interface ExecuteInput<T> {
  promptSlug: PromptSlug;
  user: string;
  parser: (text: string) => ParseResult<T>;
  signal?: AbortSignal;
  role?: ModelRole;
  /** Maximum attempts including initial call. Default 2. */
  maxAttempts?: number;
  /** Called on each token delta during streaming. Use it to emit progressive
   *  events. The `attempt` field starts at 1 — only emit progressive
   *  client-visible events on attempt 1 unless you want duplicate output. */
  onDelta?: (delta: string, ctx: DeltaContext) => void;
  /** Called when an attempt fails parsing and another attempt is about to
   *  start. Use this to surface "retrying" UI affordance. */
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
 */
export async function execute<T>(input: ExecuteInput<T>): Promise<ExecuteResult<T>> {
  const prompt = getPrompt(input.promptSlug);
  const maxAttempts = input.maxAttempts ?? 2;

  let messages: ChatMessage[] = buildMessages(prompt.system, prompt.fewShot, input.user);
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
    const canRetry = attempt < maxAttempts && Boolean(prompt.correctiveHint);
    if (!canRetry) break;

    input.onRetry?.(parsed.error, attempt + 1);

    messages = [
      ...messages,
      { role: "assistant", content: accumulated },
      { role: "user", content: prompt.correctiveHint!(parsed.error) },
    ];
  }

  throw new Error(
    `Operation ${input.promptSlug} failed after ${maxAttempts} attempts: ${lastError}`
  );
}

function buildMessages(
  system: string,
  fewShot: { user: string; assistant: string }[] | undefined,
  user: string
): ChatMessage[] {
  const out: ChatMessage[] = [{ role: "system", content: system }];
  if (fewShot) {
    for (const ex of fewShot) {
      out.push({ role: "user", content: ex.user });
      out.push({ role: "assistant", content: ex.assistant });
    }
  }
  out.push({ role: "user", content: user });
  return out;
}
