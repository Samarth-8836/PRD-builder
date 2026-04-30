/**
 * SingleRunner — one prompt -> parse -> format. The thin layer around
 * `execute()` from the operations executor.
 *
 * In M8 this exports the runner function but it isn't called yet. M9 wires
 * the engine's `runStep` to dispatch on `runner.kind`.
 */

import { execute } from "@/lib/operations/executor";
import { getPrompt } from "@/lib/prompts";
import { makeMarkdown } from "@/lib/pipeline/slots";
import type {
  SingleRunner,
  SlotPayload,
  StepContext,
} from "@/lib/pipeline/types";

export interface SingleRunArgs {
  runner: SingleRunner;
  ctx: StepContext;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
  onRetry?: (reason: string, attempt: number) => void;
}

/** Run a single-prompt step. Returns slot payloads keyed by produces id. */
export async function runSingle(
  args: SingleRunArgs
): Promise<Record<string, SlotPayload>> {
  const { runner, ctx, signal, onDelta, onRetry } = args;
  const prompt = getPrompt(runner.prompt);
  const fewShot = prompt.fewShot ?? [];

  const userMessage = runner.buildUserMessage(ctx);

  const messages: { role: "user" | "assistant"; content: string }[] = [
    ...fewShot.flatMap((ex) => [
      { role: "user" as const, content: ex.user },
      { role: "assistant" as const, content: ex.assistant },
    ]),
    { role: "user" as const, content: userMessage },
  ];

  const { value } = await execute({
    system: prompt.system,
    messages,
    parser: runner.parser,
    correctiveHint: prompt.correctiveHint,
    signal,
    maxAttempts: runner.maxAttempts ?? 2,
    onDelta: onDelta ? (delta) => onDelta(delta) : undefined,
    onRetry,
  });

  if (runner.format) return runner.format(value, ctx);
  // Default: if string, treat as markdown; else as json under the first
  // produces slot. The runner itself doesn't know slot ids, so the engine
  // applies the default below by wrapping with the produces id. The caller
  // handles slot-id mapping for the default case.
  return defaultPayloads(value);
}

function defaultPayloads(value: unknown): Record<string, SlotPayload> {
  // The default mapping is keyed by `__default__` and the engine
  // re-keys onto the first produces id. This keeps the runner purely
  // about value-shape; slot ids live in the engine.
  if (typeof value === "string") {
    return { __default__: makeMarkdown(value) };
  }
  return { __default__: { kind: "json", data: value, version: 0 } };
}
