import { executeDAG, type NodeResult } from "@/lib/dag";
import {
  formatScreenInventory,
  formatWorkflowMap,
  runNavValidate,
  runScreenCorrect,
  runScreenExtract,
  runWorkflowDetail,
  runWorkflowDiscovery,
  type DetailedWorkflow,
} from "@/lib/operations";
import {
  type ScreenSpec,
  type WorkflowDetail,
  type WorkflowStub,
} from "@/lib/parsers";
import { type SSEWriter } from "@/lib/streaming";
import { getStorage, type Session } from "@/lib/storage";

// Kept at 1 for free-tier TPM safety (Groq free is 8K TPM; the cascade
// case in particular runs back-to-back design stages and easily blows
// past parallel TPM bursts). Bump on tiers with higher capacity.
const DETAIL_CONCURRENCY = 1;

interface RunDesignStageInput {
  session: Session;
  sse: SSEWriter;
  signal?: AbortSignal;
  /** Optional Phase 2 review feedback. When present, passed through to
   *  workflow_discovery and screen_extract so the model applies the
   *  user's requested change. Used by the cascade runner when a
   *  COMPATIBLE workflow_change is processed. */
  feedback?: string;
}

/**
 * Phase 2 Stage 1 — Design.
 *
 * Five LLM-driven steps plus two code-only formatting steps:
 *   1. workflow discovery
 *   2. workflow detail (fan-out per workflow via executeDAG)
 *   3. workflow map formatting (code)
 *   4. screen extract
 *   5. nav validation
 *   6. screen correction (conditional, only if validation found gaps)
 *   7. screen inventory formatting (code)
 *
 * The runner persists workflowMap and screenInventory documents and
 * emits progress + document + phase events along the way. On success it
 * transitions phase to phase2_design_review. On failure it rolls back to
 * phase1_complete so the user can re-trigger via Done.
 */
export async function runDesignStage(input: RunDesignStageInput): Promise<void> {
  const { session, sse, signal, feedback } = input;
  const storage = getStorage();
  const sessionId = session.id;
  const contract = session.documents.projectContract!.content;

  await storage.setPhase(sessionId, "phase2_design_running");
  sse.send({ type: "phase", phase: "phase2_design_running" });
  sse.send({
    type: "progress",
    op: "phase2.design",
    status: "started",
    note: "Designing workflows and screens",
  });

  try {
    // 1. Workflow discovery
    sse.send({
      type: "progress",
      op: "phase2.workflow_discovery",
      status: "started",
      note: "Identifying workflows",
    });
    const stubs = await runWorkflowDiscovery({ contract, feedback, signal });
    sse.send({
      type: "progress",
      op: "phase2.workflow_discovery",
      status: "completed",
      note: `Identified ${stubs.length} workflows`,
    });

    // 2. Workflow detail batch — fan out via the DAG, bounded concurrency
    sse.send({
      type: "progress",
      op: "phase2.workflow_detail",
      status: "started",
      note: `Detailing ${stubs.length} workflows in parallel`,
    });
    const details = await detailBatch(contract, stubs, signal, (completed, total) => {
      sse.send({
        type: "progress",
        op: "phase2.workflow_detail",
        status: "started",
        note: `${completed}/${total} workflows detailed`,
      });
    });
    sse.send({
      type: "progress",
      op: "phase2.workflow_detail",
      status: "completed",
      note: `All ${details.length} workflows detailed`,
    });

    // 3. Workflow map formatting (code)
    const detailed: DetailedWorkflow[] = stubs.map((stub, i) => ({
      ...stub,
      detail: details[i]!,
    }));
    const workflowMap = formatWorkflowMap(detailed);
    const wmSession = await storage.setDocument(sessionId, "workflowMap", workflowMap);
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

    // 4. Screen extraction
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

    // 5. Nav validation
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

    // 6. Screen correction (conditional)
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

    // 7. Screen inventory formatting (code)
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

    await storage.setPhase(sessionId, "phase2_design_review");
    sse.send({ type: "phase", phase: "phase2_design_review" });
    sse.send({
      type: "progress",
      op: "phase2.design",
      status: "completed",
      note: "Design stage complete - ready for review",
    });
  } catch (err: unknown) {
    // Roll back to phase1_complete so the user can re-trigger via Done.
    await storage.setPhase(sessionId, "phase1_complete");
    sse.send({ type: "phase", phase: "phase1_complete" });
    sse.send({
      type: "progress",
      op: "phase2.design",
      status: "failed",
      note: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

async function detailBatch(
  contract: string,
  stubs: WorkflowStub[],
  signal: AbortSignal | undefined,
  onProgress: (completed: number, total: number) => void
): Promise<WorkflowDetail[]> {
  let completed = 0;
  const nodes = stubs.map((stub, i) => ({
    id: `detail-${i}`,
    run: async () => {
      const detail = await runWorkflowDetail({ contract, stub, signal });
      completed += 1;
      onProgress(completed, stubs.length);
      return detail;
    },
  }));

  const results = await executeDAG(nodes, {
    concurrency: DETAIL_CONCURRENCY,
    signal,
  });

  const failed: string[] = [];
  const ordered: WorkflowDetail[] = [];
  for (let i = 0; i < stubs.length; i++) {
    const r = results.get(`detail-${i}`) as NodeResult<WorkflowDetail> | undefined;
    if (!r || r.status !== "completed" || r.value === undefined) {
      failed.push(`"${stubs[i]!.name}" (${r?.error?.message ?? "unknown error"})`);
      ordered.push({} as WorkflowDetail); // placeholder, won't be used after throw below
      continue;
    }
    ordered.push(r.value);
  }
  if (failed.length > 0) {
    throw new Error(`Workflow detail batch failed for: ${failed.join("; ")}`);
  }
  return ordered;
}
