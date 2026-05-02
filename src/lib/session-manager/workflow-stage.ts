import {
  changeLogWindowFor,
  ensureChangeLogCompressed,
} from "@/lib/context";
import { fireDiffSummary } from "@/lib/operations";
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

const SLOT_LABEL: Record<string, string> = Object.fromEntries(
  PRD_PIPELINE.slots.map((s) => [String(s.id), s.label] as const)
);

/**
 * Phase 2 Stage 1a — Workflow Map.
 *
 * Thin wrapper around `engine.runStep("workflow")`. The engine drives the
 * compose runner (discovery substep + workflow_detail fanout substep);
 * this wrapper translates StepProgressEvent into the legacy SSE op
 * vocabulary (`phase2.workflow_discovery`, `phase2.workflow_detail`,
 * `phase2.workflow_map`) so the UI doesn't change. Persists the workflow
 * slot via storage.setSlot and manages lifecycle state transitions.
 *
 * On success transitions to review:workflow. On failure rolls back to
 * errorRollbackState (phase1_complete by default).
 */

interface RunWorkflowStageInput {
  session: Session;
  sse: SSEWriter;
  signal?: AbortSignal;
  feedback?: string;
  errorRollbackState?: SessionLifecycle;
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
    errorRollbackState = { kind: "phase1_complete" },
  } = input;
  const storage = getStorage();
  const sessionId = session.id;

  const runningState: SessionLifecycle = {
    kind: "running",
    stepId: PRD_STEP_IDS.workflow,
  };
  await storage.setState(sessionId, runningState);
  sse.send({ type: "state", state: runningState });
  sse.send({
    type: "progress",
    op: "phase2.workflow_stage",
    status: "started",
    note: "Designing workflows",
  });

  try {
    // Compress change log if it overflowed the verbatim window since
    // the last call, then resolve the latest session view.
    const compressedSession = await ensureChangeLogCompressed(sessionId);
    const changeHistory = changeLogWindowFor(compressedSession);

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
      inputs: compressedSession.slots,
      priorOutputs: compressedSession.regenContext,
      changeHistory,
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
            stubsCount = detailTotal;
          }
        }
      },
    });

    const slotId = PRD_SLOT_IDS.workflowMap;
    const payload = requireMarkdown(out, slotId);
    const before = compressedSession.regenContext?.[slotId];
    const updated = await storage.setSlot(sessionId, slotId, payload);
    const newPayload = requireMarkdown(updated.slots, slotId);
    sse.send({
      type: "slot",
      slotId,
      payload: newPayload,
    });
    fireDiffSummary({
      sessionId,
      slotId,
      slotLabel: SLOT_LABEL[slotId] ?? slotId,
      before,
      after: newPayload,
    });
    sse.send({
      type: "progress",
      op: "phase2.workflow_map",
      status: "completed",
      note: "Workflow Map generated",
    });

    const reviewState: SessionLifecycle = {
      kind: "review",
      stepId: PRD_STEP_IDS.workflow,
    };
    await storage.setState(sessionId, reviewState);
    sse.send({ type: "state", state: reviewState });
    sse.send({
      type: "progress",
      op: "phase2.workflow_stage",
      status: "completed",
      note: "Workflows ready - review then approve to generate screens",
    });
  } catch (err: unknown) {
    await storage.setState(sessionId, errorRollbackState);
    sse.send({ type: "state", state: errorRollbackState });
    sse.send({
      type: "progress",
      op: "phase2.workflow_stage",
      status: "failed",
      note: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
