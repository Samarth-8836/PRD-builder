import { PipelineEngine, sessionToSlots } from "@/lib/pipeline";
import {
  PRD_PIPELINE,
  PRD_SLOT_IDS,
  PRD_STEP_IDS,
} from "@/lib/pipeline/configs/prd-builder";
// Engine is constructed once at module load — PRD_PIPELINE is the only
// consumer here.
import { requireFileset, requireJson } from "@/lib/pipeline/slots";
import { type SSEWriter } from "@/lib/streaming";
import { getStorage, type Session } from "@/lib/storage";

/**
 * Phase 2 Stage 2 — Wireframe.
 *
 * Thin wrapper around the PipelineEngine. Walks two engine steps:
 *   `wireframeData`  — produces the JSON sample data
 *   `wireframeHtml`  — composes index.html + per-screen HTML files
 *
 * Storage and SSE are owned by this wrapper (the engine is pure compute).
 * The wrapper preserves the legacy SSE event vocabulary
 * (`progress` op = `phase2.dummy_data`, `phase2.wireframe_shell`,
 * `phase2.screen_html`, `phase2.wireframe_smoke`, `wireframe_ready`) so
 * the UI doesn't need to change.
 *
 * On success persists the wireframe artifact and transitions phase to
 * phase2_wireframe_review. On failure rolls back to phase2_screen_review.
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

  await storage.setPhase(sessionId, "phase2_wireframe_running");
  sse.send({ type: "phase", phase: "phase2_wireframe_running" });
  sse.send({
    type: "progress",
    op: "phase2.wireframe",
    status: "started",
    note: "Generating wireframe HTML and sample data",
  });

  try {
    // Build slot view from current session state.
    const slots = sessionToSlots(session);

    // Step 1: wireframeData (single, gate=auto). Output stays in memory;
    // it's wrapped into data.js inside the wireframeFiles fileset by the
    // wireframeHtml step's reduce function.
    sse.send({
      type: "progress",
      op: "phase2.dummy_data",
      status: "started",
      note: "Generating realistic sample data",
    });
    const dataOut = await engine.runStep({
      stepId: PRD_STEP_IDS.wireframeData,
      sessionId,
      inputs: slots,
      signal,
    });
    const dataPayload = requireJson(dataOut, PRD_SLOT_IDS.wireframeData);
    const dataKeyCount = Object.keys(
      dataPayload.data as Record<string, unknown>
    ).length;
    sse.send({
      type: "progress",
      op: "phase2.dummy_data",
      status: "completed",
      note: `Sample data ready (${dataKeyCount} entities)`,
    });

    // Make the data available to the next step.
    const slotsWithData = { ...slots, ...dataOut };

    // Step 2: wireframeHtml (compose). Emits substep/fanout-item events
    // that we translate to legacy progress events.
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
      inputs: slotsWithData,
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

    // Code-only smoke test runs inside the step's reduce function and
    // throws if the artifact is broken.
    sse.send({
      type: "progress",
      op: "phase2.wireframe_smoke",
      status: "completed",
      note: "All screens linked and reachable",
    });

    // Persist the produced fileset.
    const filesPayload = requireFileset(htmlOut, PRD_SLOT_IDS.wireframeFiles);
    const updated = await storage.setWireframe(
      sessionId,
      filesPayload.files
    );
    sse.send({
      type: "wireframe_ready",
      version: updated.wireframe!.version,
      files: Object.keys(filesPayload.files),
    });

    await storage.setPhase(sessionId, "phase2_wireframe_review");
    sse.send({ type: "phase", phase: "phase2_wireframe_review" });
    sse.send({
      type: "progress",
      op: "phase2.wireframe",
      status: "completed",
      note: "Wireframe ready - click the Wireframe tab to view",
    });
  } catch (err: unknown) {
    await storage.setPhase(sessionId, "phase2_screen_review");
    sse.send({ type: "phase", phase: "phase2_screen_review" });
    sse.send({
      type: "progress",
      op: "phase2.wireframe",
      status: "failed",
      note: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

