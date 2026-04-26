import {
  formatDataJs,
  formatScreenInventory,
  runDummyData,
  runNavValidate,
  runScreenCorrect,
  runScreenExtract,
  runScreenHtml,
} from "@/lib/operations";
import {
  parseScreenInventoryDoc,
  type ChangeScope,
  type ScreenSpec,
} from "@/lib/parsers";
import { type SSEWriter } from "@/lib/streaming";
import { getStorage, type Phase, type Session } from "@/lib/storage";
import { runDesignStage } from "./design-stage";

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
   *  differs between design_review (Stage 1) and wireframe_review
   *  (Stage 2). */
  phase: Phase;
}

/**
 * Cascade runner for COMPATIBLE Phase 2 changes. Routes by phase + scope:
 *
 *   design_review +
 *     workflow_change   re-runs the full design stage with feedback
 *     screen_only       re-runs only the screen pipeline
 *     data_only         no-op + system note ("regenerate after wireframe is built")
 *
 *   wireframe_review +
 *     workflow_change   clears wireframe + re-runs design stage; ends at
 *                       design_review so the user can approve the new design
 *                       which will then trigger a fresh wireframe stage
 *     screen_only       regenerates one screen's HTML (or all when no target)
 *     data_only         regenerates dummy data + rebuilds data.js; HTML
 *                       files preserved verbatim
 *
 * Document and wireframe versions bump as appropriate.
 */
export async function runCascade(input: RunCascadeInput): Promise<void> {
  const { phase } = input;
  if (phase === "phase2_design_review") {
    await runDesignReviewCascade(input);
    return;
  }
  if (phase === "phase2_wireframe_review") {
    await runWireframeReviewCascade(input);
    return;
  }
  // Other phases shouldn't reach here — handlePhase2*Chat is gated by phase.
  input.sse.send({
    type: "progress",
    op: "phase2.cascade",
    status: "completed",
    note: `Cascade not applicable in phase ${phase}; no changes applied`,
  });
}

// ---------------------------------------------------------------------------
// Design-review cascade (Stage 1)
// ---------------------------------------------------------------------------

async function runDesignReviewCascade(input: RunCascadeInput): Promise<void> {
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
    await runScreenOnlyDesignCascade(input);
    return;
  }

  // data_only at design-review — sample content lives in the wireframe,
  // which doesn't exist yet. Surface the request as a system note rather
  // than churning anything.
  sse.send({
    type: "progress",
    op: "phase2.cascade",
    status: "completed",
    note:
      "Sample-data tweaks take effect once the wireframe is generated. Click Approve to build it.",
  });
}

async function runScreenOnlyDesignCascade(
  input: RunCascadeInput
): Promise<void> {
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

// ---------------------------------------------------------------------------
// Wireframe-review cascade (Stage 2)
// ---------------------------------------------------------------------------

async function runWireframeReviewCascade(input: RunCascadeInput): Promise<void> {
  const { session, sse, signal, scope, description, target } = input;
  const storage = getStorage();

  if (scope === "workflow_change") {
    // Rewind to the Design stage. Clear the live wireframe so the doc panel
    // doesn't show a stale iframe while the design re-runs; the design stage
    // will end at phase2_design_review and the user must Approve again to
    // trigger a fresh wireframe.
    sse.send({
      type: "progress",
      op: "phase2.cascade",
      status: "started",
      note:
        "Rewinding to the Design stage so workflows and screens can be updated",
    });
    if (session.wireframe) {
      await storage.clearWireframe(session.id);
      sse.send({ type: "wireframe_cleared" });
    }
    await runDesignStage({ session, sse, signal, feedback: description });
    sse.send({
      type: "progress",
      op: "phase2.cascade",
      status: "completed",
      note:
        "Design updated — review the new workflows/screens and click Approve to regenerate the wireframe",
    });
    return;
  }

  if (!session.wireframe) {
    // Defensive: should not happen — handlePhase2WireframeReviewChat
    // shouldn't fire if the wireframe is missing. Surface as a system note.
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

  // Update only data.js; preserve every other file from the live wireframe.
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

  // Decide which screens to regenerate. With a valid target, regenerate
  // just that one. Otherwise (model didn't pick one or it's not in the
  // inventory), fall back to "every screen" — broader but still cheaper
  // than a full design re-run.
  const idSet = new Set(screens.map((s) => s.id));
  const targetIds: string[] =
    target && idSet.has(target) ? [target] : screens.map((s) => s.id);

  // Pull the dummy data shape from the live data.js so runScreenHtml gets
  // a faithful picture of what window.DATA holds — without re-running the
  // dummy_data LLM step.
  const data = extractDummyData(session.wireframe!.files["data.js"] ?? "") ?? {};

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
    note: `Screens updated (${targetIds.length} regenerated, ${
      Object.keys(session.wireframe!.files).length - targetIds.length - 2
    } preserved)`,
  });

  // Note: we silently feed the user's description into runScreenHtml? No —
  // the prompt doesn't accept feedback yet. The model uses the screen spec
  // + data shape verbatim. The change_context description nudges the
  // model only via the conversation history that ChatPanel already has.
  // The targeted regen still produces a fresh page; if the user wants more
  // surgical control, they can iterate. Suppressing unused-var lint:
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
