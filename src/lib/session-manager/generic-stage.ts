/**
 * Generic stage runner — drives one step through the engine for any
 * pipeline whose stage runner doesn't need pipeline-specific SSE-op
 * translation. The PRD pipeline keeps its own thin wrappers
 * (`workflow-stage.ts`, `screen-stage.ts`, `wireframe-stage.ts`) because
 * they translate engine progress into legacy SSE op names that the UI
 * has long-running ticker hooks for. New pipelines (research-report etc.)
 * use this generic runner with simpler `<pipelineId>.<stepId>` op names.
 *
 * Responsibilities:
 *   - Set state to running:stepId, emit state event.
 *   - Compress changeLog window, build StepContext.
 *   - Call engine.runStep for the requested step.
 *   - Persist every produced slot via storage.setSlot, emit slot event,
 *     fire post-hoc diff summary.
 *   - On gate=review: transition to review:stepId.
 *     On gate=auto: chain into the next runnable step until we reach a
 *     review or the pipeline terminates.
 *     On gate=terminal: transition to complete.
 *   - On failure: rollback to errorRollbackState.
 */

import {
  changeLogWindowFor,
  ensureChangeLogCompressed,
} from "@/lib/context";
import { fireDiffSummary } from "@/lib/operations";
import { PipelineEngine } from "@/lib/pipeline";
import { getPipeline } from "@/lib/pipeline/configs";
import type { SessionLifecycle } from "@/lib/pipeline/state";
import type { SlotPayload, StepConfig, StepId } from "@/lib/pipeline/types";
import { type SSEWriter } from "@/lib/streaming";
import { getStorage, type Session } from "@/lib/storage";

export interface StageRunInput {
  session: Session;
  sse: SSEWriter;
  signal?: AbortSignal;
  /** The step id to start from. The runner will chain auto-gated steps
   *  until it reaches a review or terminal gate. */
  stepId: StepId;
  /** Optional change-mode feedback to plumb into the StepContext. */
  feedback?: string;
  /** Where to land state on error. Defaults to phase1_complete. */
  errorRollbackState?: SessionLifecycle;
  /** Optional fanout sub-target — only meaningful when the step's runner
   *  is `kind: "fanout"`. */
  target?: string;
  /** Pre-populated fanout sub-results (for single-item regen). */
  priorResults?: Record<string, unknown>;
}

export async function runStepStage(input: StageRunInput): Promise<void> {
  const {
    session,
    sse,
    signal,
    stepId,
    feedback,
    errorRollbackState = { kind: "phase1_complete" },
    target,
    priorResults,
  } = input;
  const storage = getStorage();
  const sessionId = session.id;
  const pipeline = getPipeline(session.pipelineId);
  const engine = new PipelineEngine(pipeline);

  const slotLabel = (id: string): string =>
    pipeline.slots.find((s) => String(s.id) === id)?.label ?? id;

  let currentStepId: StepId = stepId;

  try {
    while (true) {
      const step = pipeline.steps.find((s) => s.id === currentStepId);
      if (!step) {
        throw new Error(`Unknown step id "${String(currentStepId)}"`);
      }

      const runningState: SessionLifecycle = {
        kind: "running",
        stepId: currentStepId,
      };
      await storage.setState(sessionId, runningState);
      sse.send({ type: "state", state: runningState });
      sse.send({
        type: "progress",
        op: `${pipeline.id}.${String(currentStepId)}`,
        status: "started",
        note: `Generating ${step.label}`,
      });

      const compressedSession = await ensureChangeLogCompressed(sessionId);
      const changeHistory = changeLogWindowFor(compressedSession);

      const out = await engine.runStep({
        stepId: currentStepId,
        sessionId,
        inputs: compressedSession.slots,
        priorOutputs: compressedSession.regenContext,
        changeHistory,
        feedback: currentStepId === stepId ? feedback : undefined,
        target: currentStepId === stepId ? target : undefined,
        priorResults: currentStepId === stepId ? priorResults : undefined,
        signal,
        onProgress: (event) => {
          if (event.kind === "substep") {
            sse.send({
              type: "progress",
              op: `${pipeline.id}.${String(currentStepId)}.${event.substepId}`,
              status: event.status === "skipped" ? "completed" : event.status,
              note: event.note,
            });
          }
          if (event.kind === "fanout_item") {
            sse.send({
              type: "progress",
              op: `${pipeline.id}.${String(currentStepId)}.item`,
              status: event.status,
              note: `${event.itemId}${event.note ? ` — ${event.note}` : ""}`,
            });
          }
        },
      });

      // Persist every produced slot. fireDiffSummary attaches a 1-2
      // sentence summary to the most-recent ChangeLogEntry so the History
      // panel surfaces the per-slot delta of this regeneration.
      for (const [slotId, payload] of Object.entries(out)) {
        const before = compressedSession.regenContext?.[slotId];
        const updated = await storage.setSlot(
          sessionId,
          slotId,
          payload as SlotPayload
        );
        const after = updated.slots[slotId]!;
        sse.send({ type: "slot", slotId, payload: after });
        fireDiffSummary({
          sessionId,
          slotId,
          slotLabel: slotLabel(slotId),
          before,
          after,
        });
      }

      sse.send({
        type: "progress",
        op: `${pipeline.id}.${String(currentStepId)}`,
        status: "completed",
        note: `${step.label} ready`,
      });

      // Decide what comes next based on the gate.
      if (step.gate === "terminal") {
        const completeState: SessionLifecycle = { kind: "complete" };
        await storage.setState(sessionId, completeState);
        sse.send({ type: "state", state: completeState });
        return;
      }
      if (step.gate === "review") {
        const reviewState: SessionLifecycle = {
          kind: "review",
          stepId: currentStepId,
        };
        await storage.setState(sessionId, reviewState);
        sse.send({ type: "state", state: reviewState });
        return;
      }
      // gate === "auto" — continue with the next runnable step.
      const refreshed = (await storage.getSession(sessionId))!;
      const next = engine.nextRunnableStep(refreshed.slots);
      if (!next) {
        // No more runnable steps — pipeline terminated. Move to complete.
        const completeState: SessionLifecycle = { kind: "complete" };
        await storage.setState(sessionId, completeState);
        sse.send({ type: "state", state: completeState });
        return;
      }
      currentStepId = next;
    }
  } catch (err: unknown) {
    await storage.setState(sessionId, errorRollbackState);
    sse.send({ type: "state", state: errorRollbackState });
    sse.send({
      type: "progress",
      op: `${pipeline.id}.${String(currentStepId)}`,
      status: "failed",
      note: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/** Find the next step to run from a given starting point. The starting
 *  step's outputs are not considered "ready" — we always re-run starting
 *  from there. Used by the generic cascade dispatcher. */
export function stepsToRunFrom(
  pipeline: { steps: readonly StepConfig[] },
  startStepId: StepId
): readonly StepId[] {
  const out: StepId[] = [];
  let started = false;
  for (const s of pipeline.steps) {
    if (s.id === startStepId) started = true;
    if (started) out.push(s.id);
  }
  return out;
}
