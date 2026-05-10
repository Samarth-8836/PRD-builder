/**
 * Generic cascade dispatcher (M13). Used by pipelines whose cascade
 * semantics are pure rewind-from-step + re-run downstream — no
 * PRD-specific patch-in-place magic. The PRD pipeline keeps its own
 * cascade dispatcher (`phase2-cascade.ts`) because it has special-cased
 * behaviors for `wireframeData` (patch data.js inside a fileset) and
 * `wireframeHtml` (single-item fanout regen).
 *
 * Behavior:
 *   - For the firstImpactStep AND every transitive descendant currently
 *     populated, mark the slot for regen (move payload to regenContext
 *     so the step prompt can preserve user customizations).
 *   - Refresh the session, hand off to runStepStage starting from the
 *     firstImpactStep. The generic stage runner walks auto-gated steps
 *     until it hits a review gate or the pipeline terminates.
 *   - Fanout sub-target case: if `firstImpactItemId` is provided AND the
 *     step is a top-level fanout AND no descendants exist, regen only
 *     the targeted item (single-item fanout regen). For other shapes the
 *     id is forwarded to the step runner as `target` and the step
 *     decides what to do with it.
 */

import { PipelineEngine } from "@/lib/pipeline";
import { getPipeline } from "@/lib/pipeline/configs";
import type { SessionLifecycle } from "@/lib/pipeline/state";
import type { StepId } from "@/lib/pipeline/types";
import { type SSEWriter } from "@/lib/streaming";
import { getStorage, type Session } from "@/lib/storage";
import { runStepStage } from "./generic-stage";

export interface RunGenericCascadeInput {
  session: Session;
  sse: SSEWriter;
  signal?: AbortSignal;
  firstImpactStepId: string;
  firstImpactItemId?: string;
  description: string;
  state: SessionLifecycle;
}

export async function runGenericCascade(
  input: RunGenericCascadeInput
): Promise<void> {
  const { session, sse, signal, firstImpactStepId, firstImpactItemId, description, state } =
    input;
  const storage = getStorage();
  const pipeline = getPipeline(session.pipelineId);
  const engine = new PipelineEngine(pipeline);

  const startStepId = firstImpactStepId as StepId;
  const startStep = pipeline.steps.find((s) => s.id === startStepId);
  if (!startStep) {
    sse.send({
      type: "progress",
      op: `${pipeline.id}.cascade`,
      status: "completed",
      note: `Cascade not applicable: unknown first-impact step "${firstImpactStepId}"`,
    });
    return;
  }

  sse.send({
    type: "progress",
    op: `${pipeline.id}.cascade`,
    status: "started",
    note:
      state.kind === "review" && state.stepId === startStepId
        ? `Updating ${startStep.label} to reflect the change`
        : `Rewinding to ${startStep.label}; you'll re-approve downstream stages after`,
  });

  // Mark the start step's slot AND every populated transitive descendant
  // for regen (move to regenContext, clear from live slots).
  const downstream = engine.stepsAfter(startStepId);
  const stepsToRewind: StepId[] = [startStepId, ...downstream];
  for (const stepId of stepsToRewind) {
    const step = pipeline.steps.find((s) => s.id === stepId)!;
    for (const slotId of step.produces) {
      const slotKey = String(slotId);
      if (session.slots[slotKey]) {
        await storage.markSlotForRegen(session.id, slotKey);
        sse.send({ type: "slot_cleared", slotId: slotKey });
      }
    }
  }

  const refreshed = (await storage.getSession(session.id))!;

  await runStepStage({
    session: refreshed,
    sse,
    signal,
    stepId: startStepId,
    feedback: description,
    errorRollbackState: state,
    target: firstImpactItemId,
  });
}
