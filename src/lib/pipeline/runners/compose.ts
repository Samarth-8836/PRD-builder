/**
 * ComposeRunner — sequential substeps with shared `subResults` accumulator,
 * then a final reduce into slot payloads. Each substep can be a single
 * prompt or a fanout.
 */

import { executeDAG } from "@/lib/dag";
import { execute } from "@/lib/operations/executor";
import { getPrompt } from "@/lib/prompts";
import type { ModelRole } from "@/lib/llm/config";
import type {
  ComposeRunner,
  ComposeSubstep,
  SlotPayload,
  StepContext,
} from "@/lib/pipeline/types";

export interface ComposeRunArgs {
  runner: ComposeRunner;
  ctx: StepContext;
  signal?: AbortSignal;
  onSubstep?: (
    substepId: string,
    status: "started" | "completed" | "skipped" | "failed",
    note?: string
  ) => void;
  onFanoutItem?: (
    substepId: string,
    itemId: string,
    status: "started" | "completed" | "failed",
    note?: string
  ) => void;
  /** Pipeline-step's modelRole (forwarded from engine.runStep). */
  role?: ModelRole;
}

export async function runCompose(
  args: ComposeRunArgs
): Promise<Record<string, SlotPayload>> {
  const { runner, ctx, signal, onSubstep, onFanoutItem, role } = args;
  const subResults: Record<string, unknown> = { ...(ctx.subResults ?? {}) };

  for (const substep of runner.substeps) {
    if (substep.kind === "single" && substep.skipIf?.(subResults, ctx)) {
      onSubstep?.(substep.id, "skipped");
      continue;
    }
    onSubstep?.(substep.id, "started");
    try {
      const value = await runSubstep(substep, ctx, subResults, {
        signal,
        role,
        onFanoutItem: (itemId, status, note) =>
          onFanoutItem?.(substep.id, itemId, status, note),
      });
      subResults[substep.id] = value;
      onSubstep?.(substep.id, "completed");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onSubstep?.(substep.id, "failed", msg);
      throw err;
    }
  }

  return runner.reduce(subResults, { ...ctx, subResults });
}

async function runSubstep(
  substep: ComposeSubstep,
  ctx: StepContext,
  subResults: Record<string, unknown>,
  opts: {
    signal?: AbortSignal;
    role?: ModelRole;
    onFanoutItem?: (
      itemId: string,
      status: "started" | "completed" | "failed",
      note?: string
    ) => void;
  }
): Promise<unknown> {
  const prompt = getPrompt(substep.prompt);
  const fewShot = prompt.fewShot ?? [];

  if (substep.kind === "single") {
    const userMessage = substep.buildUserMessage(ctx, subResults);
    const { value } = await execute({
      system: prompt.system,
      messages: [
        ...fewShot.flatMap((ex) => [
          { role: "user" as const, content: ex.user },
          { role: "assistant" as const, content: ex.assistant },
        ]),
        { role: "user" as const, content: userMessage },
      ],
      parser: substep.parser,
      correctiveHint: prompt.correctiveHint,
      signal: opts.signal,
      role: opts.role,
      maxAttempts: substep.maxAttempts ?? 2,
    });
    return value;
  }

  // fanout substep
  const items = substep.items(ctx, subResults);
  const itemIds = items.map((item, idx) => substep.itemId(item, idx));
  const concurrency = substep.concurrency ?? 1;

  // Honor cascade narrowing: when ctx.target identifies a single item,
  // re-run only that item and reuse ctx.priorResults for the rest.
  const onlyItemId = ctx.target;
  const priorResults = ctx.priorResults;

  const nodes = items.map((item, idx) => {
    const id = itemIds[idx]!;
    return {
      id,
      run: async (): Promise<unknown> => {
        if (onlyItemId && id !== onlyItemId) {
          const prior = priorResults?.[id];
          if (prior !== undefined) return prior;
        }
        opts.onFanoutItem?.(id, "started");
        try {
          const userMessage = substep.buildUserMessage(
            ctx,
            subResults,
            item,
            idx
          );
          const { value } = await execute({
            system: prompt.system,
            messages: [
              ...fewShot.flatMap((ex) => [
                { role: "user" as const, content: ex.user },
                { role: "assistant" as const, content: ex.assistant },
              ]),
              { role: "user" as const, content: userMessage },
            ],
            parser: substep.parser,
            correctiveHint: prompt.correctiveHint,
            signal: opts.signal,
            maxAttempts: substep.maxAttempts ?? 2,
          });
          opts.onFanoutItem?.(id, "completed");
          return value;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          opts.onFanoutItem?.(id, "failed", msg);
          throw err;
        }
      },
    };
  });

  const results = await executeDAG(nodes, {
    concurrency,
    signal: opts.signal,
  });
  const ordered: unknown[] = [];
  for (const id of itemIds) {
    const r = results.get(id);
    if (!r || r.status !== "completed") {
      throw new Error(
        `Compose-fanout item "${id}" did not complete (status: ${r?.status ?? "missing"})`
      );
    }
    ordered.push(r.value);
  }
  return substep.reduce(items, ordered);
}
