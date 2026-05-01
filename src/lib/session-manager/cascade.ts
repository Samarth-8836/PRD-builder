import {
  formatDataJs,
  runScreenHtml,
} from "@/lib/operations";
import {
  parseScreenInventoryDoc,
  type ChangeScope,
  type ScreenSpec,
} from "@/lib/parsers";
import { PipelineEngine, sessionToSlots } from "@/lib/pipeline";
import {
  PRD_PIPELINE,
  PRD_SLOT_IDS,
  PRD_STEP_IDS,
} from "@/lib/pipeline/configs/prd-builder";
import { requireJson } from "@/lib/pipeline/slots";
import { type SSEWriter } from "@/lib/streaming";
import { getStorage, type Phase, type Session } from "@/lib/storage";
import { runScreenStage } from "./screen-stage";
import { runWorkflowStage } from "./workflow-stage";

// Engine is reused across cascade invocations; constructing it is cheap
// (just config validation), but a single instance keeps things tidy.
const engine = new PipelineEngine(PRD_PIPELINE);

interface RunCascadeInput {
  session: Session;
  sse: SSEWriter;
  signal?: AbortSignal;
  scope: ChangeScope;
  description: string;
  /** Optional screen-id targeted by the change. Used by wireframe-stage
   *  screen_only to regenerate just one HTML file. */
  target?: string;
  /** Phase the user was in when the change was issued. Cascade behavior
   *  branches across the three Phase 2 review states. */
  phase: Phase;
}

/**
 * Cascade runner for COMPATIBLE Phase 2 changes. Routes by review phase ×
 * scope. Upstream changes rewind to earlier stages; downstream-only
 * changes patch in place.
 *
 *   workflow_review +
 *     workflow_change   re-runs workflow stage with feedback
 *     screen_only       system note (screens come next via Approve)
 *     data_only         system note (data is wireframe-stage)
 *
 *   screen_review +
 *     workflow_change   rewinds: clears screen_inventory, runs workflow
 *                       stage; ends at workflow_review
 *     screen_only       re-runs screen stage with feedback
 *     data_only         system note
 *
 *   wireframe_review +
 *     workflow_change   rewinds: clears wireframe + screen_inventory,
 *                       runs workflow stage; ends at workflow_review
 *     screen_only with target  regenerates one screen's HTML
 *     screen_only no target    regenerates every screen's HTML
 *     data_only         regenerates dummy data + rebuilds data.js
 */
export async function runCascade(input: RunCascadeInput): Promise<void> {
  const { phase } = input;
  switch (phase) {
    case "phase2_workflow_review":
      await runWorkflowReviewCascade(input);
      return;
    case "phase2_screen_review":
      await runScreenReviewCascade(input);
      return;
    case "phase2_wireframe_review":
      await runWireframeReviewCascade(input);
      return;
    default:
      input.sse.send({
        type: "progress",
        op: "phase2.cascade",
        status: "completed",
        note: `Cascade not applicable in phase ${phase}; no changes applied`,
      });
  }
}

// ---------------------------------------------------------------------------
// Workflow-review cascade (Stage 1a)
// ---------------------------------------------------------------------------

async function runWorkflowReviewCascade(input: RunCascadeInput): Promise<void> {
  const { session, sse, signal, scope, description } = input;
  const storage = getStorage();

  if (scope === "workflow_change") {
    sse.send({
      type: "progress",
      op: "phase2.cascade",
      status: "started",
      note: "Updating workflows to reflect the change",
    });
    // Defense against the snapshot-restore path: the user is at
    // workflow_review with screen/wireframe possibly restored from a
    // prior session. A workflow change makes those stale, so clear
    // them before running the workflow stage. (In a fresh flow, these
    // slots are already empty, so the clears are no-ops.)
    if (session.wireframe) {
      await storage.clearWireframe(session.id);
      sse.send({ type: "wireframe_cleared" });
    }
    if (session.documents.screenInventory) {
      await storage.clearDocument(session.id, "screenInventory");
    }
    await runWorkflowStage({
      session,
      sse,
      signal,
      feedback: description,
      errorRollbackPhase: "phase2_workflow_review",
    });
    return;
  }

  if (scope === "screen_only") {
    sse.send({
      type: "progress",
      op: "phase2.cascade",
      status: "completed",
      note:
        "Screen tweaks apply once the screen list is generated. Click Approve to move on, then ask again.",
    });
    return;
  }

  // data_only at workflow-review — wireframe doesn't exist yet.
  sse.send({
    type: "progress",
    op: "phase2.cascade",
    status: "completed",
    note:
      "Sample-data tweaks take effect once the wireframe is generated. Click Approve through the next two stages first.",
  });
}

// ---------------------------------------------------------------------------
// Screen-review cascade (Stage 1b)
// ---------------------------------------------------------------------------

async function runScreenReviewCascade(input: RunCascadeInput): Promise<void> {
  const { session, sse, signal, scope, description } = input;
  const storage = getStorage();

  if (scope === "workflow_change") {
    sse.send({
      type: "progress",
      op: "phase2.cascade",
      status: "started",
      note:
        "Rewinding to the Workflow stage so workflows can be updated; you'll re-approve screens after",
    });
    // Drop the live screen inventory — it'll be regenerated after the
    // user re-approves the new workflows. Also drop wireframe if it's
    // present from a snapshot restore: it's downstream of workflows
    // and would be stale.
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
      errorRollbackPhase: "phase2_screen_review",
    });
    return;
  }

  if (scope === "screen_only") {
    sse.send({
      type: "progress",
      op: "phase2.cascade",
      status: "started",
      note: "Updating screens to reflect the change",
    });
    // Clear wireframe if present from a snapshot restore — a screen
    // change makes the rendered HTML stale.
    if (session.wireframe) {
      await storage.clearWireframe(session.id);
      sse.send({ type: "wireframe_cleared" });
    }
    await runScreenStage({
      session,
      sse,
      signal,
      feedback: description,
      errorRollbackPhase: "phase2_screen_review",
    });
    return;
  }

  // data_only at screen-review — wireframe still doesn't exist.
  sse.send({
    type: "progress",
    op: "phase2.cascade",
    status: "completed",
    note:
      "Sample-data tweaks take effect once the wireframe is generated. Click Approve to build it first.",
  });
}

