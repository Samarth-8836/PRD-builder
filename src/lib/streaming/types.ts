import type { CascadePreview } from "@/lib/pipeline";
import type { SessionLifecycle } from "@/lib/pipeline/state";
import type { SlotPayload } from "@/lib/pipeline/types";

/**
 * SSE wire protocol — slot-keyed (M11). The legacy `document`/
 * `document_delta`/`wireframe_ready`/`wireframe_cleared`/`phase` events
 * are gone. Three slot events handle every artifact type, and a single
 * `state` event carries the SessionLifecycle.
 */
export type StreamEvent =
  | {
      type: "meta";
      sessionId: string;
      title: string;
      state: SessionLifecycle;
      pipelineVersion: number;
      pipelineId: string;
    }
  /** Streamed token of the in-progress assistant chat message. Additive. */
  | { type: "chunk"; text: string }
  /** Canonical assistant chat message — replaces whatever chunks were
   *  streamed (used to recover from a corrective-retry that produced
   *  different output than was streamed on attempt 1). */
  | { type: "assistant_message"; content: string }
  /** Incremental token of a streaming markdown slot (e.g. the contract).
   *  Only emitted for slots whose runner sets `stream: true`. */
  | { type: "slot_delta"; slotId: string; text: string }
  /** Canonical slot payload — overwrites any partial deltas streamed. */
  | { type: "slot"; slotId: string; payload: SlotPayload }
  /** Slot was discarded (e.g. cascade rewound past it). */
  | { type: "slot_cleared"; slotId: string }
  /** Lifecycle state changed (replaces the old `phase` event). */
  | { type: "state"; state: SessionLifecycle }
  | {
      type: "progress";
      op: string;
      status: "started" | "completed" | "failed";
      note?: string;
    }
  | {
      type: "validation_result";
      status: "PASS" | "FAIL";
      issues: string[];
      suggestions: string[];
    }
  | {
      type: "drift";
      classification: "COMPATIBLE" | "FLAG" | "DRIFT";
      driftType?: string;
      reason: string;
      scope?: string;
    }
  /** A change request has been classified COMPATIBLE and a cascade
   *  preview is ready. The client renders a banner with Confirm/Cancel.
   *  Confirm POSTs to /api/cascade/confirm to actually run the cascade.
   *  Cancel drops the pending preview server-side. The pending preview
   *  is in-memory only and expires after 5 minutes.
   *
   *  `summary` is the past-tense one-liner from the classifier ("Added
   *  X"). It is NOT persisted to chat at preview time — chat appends
   *  only after Confirm so cancelled / drift-rejected attempts leave
   *  no false-positive chat record. */
  | {
      type: "cascade_preview";
      description: string;
      summary: string;
      preview: CascadePreview;
    }
  | { type: "error"; message: string; code?: string }
  | { type: "complete" };

export type StreamEventType = StreamEvent["type"];
