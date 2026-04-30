/**
 * Storage adapter — bridges between the legacy `Session` shape (where
 * documents are named fields) and the new slot-keyed view that the engine
 * expects.
 *
 * Lives only during the M9-M10 transition. M11 replaces `Session.documents`
 * + `Session.wireframe` with `Session.slots: Record<DocSlotId, SlotPayload>`,
 * at which point the adapter becomes a no-op pass-through and is deleted.
 *
 * The mapping is fixed (PRD pipeline only): the legacy storage shape has
 * exactly one shape and three named documents. Once we add a second
 * pipeline (M13), this adapter is already gone.
 */

import { PRD_SLOT_IDS } from "./configs/prd-builder";
import { makeFileset, makeJson, makeMarkdown } from "./slots";
import type { SlotPayload } from "./types";
import type { Session } from "@/lib/storage";

/**
 * Build a slot-keyed view of the session's current state for engine input.
 * Includes the synthesized `wireframeData` payload reconstructed from
 * `wireframe.files["data.js"]` so screen-only cascades can pass it through
 * to wireframeHtml without re-running the data step.
 */
export function sessionToSlots(
  session: Session
): Record<string, SlotPayload> {
  const slots: Record<string, SlotPayload> = {};

  if (session.documents.projectContract) {
    slots[PRD_SLOT_IDS.projectContract] = makeMarkdown(
      session.documents.projectContract.content,
      session.documents.projectContract.version
    );
  }
  if (session.documents.workflowMap) {
    slots[PRD_SLOT_IDS.workflowMap] = makeMarkdown(
      session.documents.workflowMap.content,
      session.documents.workflowMap.version
    );
  }
  if (session.documents.screenInventory) {
    slots[PRD_SLOT_IDS.screenInventory] = makeMarkdown(
      session.documents.screenInventory.content,
      session.documents.screenInventory.version
    );
  }
  if (session.wireframe) {
    slots[PRD_SLOT_IDS.wireframeFiles] = makeFileset(
      session.wireframe.files,
      session.wireframe.version
    );
    const data = extractDummyData(session.wireframe.files["data.js"] ?? "");
    if (data) {
      slots[PRD_SLOT_IDS.wireframeData] = makeJson(
        data,
        session.wireframe.version
      );
    }
  }

  return slots;
}

/**
 * Extract `window.DATA = {...};` from a `data.js` file body. Returns null
 * if the format isn't recognized.
 */
export function extractDummyData(
  dataJs: string
): Record<string, unknown> | null {
  const match = dataJs.match(/window\.DATA\s*=\s*([\s\S]*?);\s*$/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]!) as Record<string, unknown>;
  } catch {
    return null;
  }
}