// ---------------------------------------------------------------------------
// Wireframe-review cascade (Stage 2)
// ---------------------------------------------------------------------------

async function runWireframeReviewCascade(input: RunCascadeInput): Promise<void> {
  const { session, sse, signal, scope, description, target } = input;
  const storage = getStorage();

  if (scope === "workflow_change") {
    // Full rewind: clear wireframe + screen_inventory; the user will
    // re-approve workflows, then screens, then a fresh wireframe.
    sse.send({
      type: "progress",
      op: "phase2.cascade",
      status: "started",
      note:
        "Rewinding to the Workflow stage; you'll re-approve screens and the wireframe after",
    });
    if (session.wireframe) {
      await storage.clearWireframe(session.id);
      sse.send({ type: "wireframe_cleared" });
    }
    if (session.documents.screenInventory) {
      await storage.clearDocument(session.id, "screenInventory");
    }
    await runWorkflowStage({
      session,
      sse,
      signal,
      feedback: description,
      errorRollbackPhase: "phase2_wireframe_review",
    });
    return;
  }

  if (!session.wireframe) {
    sse.send({
      type: "progress",
      op: "phase2.cascade",
      status: "failed",
      note: "No wireframe to update",
    });
    return;
  }

  const screensParsed = parseScreenInventoryDoc(
    session.documents.screenInventory!.content
  );
  if (!screensParsed.ok) {
    sse.send({
      type: "progress",
      op: "phase2.cascade",
      status: "failed",
      note: `Could not parse Screen Inventory: ${screensParsed.error}`,
    });
    return;
  }
  const screens = screensParsed.value;

  if (scope === "data_only") {
    await runDataOnlyWireframeCascade({
      session,
      sse,
      signal,
      description,
      screens,
    });
    return;
  }

  if (scope === "screen_only") {
    await runScreenOnlyWireframeCascade({
      session,
      sse,
      signal,
      description,
      target,
      screens,
    });
    return;
  }
}

interface DataOnlyInput {
  session: Session;
  sse: SSEWriter;
  signal?: AbortSignal;
  description: string;
  screens: ScreenSpec[];
}

async function runDataOnlyWireframeCascade(input: DataOnlyInput): Promise<void> {
  const { session, sse, signal, description } = input;
  const storage = getStorage();

  sse.send({
    type: "progress",
    op: "phase2.cascade",
    status: "started",
    note: "Regenerating sample data — screen HTML will be preserved",
  });

  // Engine path: just re-run the wireframeData step with feedback. The
  // screen HTML files in the existing fileset are preserved verbatim;
  // we only swap data.js inside the artifact.
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
    ...session.wireframe!.files,
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
}

interface ScreenOnlyInput {
  session: Session;
  sse: SSEWriter;
  signal?: AbortSignal;
  description: string;
  target?: string;
  screens: ScreenSpec[];
}

async function runScreenOnlyWireframeCascade(
  input: ScreenOnlyInput
): Promise<void> {
  const { session, sse, signal, description, target, screens } = input;
  const storage = getStorage();
  const contract = session.documents.projectContract!.content;

  const idSet = new Set(screens.map((s) => s.id));
  const targetIds: string[] =
    target && idSet.has(target) ? [target] : screens.map((s) => s.id);

  // Note: M9 keeps this path on direct `runScreenHtml` calls because the
  // engine path would also regenerate the shell substep, which today's
  // behavior preserves verbatim. M10 will refactor the engine to allow
  // skipping unaffected substeps in cascade mode.
  const data = extractDummyDataFromArtifact(session) ?? {};

  sse.send({
    type: "progress",
    op: "phase2.cascade",
    status: "started",
    note:
      targetIds.length === 1
        ? `Regenerating the ${targetIds[0]} screen — others preserved`
        : `Regenerating all ${targetIds.length} screens — workflows unchanged`,
  });

  const nextFiles: Record<string, string> = { ...session.wireframe!.files };
  let completed = 0;
  for (const id of targetIds) {
    const screen = screens.find((s) => s.id === id);
    if (!screen) continue;
    const html = await runScreenHtml({
      contract,
      screens,
      screen: { ...screen },
      data,
      signal,
    });
    nextFiles[`${id}.html`] = html;
    completed += 1;
    sse.send({
      type: "progress",
      op: "phase2.screen_html",
      status: "started",
      note: `${completed}/${targetIds.length} screens regenerated`,
    });
  }

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
    note:
      targetIds.length === 1
        ? `Updated ${targetIds[0]}.html`
        : `Updated all ${targetIds.length} screens`,
  });

  void description;
}

/**
 * Reuses the adapter's parsed wireframeData slot rather than re-parsing
 * data.js inline. Returns null if the artifact has no data slot
 * (shouldn't happen post-wireframe-stage success, but defensive).
 */
function extractDummyDataFromArtifact(
  session: Session
): Record<string, unknown> | null {
  const slots = sessionToSlots(session);
  const dataSlot = slots[PRD_SLOT_IDS.wireframeData];
  if (!dataSlot || dataSlot.kind !== "json") return null;
  return dataSlot.data as Record<string, unknown>;
}
