import { executeDAG, type NodeResult } from "@/lib/dag";
import {
  formatDataJs,
  runDummyData,
  runScreenHtml,
  runWireframeShell,
  runWireframeSmokeTest,
} from "@/lib/operations";
import { parseScreenInventoryDoc, type ScreenSpec } from "@/lib/parsers";
import { type SSEWriter } from "@/lib/streaming";
import { getStorage, type Session } from "@/lib/storage";

// Same TPM-safety value used by the design stage. Wireframe screens are
// cheaper individually but per-call output (full HTML doc) is similar in
// magnitude, so keep the same conservative cap.
const SCREEN_HTML_CONCURRENCY = 1;

interface RunWireframeStageInput {
  session: Session;
  sse: SSEWriter;
  signal?: AbortSignal;
}

/**
 * Phase 2 Stage 2 — Wireframe.
 *
 * Three LLM-driven steps plus two code-only steps:
 *   1. dummy data       — JSON sample content per entity
 *   2. wireframe shell  — index.html with global nav + landing
 *   3. per-screen HTML  — fan-out via DAG, one call per screen
 *   4. smoke test       — code-only, every screen has a file & links resolve
 *   5. data.js assembly — code-only, wraps the JSON as window.DATA
 *
 * On success the runner persists the wireframe artifact, emits a
 * `wireframe_ready` event, and transitions phase to phase2_wireframe_review.
 * On failure it rolls back to phase2_design_review so the user can re-trigger
 * via Approve.
 */
export async function runWireframeStage(
  input: RunWireframeStageInput
): Promise<void> {
  const { session, sse, signal } = input;
  const storage = getStorage();
  const sessionId = session.id;

  const contract = session.documents.projectContract!.content;
  const screenInventory = session.documents.screenInventory!.content;

  await storage.setPhase(sessionId, "phase2_wireframe_running");
  sse.send({ type: "phase", phase: "phase2_wireframe_running" });
  sse.send({
    type: "progress",
    op: "phase2.wireframe",
    status: "started",
    note: "Generating wireframe HTML and sample data",
  });

  try {
    // 0. Re-derive the parsed screen list from the saved markdown.
    const parsed = parseScreenInventoryDoc(screenInventory);
    if (!parsed.ok) {
      throw new Error(`Could not parse Screen Inventory: ${parsed.error}`);
    }
    const screens = parsed.value;

    // 1. Dummy data
    sse.send({
      type: "progress",
      op: "phase2.dummy_data",
      status: "started",
      note: "Generating realistic sample data",
    });
    const data = await runDummyData({
      contract,
      screenInventory,
      signal,
    });
    sse.send({
      type: "progress",
      op: "phase2.dummy_data",
      status: "completed",
      note: `Sample data ready (${Object.keys(data).length} entities)`,
    });

    // 2. Wireframe shell
    sse.send({
      type: "progress",
      op: "phase2.wireframe_shell",
      status: "started",
      note: "Building index.html",
    });
    const indexHtml = await runWireframeShell({
      contract,
      screens,
      signal,
    });
    sse.send({
      type: "progress",
      op: "phase2.wireframe_shell",
      status: "completed",
      note: "Shell ready",
    });

    // 3. Per-screen HTML (fan-out)
    sse.send({
      type: "progress",
      op: "phase2.screen_html",
      status: "started",
      note: `Rendering ${screens.length} screens`,
    });
    const screenHtmls = await screenHtmlBatch(
      contract,
      screens,
      data,
      signal,
      (completed, total) => {
        sse.send({
          type: "progress",
          op: "phase2.screen_html",
          status: "started",
          note: `${completed}/${total} screens rendered`,
        });
      }
    );
    sse.send({
      type: "progress",
      op: "phase2.screen_html",
      status: "completed",
      note: `All ${screens.length} screens rendered`,
    });

    // 5. Data.js assembly (code-only) — done before smoke test so it's
    //    referenced as a real file when href checks run.
    const dataJs = formatDataJs(data);

    // Assemble the artifact.
    const files: Record<string, string> = {
      "index.html": indexHtml,
      "data.js": dataJs,
    };
    for (let i = 0; i < screens.length; i++) {
      files[`${screens[i]!.id}.html`] = screenHtmls[i]!;
    }

    // 4. Smoke test (code-only)
    const issues = runWireframeSmokeTest(screens, files);
    if (issues.length > 0) {
      throw new Error(
        `Wireframe smoke test failed: ${issues.slice(0, 3).join("; ")}${
          issues.length > 3 ? ` (+${issues.length - 3} more)` : ""
        }`
      );
    }
    sse.send({
      type: "progress",
      op: "phase2.wireframe_smoke",
      status: "completed",
      note: "All screens linked and reachable",
    });

    // Persist + emit ready
    const updated = await storage.setWireframe(sessionId, files);
    sse.send({
      type: "wireframe_ready",
      version: updated.wireframe!.version,
      files: Object.keys(files),
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
    // Roll back to phase2_design_review so the user can re-trigger via
    // Approve (or roll all the way back to Phase 1 from the chat).
    await storage.setPhase(sessionId, "phase2_design_review");
    sse.send({ type: "phase", phase: "phase2_design_review" });
    sse.send({
      type: "progress",
      op: "phase2.wireframe",
      status: "failed",
      note: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

async function screenHtmlBatch(
  contract: string,
  screens: ScreenSpec[],
  data: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onProgress: (completed: number, total: number) => void
): Promise<string[]> {
  let completed = 0;
  const nodes = screens.map((screen, i) => ({
    id: `screen-${i}`,
    run: async () => {
      const html = await runScreenHtml({
        contract,
        screens,
        screen,
        data,
        signal,
      });
      completed += 1;
      onProgress(completed, screens.length);
      return html;
    },
  }));

  const results = await executeDAG(nodes, {
    concurrency: SCREEN_HTML_CONCURRENCY,
    signal,
  });

  const failed: string[] = [];
  const ordered: string[] = [];
  for (let i = 0; i < screens.length; i++) {
    const r = results.get(`screen-${i}`) as NodeResult<string> | undefined;
    if (!r || r.status !== "completed" || r.value === undefined) {
      failed.push(`"${screens[i]!.id}" (${r?.error?.message ?? "unknown error"})`);
      ordered.push("");
      continue;
    }
    ordered.push(r.value);
  }
  if (failed.length > 0) {
    throw new Error(`Per-screen HTML batch failed for: ${failed.join("; ")}`);
  }
  return ordered;
}
