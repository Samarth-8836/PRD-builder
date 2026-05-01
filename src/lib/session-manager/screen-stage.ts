import { PipelineEngine, sessionToSlots } from "@/lib/pipeline";
import {
  PRD_PIPELINE,
  PRD_SLOT_IDS,
  PRD_STEP_IDS,
} from "@/lib/pipeline/configs/prd-builder";
import { requireMarkdown } from "@/lib/pipeline/slots";
import { type SSEWriter } from "@/lib/streaming";
import { getStorage, type Phase, type Session } from "@/lib/storage";

/**
 * Phase 2 Stage 1b — Screen Inventory.
 *
 * Thin wrapper around `engine.runStep("screen")`. The engine drives the
 * compose runner (extract substep + nav_validate substep + conditional
 * screen_correct substep + finalizeScreenList in reduce). This wrapper
 * translates StepProgressEvent into the legacy SSE op vocabulary
 * (`phase2.screen_extract`, `phase2.nav_validate`, `phase2.screen_correct`,
 * `phase2.screen_inventory`) and persists screenInventory markdown.
 *
 * On success transitions to phase2_screen_review. On failure rolls back
 * to errorRollbackPhase (phase2_workflow_review by default).
 */

interface RunScreenStageInput {
  session: Session;
  sse: SSEWriter;
  signal?: AbortSignal;
  feedback?: string;
  errorRollbackPhase?: Phase;
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
    errorRollbackPhase = "phase2_workflow_review",
  } = input;
  const storage = getStorage();
  const sessionId = session.id;

  await storage.setPhase(sessionId, "phase2_screen_running");
  sse.send({ type: "phase", phase: "phase2_screen_running" });
  sse.send({
    type: "progress",
    op: "phase2.screen_stage",
    status: "started",
    note: "Designing screens",
  });

  try {
    const slots = sessionToSlots(session);

    sse.send({
      type: "progress",
      op: "phase2.screen_extract",
      status: "started",
      note: "Deriving screens",
    });

    const out = await engine.runStep({
      stepId: PRD_STEP_IDS.screen,
      sessionId,
      inputs: slots,
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
          if (event.status === "skipped") {
            // No gaps — nothing to surface.
            return;
          }
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

    const screenInventory = requireMarkdown(
      out,
      PRD_SLOT_IDS.screenInventory
    ).content;
    const siSession = await storage.setDocument(
      sessionId,
      "screenInventory",
      screenInventory
    );
    sse.send({
      type: "document",
      name: "screenInventory",
      version: siSession.documents.screenInventory!.version,
      content: screenInventory,
    });
    sse.send({
      type: "progress",
      op: "phase2.screen_inventory",
      status: "completed",
      note: "Screen Inventory generated",
    });

    await storage.setPhase(sessionId, "phase2_screen_review");
    sse.send({ type: "phase", phase: "phase2_screen_review" });
    sse.send({
      type: "progress",
      op: "phase2.screen_stage",
      status: "completed",
      note: "Screens ready - review then approve to generate the wireframe",
    });
  } catch (err: unknown) {
    await storage.setPhase(sessionId, errorRollbackPhase);
    sse.send({ type: "phase", phase: errorRollbackPhase });
    sse.send({
      type: "progress",
      op: "phase2.screen_stage",
      status: "failed",
      note: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
