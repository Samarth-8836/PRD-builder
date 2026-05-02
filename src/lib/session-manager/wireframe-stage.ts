import {
  changeLogWindowFor,
  ensureChangeLogCompressed,
} from "@/lib/context";
import { PipelineEngine } from "@/lib/pipeline";
import {
  PRD_PIPELINE,
  PRD_SLOT_IDS,
  PRD_STEP_IDS,
} from "@/lib/pipeline/configs/prd-builder";
import { requireFileset, requireJson } from "@/lib/pipeline/slots";
import type { SessionLifecycle } from "@/lib/pipeline/state";
import type { SlotPayload } from "@/lib/pipeline/types";
import { type SSEWriter } from "@/lib/streaming";
import { getStorage, type Session } from "@/lib/storage";

/**
 * Phase 2 Stage 2 — Wireframe.
 *
 * Walks two engine steps:
 *   `wireframeData`  — produces the JSON sample data slot
 *   `wireframeHtml`  — composes index.html + per-screen HTML files into the
 *                      wireframeFiles fileset slot
 *
 * Persists both slots and emits the legacy progress vocabulary so the UI
 * doesn't need to change. On success transitions to review:wireframeHtml.
 * On failure rolls back to review:screen.
 */

interface RunWireframeStageInput {
  session: Session;
  sse: SSEWriter;
  signal?: AbortSignal;
}

const engine = new PipelineEngine(PRD_PIPELINE);

export async function runWireframeStage(
  input: RunWireframeStageInput
): Promise<void> {
  const { session, sse, signal } = input;
  const storage = getStorage();
  const sessionId = session.id;

  const runningDataState: SessionLifecycle = {
    kind: "running",
    stepId: PRD_STEP_IDS.wireframeData,
  };
  await storage.setState(sessionId, runningDataState);
  sse.send({ type: "state", state: runningDataState });
  sse.send({
    type: "progress",
    op: "phase2.wireframe",
    status: "started",
    note: "Generating wireframe HTML and sample data",
  });

  try {
    const compressedSession = await ensureChangeLogCompressed(sessionId);
    const changeHistory = changeLogWindowFor(compressedSession);

    // Step 1: wireframeData
    sse.send({
      type: "progress",
      op: "phase2.dummy_data",
      status: "started",
      note: "Generating realistic sample data",
    });
    const dataOut = await engine.runStep({
      stepId: PRD_STEP_IDS.wireframeData,
      sessionId,
      inputs: compressedSession.slots,
      priorOutputs: compressedSession.regenContext,
      changeHistory,
      signal,
    });
    const dataPayload = requireJson(dataOut, PRD_SLOT_IDS.wireframeData);
    const dataKeyCount = Object.keys(
      dataPayload.data as Record<string, unknown>
    ).length;

    // Persist the data slot.
    const afterData = await storage.setSlot(
      sessionId,
      PRD_SLOT_IDS.wireframeData,
      dataPayload
    );
    sse.send({
      type: "slot",
      slotId: PRD_SLOT_IDS.wireframeData,
      payload: afterData.slots[PRD_SLOT_IDS.wireframeData] as SlotPayload,
    });
    sse.send({
      type: "progress",
      op: "phase2.dummy_data",
      status: "completed",
      note: `Sample data ready (${dataKeyCount} entities)`,
    });

    // Transition to running:wireframeHtml.
    const runningHtmlState: SessionLifecycle = {
      kind: "running",
      stepId: PRD_STEP_IDS.wireframeHtml,
    };
    await storage.setState(sessionId, runningHtmlState);
    sse.send({ type: "state", state: runningHtmlState });

    // Step 2: wireframeHtml
    let screensTotal = 0;
    let screensCompleted = 0;
    sse.send({
      type: "progress",
      op: "phase2.wireframe_shell",
      status: "started",
      note: "Building index.html",
    });
    const htmlOut = await engine.runStep({
      stepId: PRD_STEP_IDS.wireframeHtml,
      sessionId,
      inputs: { ...compressedSession.slots, ...dataOut },
      priorOutputs: compressedSession.regenContext,
      changeHistory,
      signal,
      onProgress: (event) => {
        if (event.kind === "substep") {
          if (event.substepId === "shell" && event.status === "completed") {
            sse.send({
              type: "progress",
              op: "phase2.wireframe_shell",
              status: "completed",
              note: "Shell ready",
            });
            sse.send({
              type: "progress",
              op: "phase2.screen_html",
              status: "started",
              note: "Rendering per-screen HTML",
            });
          }
          if (event.substepId === "screens" && event.status === "completed") {
            sse.send({
              type: "progress",
              op: "phase2.screen_html",
              status: "completed",
              note: `All ${screensTotal} screens rendered`,
            });
          }
        }
        if (event.kind === "fanout_item") {
          if (event.status === "started") screensTotal += 1;
          if (event.status === "completed") {
            screensCompleted += 1;
            sse.send({
              type: "progress",
              op: "phase2.screen_html",
              status: "started",
              note: `${screensCompleted}/${screensTotal} screens rendered`,
            });
          }
        }
      },
    });

    sse.send({
      type: "progress",
      op: "phase2.wireframe_smoke",
      status: "completed",
      note: "All screens linked and reachable",
    });

    const filesPayload = requireFileset(htmlOut, PRD_SLOT_IDS.wireframeFiles);
    const updated = await storage.setSlot(
      sessionId,
      PRD_SLOT_IDS.wireframeFiles,
      filesPayload
    );
    sse.send({
      type: "slot",
      slotId: PRD_SLOT_IDS.wireframeFiles,
      payload: requireFileset(updated.slots, PRD_SLOT_IDS.wireframeFiles),
    });

    const reviewState: SessionLifecycle = {
      kind: "review",
      stepId: PRD_STEP_IDS.wireframeHtml,
    };
    await storage.setState(sessionId, reviewState);
    sse.send({ type: "state", state: reviewState });
    sse.send({
      type: "progress",
      op: "phase2.wireframe",
      status: "completed",
      note: "Wireframe ready - click the Wireframe tab to view",
    });
  } catch (err: unknown) {
    const errState: SessionLifecycle = {
      kind: "review",
      stepId: PRD_STEP_IDS.screen,
    };
    await storage.setState(sessionId, errState);
    sse.send({ type: "state", state: errState });
    sse.send({
      type: "progress",
      op: "phase2.wireframe",
      status: "failed",
      note: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
