/**
 * Phase 2 review cascade dispatcher (M11 — slot-keyed).
 *
 * The review-chat classifier emits a `firstImpactStepId` (and optional
 * `firstImpactItemId` for fanout sub-targets). This module dispatches:
 *
 *   - workflow         → rewind: clear screen + wireframe slots, re-run workflow stage
 *   - screen           → rewind: clear wireframe slots, re-run screen stage
 *   - wireframeData    → patch in place: regen sample data, swap data.js
 *                        inside the existing fileset, preserve HTML files
 *   - wireframeHtml    → with itemId: regen one fanout item, patch fileset;
 *                        without itemId: clear wireframe slots, re-run wireframe stage
 *
 * The "system note" non-applicable cells (e.g. data_only at workflow_review
 * before the wireframe slot exists) fall out automatically — when a patch
 * target doesn't exist yet, we emit a note instead of running anything.
 */

import { formatDataJs } from "@/lib/operations";
import { PipelineEngine } from "@/lib/pipeline";
import {
  PRD_PIPELINE,
  PRD_SLOT_IDS,
  PRD_STEP_IDS,
} from "@/lib/pipeline/configs/prd-builder";
import { requireFileset, requireJson } from "@/lib/pipeline/slots";
import type { SessionLifecycle } from "@/lib/pipeline/state";
import { type SSEWriter } from "@/lib/streaming";
import { getStorage, type Session } from "@/lib/storage";
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
  /** Lifecycle state the user was in when they sent the message. The
   *  dispatcher uses it to pick the right errorRollbackState for the
   *  underlying stage runner. */
  state: SessionLifecycle;
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
  const { firstImpactStepId } = input;

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
        note: `Cascade not applicable: unknown first-impact step "${firstImpactStepId}"`,
      });
  }
}

function isReviewOf(state: SessionLifecycle, stepId: string): boolean {
  return state.kind === "review" && state.stepId === stepId;
}

// ---------------------------------------------------------------------------
// workflow → rewind: clear all stale downstream, re-run workflow stage
// ---------------------------------------------------------------------------

async function runWorkflowImpact(input: RunPhase2CascadeInput): Promise<void> {
  const { session, sse, signal, description, state } = input;
  const storage = getStorage();

  sse.send({
    type: "progress",
    op: "phase2.cascade",
    status: "started",
    note: isReviewOf(state, PRD_STEP_IDS.workflow)
      ? "Updating workflows to reflect the change"
      : "Rewinding to the Workflow stage; you'll re-approve downstream stages after",
  });

  // Move both the directly-edited slot (workflow) and its downstream
  // slots into regenContext. Each entry is cleared from `slots` and
  // cached for the regen step's `priorOutputs`. Workflow itself is
  // included so the model can preserve prior workflows where compatible
  // and only evolve what the change demands. Downstream slots feed the
  // next-stage regen after the user approves.
  for (const slotId of [
    PRD_SLOT_IDS.workflowMap,
    PRD_SLOT_IDS.screenInventory,
    PRD_SLOT_IDS.wireframeFiles,
    PRD_SLOT_IDS.wireframeData,
  ]) {
    if (session.slots[slotId]) {
      await storage.markSlotForRegen(session.id, slotId);
      sse.send({ type: "slot_cleared", slotId });
    }
  }
  // Refresh in-memory session so runWorkflowStage sees the updated
  // `slots` (workflow cleared) and `regenContext` (priors cached).
  const refreshed = (await storage.getSession(session.id))!;

  await runWorkflowStage({
    session: refreshed,
    sse,
    signal,
    feedback: description,
    errorRollbackState: state,
  });
}

// ---------------------------------------------------------------------------
// screen → rewind: clear stale wireframe, re-run screen stage
// ---------------------------------------------------------------------------

async function runScreenImpact(input: RunPhase2CascadeInput): Promise<void> {
  const { session, sse, signal, description, state } = input;
  const storage = getStorage();

  if (isReviewOf(state, PRD_STEP_IDS.workflow)) {
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
    note: isReviewOf(state, PRD_STEP_IDS.screen)
      ? "Updating screens to reflect the change"
      : "Rewinding to the Screen stage; you'll re-approve the wireframe after",
  });

  for (const slotId of [
    PRD_SLOT_IDS.screenInventory,
    PRD_SLOT_IDS.wireframeFiles,
    PRD_SLOT_IDS.wireframeData,
  ]) {
    if (session.slots[slotId]) {
      await storage.markSlotForRegen(session.id, slotId);
      sse.send({ type: "slot_cleared", slotId });
    }
  }
  const refreshed = (await storage.getSession(session.id))!;

  await runScreenStage({
    session: refreshed,
    sse,
    signal,
    feedback: description,
    errorRollbackState: state,
  });
}

