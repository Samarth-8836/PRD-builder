import {
  formatScreenInventory,
  runNavValidate,
  runScreenCorrect,
  runScreenExtract,
} from "@/lib/operations";
import type { ChangeScope } from "@/lib/parsers";
import { type SSEWriter } from "@/lib/streaming";
import { getStorage, type Session } from "@/lib/storage";
import { runDesignStage } from "./design-stage";

interface RunCascadeInput {
  session: Session;
  sse: SSEWriter;
  signal?: AbortSignal;
  scope: ChangeScope;
  description: string;
}

/**
 * Cascade runner for COMPATIBLE Phase 2 changes. Routes by scope:
 *   - workflow_change: re-runs the full design stage with feedback so the
 *     workflows + screens both reflect the change.
 *   - screen_only: re-runs only the screen pipeline (extract -> validate
 *     -> conditional correct -> format).
 *   - data_only: M6 territory; for now treat as a no-op with a system note.
 *
 * The session phase remains in phase2_design_review throughout. Document
 * versions bump (workflowMap v2, screenInventory v2, etc).
 */
export async function runCascade(input: RunCascadeInput): Promise<void> {
  const { session, sse, signal, scope, description } = input;

  if (scope === "workflow_change") {
    sse.send({
      type: "progress",
      op: "phase2.cascade",
      status: "started",
      note: "Updating workflows and screens to reflect the change",
    });
    await runDesignStage({ session, sse, signal, feedback: description });
    return;
  }

  if (scope === "screen_only") {
    await runScreenOnlyCascade(input);
    return;
  }

  if (scope === "data_only") {
    sse.send({
      type: "progress",
      op: "phase2.cascade",
      status: "completed",
      note: "Sample-data updates arrive in M6 (Wireframe stage); no changes applied yet",
    });
    return;
  }
}

async function runScreenOnlyCascade(input: RunCascadeInput): Promise<void> {
  const { session, sse, signal, description } = input;
  const storage = getStorage();
  const contract = session.documents.projectContract!.content;
  const workflowMap = session.documents.workflowMap!.content;

  sse.send({
    type: "progress",
    op: "phase2.cascade",
    status: "started",
    note: "Updating screens to reflect the change",
  });

  let screens = await runScreenExtract({
    contract,
    workflowMap,
    feedback: description,
    signal,
  });
  sse.send({
    type: "progress",
    op: "phase2.screen_extract",
    status: "completed",
    note: `Re-derived ${screens.length} screens`,
  });

  const validation = await runNavValidate({ workflowMap, screens, signal });
  sse.send({
    type: "progress",
    op: "phase2.nav_validate",
    status: "completed",
    note:
      validation.status === "ok"
        ? "Navigation graph is complete"
        : `Found ${validation.gaps.length} gap${validation.gaps.length === 1 ? "" : "s"}`,
  });

  if (validation.status === "gaps") {
    screens = await runScreenCorrect({
      workflowMap,
      screens,
      gaps: validation.gaps,
      signal,
    });
    sse.send({
      type: "progress",
      op: "phase2.screen_correct",
      status: "completed",
      note: `Updated to ${screens.length} screens`,
    });
  }

  const inventory = formatScreenInventory(screens);
  const updated = await storage.setDocument(session.id, "screenInventory", inventory);
  sse.send({
    type: "document",
    name: "screenInventory",
    version: updated.documents.screenInventory!.version,
    content: inventory,
  });
  sse.send({
    type: "progress",
    op: "phase2.screen_inventory",
    status: "completed",
    note: "Screen Inventory updated",
  });

  sse.send({
    type: "progress",
    op: "phase2.cascade",
    status: "completed",
    note: "Screens updated - workflows unchanged",
  });
}
