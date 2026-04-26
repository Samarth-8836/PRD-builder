import { executeDAG, type NodeResult } from "@/lib/dag";
import {
  formatWorkflowMap,
  runWorkflowDetail,
  runWorkflowDiscovery,
  type DetailedWorkflow,
} from "@/lib/operations";
import { type WorkflowDetail, type WorkflowStub } from "@/lib/parsers";
import { type SSEWriter } from "@/lib/streaming";
import { getStorage, type Phase, type Session } from "@/lib/storage";

// Kept at 1 for free-tier TPM safety (Groq free is 8K TPM; back-to-back
// stage runs in cascades easily blow past parallel TPM bursts). Bump on
// tiers with higher capacity.
const DETAIL_CONCURRENCY = 1;

interface RunWorkflowStageInput {
  session: Session;
  sse: SSEWriter;
  signal?: AbortSignal;
  /** Optional review feedback. When present, passed through to
   *  workflow_discovery so the model applies the user's requested change. */
  feedback?: string;
  /** On error, where to roll the session back to. Defaults to
   *  phase1_complete (initial run). For cascades from a later review state,
   *  pass the prior review phase so the user can re-trigger via Approve. */
  errorRollbackPhase?: Phase;
}

/**
 * Phase 2 Stage 1a — Workflow Map.
 *
 *   1. workflow discovery
 *   2. workflow detail (fan-out per workflow via executeDAG)
 *   3. workflow map formatting (code)
 *
 * On success persists workflowMap and transitions phase to
 * phase2_workflow_review. On failure rolls back to errorRollbackPhase
 * (phase1_complete by default).
 */
export async function runWorkflowStage(
  input: RunWorkflowStageInput
): Promise<void> {
  const {
    session,
    sse,
    signal,
    feedback,
    errorRollbackPhase = "phase1_complete",
  } = input;
  const storage = getStorage();
  const sessionId = session.id;
  const contract = session.documents.projectContract!.content;

  await storage.setPhase(sessionId, "phase2_workflow_running");
  sse.send({ type: "phase", phase: "phase2_workflow_running" });
  sse.send({
    type: "progress",
    op: "phase2.workflow_stage",
    status: "started",
    note: "Designing workflows",
  });

  try {
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

    sse.send({
      type: "progress",
      op: "phase2.workflow_detail",
      status: "started",
      note: `Detailing ${stubs.length} workflows`,
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

    await storage.setPhase(sessionId, "phase2_workflow_review");
    sse.send({ type: "phase", phase: "phase2_workflow_review" });
    sse.send({
      type: "progress",
      op: "phase2.workflow_stage",
      status: "completed",
      note: "Workflows ready - review then approve to generate screens",
    });
  } catch (err: unknown) {
    await storage.setPhase(sessionId, errorRollbackPhase);
    sse.send({ type: "phase", phase: errorRollbackPhase });
    sse.send({
      type: "progress",
      op: "phase2.workflow_stage",
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
      ordered.push({} as WorkflowDetail);
      continue;
    }
    ordered.push(r.value);
  }
  if (failed.length > 0) {
    throw new Error(`Workflow detail batch failed for: ${failed.join("; ")}`);
  }
  return ordered;
}