// ---------------------------------------------------------------------------
// wireframeData → patch in place: regen sample data, swap data.js inside
// the existing fileset, preserve HTML files. Stay at review:wireframeHtml.
// ---------------------------------------------------------------------------

async function runWireframeDataImpact(
  input: RunPhase2CascadeInput
): Promise<void> {
  const { session, sse, signal, description } = input;
  const storage = getStorage();

  const existingFiles = session.slots[PRD_SLOT_IDS.wireframeFiles];
  if (!existingFiles || existingFiles.kind !== "fileset") {
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

  const dataOut = await engine.runStep({
    stepId: PRD_STEP_IDS.wireframeData,
    sessionId: session.id,
    inputs: session.slots,
    feedback: description,
    signal,
  });
  const dataPayload = requireJson(dataOut, PRD_SLOT_IDS.wireframeData);
  const data = dataPayload.data as Record<string, unknown>;

  // Persist the new data slot.
  const afterData = await storage.setSlot(
    session.id,
    PRD_SLOT_IDS.wireframeData,
    dataPayload
  );
  sse.send({
    type: "slot",
    slotId: PRD_SLOT_IDS.wireframeData,
    payload: afterData.slots[PRD_SLOT_IDS.wireframeData]!,
  });
  sse.send({
    type: "progress",
    op: "phase2.dummy_data",
    status: "completed",
    note: `Sample data refreshed (${Object.keys(data).length} entities)`,
  });

  // Patch data.js inside the fileset.
  const nextFiles: Record<string, string> = {
    ...existingFiles.files,
    "data.js": formatDataJs(data),
  };
  const updated = await storage.setSlot(
    session.id,
    PRD_SLOT_IDS.wireframeFiles,
    {
      kind: "fileset",
      files: nextFiles,
      version: 0,
    }
  );
  sse.send({
    type: "slot",
    slotId: PRD_SLOT_IDS.wireframeFiles,
    payload: requireFileset(updated.slots, PRD_SLOT_IDS.wireframeFiles),
  });
  sse.send({
    type: "progress",
    op: "phase2.cascade",
    status: "completed",
    note: "Sample data updated — reload the wireframe to see the new content",
  });
}

// ---------------------------------------------------------------------------
// wireframeHtml →
//   with itemId: regen one fanout item, patch the matching <id>.html in
//   the existing fileset.
//   without itemId: clear wireframe slots, re-run wireframe stage from scratch.
// ---------------------------------------------------------------------------

async function runWireframeHtmlImpact(
  input: RunPhase2CascadeInput
): Promise<void> {
  const { session, sse, signal, description, firstImpactItemId } = input;
  const storage = getStorage();

  const existingFiles = session.slots[PRD_SLOT_IDS.wireframeFiles];
  if (!existingFiles || existingFiles.kind !== "fileset") {
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
  // wireframe stage from scratch.
  if (!firstImpactItemId) {
    await storage.clearSlot(session.id, PRD_SLOT_IDS.wireframeFiles);
    sse.send({ type: "slot_cleared", slotId: PRD_SLOT_IDS.wireframeFiles });
    if (session.slots[PRD_SLOT_IDS.wireframeData]) {
      await storage.clearSlot(session.id, PRD_SLOT_IDS.wireframeData);
      sse.send({ type: "slot_cleared", slotId: PRD_SLOT_IDS.wireframeData });
    }
    await runWireframeStage({ session, sse, signal });
    return;
  }

  // Single-item regen — patch one screen HTML in place.
  const allHtml = existingFiles.files;
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
    inputs: session.slots,
    feedback: description,
    target: firstImpactItemId,
    onlyItemId: firstImpactItemId,
    priorResults,
    signal,
  });

  const filesPayload = requireFileset(out, PRD_SLOT_IDS.wireframeFiles);
  const updated = await storage.setSlot(
    session.id,
    PRD_SLOT_IDS.wireframeFiles,
    filesPayload
  );
  sse.send({
    type: "slot",
    slotId: PRD_SLOT_IDS.wireframeFiles,
    payload: requireFileset(updated.slots, PRD_SLOT_IDS.wireframeFiles),
  });
  sse.send({
    type: "progress",
    op: "phase2.cascade",
    status: "completed",
    note: `Updated ${targetFile}`,
  });
}
