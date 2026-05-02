/**
 * In-memory pending-cascade-preview store.
 *
 * When a review-chat message classifies as a COMPATIBLE change, the
 * cascade is NOT executed immediately. Instead the server emits a
 * `cascade_preview` SSE event and stashes the cascade plan here. The
 * client renders a Confirm/Cancel banner; on Confirm a separate POST
 * to `/api/cascade/confirm` looks the plan up by sessionId and runs it.
 *
 * Properties:
 *  - In-memory only — never persisted. A client refresh effectively
 *    cancels the preview. This is intentional per the M12 plan: there
 *    is no persisted "pending change" state to clean up.
 *  - 5-minute TTL — stale entries are evicted on read.
 *  - Per-session — only one pending preview per session. A new
 *    classification clobbers the prior pending preview.
 *  - Single-process — the dev server is single-process; production
 *    Next.js serverless containers each carry their own map. A confirm
 *    routed to a different container would 404, which is acceptable
 *    given the 5min TTL window.
 */

import type { CascadePreview } from "@/lib/pipeline";

export interface PendingPreview {
  preview: CascadePreview;
  description: string;
  expiresAt: number;
}

const TTL_MS = 5 * 60 * 1000;
const store = new Map<string, PendingPreview>();

export function setPendingPreview(
  sessionId: string,
  preview: CascadePreview,
  description: string
): void {
  store.set(sessionId, {
    preview,
    description,
    expiresAt: Date.now() + TTL_MS,
  });
}

export function getPendingPreview(sessionId: string): PendingPreview | null {
  const entry = store.get(sessionId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(sessionId);
    return null;
  }
  return entry;
}

export function clearPendingPreview(sessionId: string): void {
  store.delete(sessionId);
}

/** Test helper — drains all pending entries. Not exported via index.ts. */
export function _resetPreviewStore(): void {
  store.clear();
}
