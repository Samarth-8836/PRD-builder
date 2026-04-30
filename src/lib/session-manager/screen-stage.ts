import {
  formatScreenInventory,
  runNavValidate,
  runScreenCorrect,
  runScreenExtract,
} from "@/lib/operations";
import { finalizeScreenList } from "@/lib/parsers";
import { type SSEWriter } from "@/lib/streaming";
import { getStorage, type Phase, type Session } from "@/lib/storage";

interface RunScreenStageInput {
  session: Session;
  sse: SSEWriter;
  signal?: AbortSignal;
  /** Optional review feedback. Passed through to screen_extract so the
   *  model applies the user's requested change. */
  feedback?: string;
  /** On error, where to roll back. Defaults to phase2_workflow_review so
   *  the user can re-trigger via Approve. */
  errorRollbackPhase?: Phase;
}

/**
 * Phase 2 Stage 1b — Screen Inventory.
 *
 *   1. screen extraction
 *   2. nav validation
 *   3. screen correction (conditional, only if validation found gaps)
 *   4. screen inventory formatting (code)
 *
 * Reads the previously-saved Workflow Map from the session. On success
 * persists screenInventory and transitions phase to phase2_screen_review.
 * On failure rolls back to errorRollbackPhase (phase2_workflow_review by
 * default).
 */
export async function runScreenStage(input: RunScreenStageInput): Promise<void> {
  const {
    session,
    sse,
    signal,
    feedback,
    errorRollbackPhase = "phase2_workflow_review",
  } = input;
  const storage = getStorage();
  const sessionId = session.id;
  const contract = session.documents.projectContract!.content;
  const workflowMap = session.documents.workflowMap!.content;

  await storage.setPhase(sessionId, "phase2_screen_running");
  sse.send({ type: "phase", phase: "phase2_screen_running" });
  sse.send({
    type: "progress",
    op: "phase2.screen_stage",
    status: "started",
    note: "Designing screens",
  });

  try {
    sse.send({
      type: "progress",
      op: "phase2.screen_extract",
      status: "started",
      note: "Deriving screens",
    });
    let screens = await runScreenExtract({ contract, workflowMap, feedback, signal });
    sse.send({
      type: "progress",
      op: "phase2.screen_extract",
      status: "completed",
      note: `Extracted ${screens.length} screens`,
    });

    sse.send({
      type: "progress",
      op: "phase2.nav_validate",
      status: "started",
      note: "Validating navigation graph",
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
      sse.send({
        type: "progress",
        op: "phase2.screen_correct",
        status: "started",
        note: "Patching screens to close gaps",
      });
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

    // Code-only fixup: drop any nav targets that don't exist as screens.
    // Defends against a screen_correct pass that itself emits a dangling
    // nav reference. The wireframe stage's smoke test would catch this
    // later, but cleaning up here keeps the saved Screen Inventory
    // internally consistent.
    const finalized = finalizeScreenList(screens);
    screens = finalized.screens;
    if (finalized.droppedNav.length > 0) {
      const note =
        finalized.droppedNav.length === 1
          ? `Dropped 1 dangling nav link (${finalized.droppedNav[0]!.from} → ${finalized.droppedNav[0]!.to})`
          : `Dropped ${finalized.droppedNav.length} dangling nav links`;
      sse.send({
        type: "progress",
        op: "phase2.screen_finalize",
        status: "completed",
        note,
      });
    }

    const screenInventory = formatScreenInventory(screens);
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
