/**
 * FanoutRunner — derive an iterable from upstream outputs, run a prompt
 * over each item with bounded concurrency, then reduce results into slot
 * payloads.
 */

import { executeDAG } from "@/lib/dag";
import { execute } from "@/lib/operations/executor";
import { getPrompt } from "@/lib/prompts";
import type {
  FanoutRunner,
  SlotPayload,
  StepContext,
} from "@/lib/pipeline/types";

export interface FanoutRunArgs {
  runner: FanoutRunner;
  ctx: StepContext;
  signal?: AbortSignal;
  onProgress?: (
    itemId: string,
    status: "started" | "completed" | "failed",
    note?: string
  ) => void;
  /** When set, regenerate only the matching item id (sub-target case).
   *  The other items reuse the previous results passed via `priorResults`. */
  onlyItemId?: string;
  /** Prior parsed results keyed by itemId, used when `onlyItemId` is set
   *  so unchanged items are preserved without re-running. */
  priorResults?: Record<string, unknown>;
}

export async function runFanout(
  args: FanoutRunArgs
): Promise<Record<string, SlotPayload>> {
  const { runner, ctx, signal, onProgress, onlyItemId, priorResults } = args;
  const prompt = getPrompt(runner.prompt);
  const fewShot = prompt.fewShot ?? [];

  const items = runner.items(ctx);
  const itemIds = items.map((item, idx) => runner.itemId(item, idx));

  const concurrency = runner.concurrency ?? 1;

  const nodes = items.map((item, idx) => {
    const id = itemIds[idx]!;
    return {
      id,
      run: async (): Promise<unknown> => {
        if (onlyItemId && id !== onlyItemId) {
          // Reuse prior result if available; else still run (defensive).
          const prior = priorResults?.[id];
          if (prior !== undefined) return prior;
        }
        onProgress?.(id, "started");
        try {
          const userMessage = runner.buildUserMessage(ctx, item, idx);
          const { value } = await execute({
            system: prompt.system,
            messages: [
              ...fewShot.flatMap((ex) => [
                { role: "user" as const, content: ex.user },
                { role: "assistant" as const, content: ex.assistant },
              ]),
              { role: "user" as const, content: userMessage },
            ],
            parser: runner.parser,
            correctiveHint: prompt.correctiveHint,
            signal,
            maxAttempts: runner.maxAttempts ?? 2,
          });
          onProgress?.(id, "completed");
          return value;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          onProgress?.(id, "failed", msg);
          throw err;
        }
      },
    };
  });

  const results = await executeDAG(nodes, { concurrency, signal });
  const ordered: unknown[] = [];
  for (const id of itemIds) {
    const r = results.get(id);
    if (!r || r.status !== "completed") {
      throw new Error(
        `Fanout item "${id}" did not complete (status: ${r?.status ?? "missing"})`
      );
    }
    ordered.push(r.value);
  }

  return runner.reduce(items, ordered, ctx);
}
