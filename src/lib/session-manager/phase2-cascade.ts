/**
 * Phase 2 review cascade dispatcher (M10 — replaces the 3×3 matrix in
 * the deleted cascade.ts).
 *
 * The review-chat classifier emits a `firstImpactStepId` (and optional
 * `firstImpactItemId` for fanout sub-targets). This module dispatches:
 *
 *   - workflow         → rewind: clear screen + wireframe, run workflow stage
 *   - screen           → rewind: clear wireframe, run screen stage
 *   - wireframeData    → patch in place: regen sample data, swap data.js
 *                        inside the existing fileset, preserve HTML files
 *   - wireframeHtml    → with itemId: regen one fanout item, patch fileset;
 *                        without itemId: clear wireframe, run wireframe stage
 *
 * The "system note" non-applicable cells (e.g. data_only at workflow_review
 * before wireframe exists) fall out automatically — when a patch target
 * doesn't exist yet, we emit a note instead of running anything.
 */

import { formatDataJs } from "@/lib/operations";
import { PipelineEngine, sessionToSlots } from "@/lib/pipeline";
import {
  PRD_PIPELINE,
  PRD_SLOT_IDS,
  PRD_STEP_IDS,
} from "@/lib/pipeline/configs/prd-builder";
import { requireFileset, requireJson } from "@/lib/pipeline/slots";
import { type SSEWriter } from "@/lib/streaming";
import { getStorage, type Phase, type Session } from "@/lib/storage";
import { runScreenStage } from "./screen-stage";
import { runWireframeStage } from "./wireframe-stage";
import { runWorkflowStage } from "./workflow-stage";

export interface RunPhase2CascadeInput {
  session: Session;
  sse: SSEWriter;
  signal?: AbortSignal;
  /** The step id the model picked as the first-impact step. */
  firstImpactStepId: string;
  /** Optional fanout sub-target (e.g. one screen id within wireframeHtml). */
  firstImpactItemId?: string;
  description: string;
  /** Phase the user was in when they sent the message (workflow_review |
   *  screen_review | wireframe_review). The dispatcher uses this to pick
   *  the right errorRollbackPhase for the underlying stage runner. */
  phase: Phase;
}

const engine = new PipelineEngine(PRD_PIPELINE);

/**
 * Builds the "this change isn't applicable here" note. Always includes
 * the rollback suggestion so users who have a Phase-1-level change
 * (new persona, new entity, etc.) misrouted as a Phase-2 change still
 * get a path forward, even if the conversation classifier + drift
 * checker both miss it.
 */
function NOT_APPLICABLE_NOTE(prefix: string): string {
  return `${prefix}. Click Approve to walk forward through the stages, then ask again. If this is actually a contract change (new persona, new entity, new boundary, or a goal-statement change), click "Roll back to Phase 1" instead — those edits live in Phase 1.`;
}

export async function runPhase2Cascade(
  input: RunPhase2CascadeInput
): Promise<void> {
  const { firstImpactStepId, phase } = input;

  switch (firstImpactStepId) {
    case PRD_STEP_IDS.workflow:
      return runWorkflowImpact(input);
    case PRD_STEP_IDS.screen:
      return runScreenImpact(input);
    case PRD_STEP_IDS.wireframeData:
      return runWireframeDataImpact(input);
    case PRD_STEP_IDS.wireframeHtml:
      return runWireframeHtmlImpact(input);
    default:
      input.sse.send({
        type: "progress",
        op: "phase2.cascade",
        status: "completed",
        note: `Cascade not applicable: unknown first-impact step "${firstImpactStepId}" (phase ${phase})`,
      });
  }
}

// ---------------------------------------------------------------------------
// workflow → rewind: clear all stale downstream, re-run workflow stage,
// land at phase2_workflow_review.
// ---------------------------------------------------------------------------

async function runWorkflowImpact(input: RunPhase2CascadeInput): Promise<void> {
  const { session, sse, signal, description, phase } = input;
  const storage = getStorage();

  sse.send({
    type: "progress",
    op: "phase2.cascade",
    status: "started",
    note:
      phase === "phase2_workflow_review"
        ? "Updating workflows to reflect the change"
        : "Rewinding to the Workflow stage; you'll re-approve downstream stages after",
  });

  if (session.documents.screenInventory) {
    await storage.clearDocument(session.id, "screenInventory");
  }
  if (session.wireframe) {
    await storage.clearWireframe(session.id);
    sse.send({ type: "wireframe_cleared" });
  }

  await runWorkflowStage({
    session,
    sse,
    signal,
    feedback: description,
    errorRollbackPhase: phase,
  });
}

// ---------------------------------------------------------------------------
// screen → rewind: clear stale wireframe, re-run screen stage, land at
// phase2_screen_review.
// ---------------------------------------------------------------------------

async function runScreenImpact(input: RunPhase2CascadeInput): Promise<void> {
  const { session, sse, signal, description, phase } = input;
  const storage = getStorage();

  if (phase === "phase2_workflow_review") {
    // Screen list doesn't exist yet at workflow_review.
    sse.send({
      type: "progress",
      op: "phase2.cascade",
      status: "completed",
      note: NOT_APPLICABLE_NOTE(
        "Screen tweaks apply once the screen list is generated"
      ),
    });
    return;
  }

  sse.send({
    type: "progress",
    op: "phase2.cascade",
    status: "started",
    note:
      phase === "phase2_screen_review"
        ? "Updating screens to reflect the change"
        : "Rewinding to the Screen stage; you'll re-approve the wireframe after",
  });

  if (session.wireframe) {
    await storage.clearWireframe(session.id);
    sse.send({ type: "wireframe_cleared" });
  }

  await runScreenStage({
    session,
    sse,
    signal,
    feedback: description,
    errorRollbackPhase: phase,
  });
}

