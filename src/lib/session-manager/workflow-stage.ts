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
 * Phase 2 Stage 1a — Workflow Map.
 *
 * Thin wrapper around `engine.runStep("workflow")`. The engine drives the
 * compose runner (discovery substep + workflow_detail fanout substep);
 * this wrapper translates StepProgressEvent into the legacy SSE op
 * vocabulary (`phase2.workflow_discovery`, `phase2.workflow_detail`,
 * `phase2.workflow_map`) so the UI doesn't change. Persists workflowMap
 * markdown via storage.setDocument and manages phase transitions.
 *
 * On success transitions to phase2_workflow_review. On failure rolls
 * back to errorRollbackPhase (phase1_complete by default).
 */

interface RunWorkflowStageInput {
  session: Session;
  sse: SSEWriter;
  signal?: AbortSignal;
  feedback?: string;
  errorRollbackPhase?: Phase;
}

const engine = new PipelineEngine(PRD_PIPELINE);

export async function runWorkflowStage(
  input: RunWorkflowStageInput
): Promise<void> {
  const {
    session,
    sse,
    signal,
    feedback,
    errorRollbackPhase = "phase1_complete",
  } = input;
  const storage = getStorage();
  const sessionId = session.id;

  await storage.setPhase(sessionId, "phase2_workflow_running");
  sse.send({ type: "phase", phase: "phase2_workflow_running" });
  sse.send({
    type: "progress",
    op: "phase2.workflow_stage",
    status: "started",
    note: "Designing workflows",
  });

  try {
    const slots = sessionToSlots(session);

    // Track totals for the legacy "N/M workflows detailed" ticker.
    let detailTotal = 0;
    let detailCompleted = 0;
    let stubsCount = 0;

    sse.send({
      type: "progress",
      op: "phase2.workflow_discovery",
      status: "started",
      note: "Identifying workflows",
    });

    const out = await engine.runStep({
      stepId: PRD_STEP_IDS.workflow,
      sessionId,
      inputs: slots,
      feedback,
      signal,
      onProgress: (event) => {
        if (event.kind === "substep") {
          if (event.substepId === "discovery" && event.status === "completed") {
            sse.send({
              type: "progress",
              op: "phase2.workflow_discovery",
              status: "completed",
              note:
                stubsCount > 0
                  ? `Identified ${stubsCount} workflows`
                  : "Workflows identified",
            });
            sse.send({
              type: "progress",
              op: "phase2.workflow_detail",
              status: "started",
              note: "Detailing workflows",
            });
          }
          if (event.substepId === "detail" && event.status === "completed") {
            sse.send({
              type: "progress",
              op: "phase2.workflow_detail",
              status: "completed",
              note: `All ${detailCompleted} workflows detailed`,
            });
          }
        }
        if (event.kind === "fanout_item") {
          if (event.status === "started") detailTotal += 1;
          if (event.status === "completed") {
            detailCompleted += 1;
            sse.send({
              type: "progress",
              op: "phase2.workflow_detail",
              status: "started",
              note: `${detailCompleted}/${detailTotal} workflows detailed`,
            });
            // Capture the post-discovery stub count (== detailTotal).
            stubsCount = detailTotal;
          }
        }
      },
    });

    const workflowMap = requireMarkdown(out, PRD_SLOT_IDS.workflowMap).content;
    const wmSession = await storage.setDocument(
      sessionId,
      "workflowMap",
      workflowMap
    );
    sse.send({
      type: "document",
      name: "workflowMap",
      version: wmSession.documents.workflowMap!.version,
      content: workflowMap,
    });
    sse.send({
      type: "progress",
      op: "phase2.workflow_map",
      status: "completed",
      note: "Workflow Map generated",
    });

    await storage.setPhase(sessionId, "phase2_workflow_review");
    sse.send({ type: "phase", phase: "phase2_workflow_review" });
    sse.send({
      type: "progress",
      op: "phase2.workflow_stage",
      status: "completed",
      note: "Workflows ready - review then approve to generate screens",
    });
  } catch (err: unknown) {
    await storage.setPhase(sessionId, errorRollbackPhase);
    sse.send({ type: "phase", phase: errorRollbackPhase });
    sse.send({
      type: "progress",
      op: "phase2.workflow_stage",
      status: "failed",
      note: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
