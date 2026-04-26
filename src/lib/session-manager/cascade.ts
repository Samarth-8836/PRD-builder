import {
  formatDataJs,
  runDummyData,
  runScreenHtml,
} from "@/lib/operations";
import {
  parseScreenInventoryDoc,
  type ChangeScope,
  type ScreenSpec,
} from "@/lib/parsers";
import { type SSEWriter } from "@/lib/streaming";
import { getStorage, type Phase, type Session } from "@/lib/storage";
import { runScreenStage } from "./screen-stage";
import { runWorkflowStage } from "./workflow-stage";

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

  if (scope === "workflow_change") {
    sse.send({
      type: "progress",
      op: "phase2.cascade",
      status: "started",
      note: "Updating workflows to reflect the change",
    });
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
    // user re-approves the new workflows.
    if (session.documents.screenInventory) {
      await storage.clearDocument(session.id, "screenInventory");
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
  const contract = session.documents.projectContract!.content;
  const screenInventory = session.documents.screenInventory!.content;

  sse.send({
    type: "progress",
    op: "phase2.cascade",
    status: "started",
    note: "Regenerating sample data — screen HTML will be preserved",
  });

  const data = await runDummyData({
    contract,
    screenInventory,
    feedback: description,
    signal,
  });
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

  const data =
    extractDummyData(session.wireframe!.files["data.js"] ?? "") ?? {};

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

  // The change_context description is delivered to the model via the
  // chat history (already in conversation context); we don't pass it
  // again here. Suppressing unused-var lint:
  void description;
}

/**
 * Pulls the JSON object out of `window.DATA = {...};` so screen-only
 * regeneration can hand the same shape back to the screen prompt without
 * an extra LLM call. Returns null if anything looks off.
 */
function extractDummyData(dataJs: string): Record<string, unknown> | null {
  const match = dataJs.match(/window\.DATA\s*=\s*([\s\S]*?);\s*$/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]!) as Record<string, unknown>;
  } catch {
    return null;
  }
}