// ---------------------------------------------------------------------------
// wireframeData → patch in place: regen sample data, swap data.js inside
// the existing fileset, preserve HTML files. Stay at wireframe_review.
// ---------------------------------------------------------------------------

async function runWireframeDataImpact(
  input: RunPhase2CascadeInput
): Promise<void> {
  const { session, sse, signal, description, phase } = input;
  const storage = getStorage();

  if (!session.wireframe) {
    sse.send({
      type: "progress",
      op: "phase2.cascade",
      status: "completed",
      note: NOT_APPLICABLE_NOTE(
        "Sample-data tweaks take effect once the wireframe is generated"
      ),
    });
    return;
  }

  sse.send({
    type: "progress",
    op: "phase2.cascade",
    status: "started",
    note: "Regenerating sample data — screen HTML will be preserved",
  });

  const slots = sessionToSlots(session);
  const dataOut = await engine.runStep({
    stepId: PRD_STEP_IDS.wireframeData,
    sessionId: session.id,
    inputs: slots,
    feedback: description,
    signal,
  });
  const dataPayload = requireJson(dataOut, PRD_SLOT_IDS.wireframeData);
  const data = dataPayload.data as Record<string, unknown>;
  sse.send({
    type: "progress",
    op: "phase2.dummy_data",
    status: "completed",
    note: `Sample data refreshed (${Object.keys(data).length} entities)`,
  });

  const nextFiles: Record<string, string> = {
    ...session.wireframe.files,
    "data.js": formatDataJs(data),
  };
  const updated = await storage.setWireframe(session.id, nextFiles);
  sse.send({
    type: "wireframe_ready",
    version: updated.wireframe!.version,
    files: Object.keys(nextFiles),
  });
  sse.send({
    type: "progress",
    op: "phase2.cascade",
    status: "completed",
    note: "Sample data updated — reload the wireframe to see the new content",
  });
  void phase;
}

// ---------------------------------------------------------------------------
// wireframeHtml →
//   with itemId: regen one fanout item, patch the matching <id>.html in
//   the existing fileset, stay at wireframe_review.
//   without itemId: clear wireframe, re-run wireframe stage from scratch.
// ---------------------------------------------------------------------------

async function runWireframeHtmlImpact(
  input: RunPhase2CascadeInput
): Promise<void> {
  const { session, sse, signal, description, firstImpactItemId, phase } = input;
  const storage = getStorage();

  if (!session.wireframe) {
    sse.send({
      type: "progress",
      op: "phase2.cascade",
      status: "completed",
      note: NOT_APPLICABLE_NOTE(
        "Wireframe tweaks apply once the wireframe is generated"
      ),
    });
    return;
  }

  // Without an item id, regenerate every screen HTML by re-running the
  // wireframe stage from scratch. Defer that to the stage runner so the
  // SSE vocabulary matches the initial-build path.
  if (!firstImpactItemId) {
    await storage.clearWireframe(session.id);
    sse.send({ type: "wireframe_cleared" });
    await runWireframeStage({ session, sse, signal });
    return;
  }

  // Single-item regen — patch one screen HTML in place.
  const slots = sessionToSlots(session);
  const allHtml = requireFileset(slots, PRD_SLOT_IDS.wireframeFiles).files;
  const targetFile = `${firstImpactItemId}.html`;
  if (!(targetFile in allHtml)) {
    sse.send({
      type: "progress",
      op: "phase2.cascade",
      status: "completed",
      note: `No screen "${firstImpactItemId}" found in the wireframe; the change couldn't be applied.`,
    });
    return;
  }

  sse.send({
    type: "progress",
    op: "phase2.cascade",
    status: "started",
    note: `Regenerating the ${firstImpactItemId} screen — others preserved`,
  });

  // Pre-populate priorResults so the fanout reuses the existing screen
  // HTML for every other item (no LLM call) and only regenerates the
  // target item.
  const priorResults: Record<string, unknown> = {};
  for (const key of Object.keys(allHtml)) {
    if (key.endsWith(".html") && key !== "index.html" && key !== targetFile) {
      const screenId = key.replace(/\.html$/, "");
      priorResults[screenId] = allHtml[key];
    }
  }

  const out = await engine.runStep({
    stepId: PRD_STEP_IDS.wireframeHtml,
    sessionId: session.id,
    inputs: slots,
    feedback: description,
    target: firstImpactItemId,
    onlyItemId: firstImpactItemId,
    priorResults,
    signal,
  });

  // The fanout reduce already produced the full updated fileset (shell +
  // every screen HTML). Persist it.
  const filesPayload = requireFileset(out, PRD_SLOT_IDS.wireframeFiles);
  const updated = await storage.setWireframe(session.id, filesPayload.files);
  sse.send({
    type: "wireframe_ready",
    version: updated.wireframe!.version,
    files: Object.keys(filesPayload.files),
  });
  sse.send({
    type: "progress",
    op: "phase2.cascade",
    status: "completed",
    note: `Updated ${targetFile}`,
  });
  void phase;
}
