import { PipelineEngine } from "@/lib/pipeline";
import {
  PRD_PIPELINE,
  PRD_SLOT_IDS,
  PRD_STEP_IDS,
} from "@/lib/pipeline/configs/prd-builder";
import { requireMarkdown } from "@/lib/pipeline/slots";
import type { SessionLifecycle } from "@/lib/pipeline/state";
import { type SSEWriter } from "@/lib/streaming";
import { getStorage, type Session } from "@/lib/storage";

/**
 * Phase 2 Stage 1b — Screen Inventory.
 *
 * Thin wrapper around `engine.runStep("screen")`. The engine drives the
 * compose runner (extract substep + nav_validate substep + conditional
 * screen_correct substep + finalizeScreenList in reduce). This wrapper
 * translates StepProgressEvent into the legacy SSE op vocabulary.
 *
 * On success transitions to review:screen. On failure rolls back to
 * errorRollbackState (review:workflow by default).
 */

interface RunScreenStageInput {
  session: Session;
  sse: SSEWriter;
  signal?: AbortSignal;
  feedback?: string;
  errorRollbackState?: SessionLifecycle;
}

const engine = new PipelineEngine(PRD_PIPELINE);

export async function runScreenStage(
  input: RunScreenStageInput
): Promise<void> {
  const {
    session,
    sse,
    signal,
    feedback,
    errorRollbackState = {
      kind: "review",
      stepId: PRD_STEP_IDS.workflow,
    },
  } = input;
  const storage = getStorage();
  const sessionId = session.id;

  const runningState: SessionLifecycle = {
    kind: "running",
    stepId: PRD_STEP_IDS.screen,
  };
  await storage.setState(sessionId, runningState);
  sse.send({ type: "state", state: runningState });
  sse.send({
    type: "progress",
    op: "phase2.screen_stage",
    status: "started",
    note: "Designing screens",
  });

  try {
    sse.send({
      type: "progress",
      op: "phase2.screen_extract",
      status: "started",
      note: "Deriving screens",
    });

    const out = await engine.runStep({
      stepId: PRD_STEP_IDS.screen,
      sessionId,
      inputs: session.slots,
      feedback,
      signal,
      onProgress: (event) => {
        if (event.kind !== "substep") return;
        if (event.substepId === "extract" && event.status === "completed") {
          sse.send({
            type: "progress",
            op: "phase2.screen_extract",
            status: "completed",
            note: "Screens extracted",
          });
          sse.send({
            type: "progress",
            op: "phase2.nav_validate",
            status: "started",
            note: "Validating navigation graph",
          });
        }
        if (event.substepId === "validate" && event.status === "completed") {
          sse.send({
            type: "progress",
            op: "phase2.nav_validate",
            status: "completed",
            note: "Navigation graph validated",
          });
        }
        if (event.substepId === "correct") {
          if (event.status === "skipped") return;
          if (event.status === "started") {
            sse.send({
              type: "progress",
              op: "phase2.screen_correct",
              status: "started",
              note: "Patching screens to close gaps",
            });
          }
          if (event.status === "completed") {
            sse.send({
              type: "progress",
              op: "phase2.screen_correct",
              status: "completed",
              note: "Screens updated",
            });
          }
        }
      },
    });

    const slotId = PRD_SLOT_IDS.screenInventory;
    const payload = requireMarkdown(out, slotId);
    const updated = await storage.setSlot(sessionId, slotId, payload);
    sse.send({
      type: "slot",
      slotId,
      payload: requireMarkdown(updated.slots, slotId),
    });
    sse.send({
      type: "progress",
      op: "phase2.screen_inventory",
      status: "completed",
      note: "Screen Inventory generated",
    });

    const reviewState: SessionLifecycle = {
      kind: "review",
      stepId: PRD_STEP_IDS.screen,
    };
    await storage.setState(sessionId, reviewState);
    sse.send({ type: "state", state: reviewState });
    sse.send({
      type: "progress",
      op: "phase2.screen_stage",
      status: "completed",
      note: "Screens ready - review then approve to generate the wireframe",
    });
  } catch (err: unknown) {
    await storage.setState(sessionId, errorRollbackState);
    sse.send({ type: "state", state: errorRollbackState });
    sse.send({
      type: "progress",
      op: "phase2.screen_stage",
      status: "failed",
      note: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
