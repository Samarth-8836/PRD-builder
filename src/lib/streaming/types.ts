import type { Phase } from "@/lib/storage";

/** Markdown-bodied documents that flow through document/document_delta events. */
export type MarkdownDocumentName =
  | "projectContract"
  | "workflowMap"
  | "screenInventory";

/** All document tabs in the UI. Wireframe has no markdown body — it has
 *  its own ready event and is rendered as an iframe instead. */
export type DocumentName = MarkdownDocumentName | "wireframe";

export type StreamEvent =
  | { type: "meta"; sessionId: string; title: string; phase: Phase }
  /** Streamed token of the in-progress assistant chat message. Additive. */
  | { type: "chunk"; text: string }
  /** Canonical assistant chat message — replaces whatever chunks were
   *  streamed (used to recover from a corrective-retry that produced
   *  different output than was streamed on attempt 1). */
  | { type: "assistant_message"; content: string }
  | { type: "document_delta"; name: MarkdownDocumentName; text: string }
  | {
      type: "document";
      name: MarkdownDocumentName;
      version: number;
      content: string;
    }
  /** Wireframe finished generating. The viewer should reload the iframe
   *  to pick up the new version. */
  | { type: "wireframe_ready"; version: number; files: string[] }
  | { type: "phase"; phase: Phase }
  | { type: "progress"; op: string; status: "started" | "completed" | "failed"; note?: string }
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
  | { type: "error"; message: string; code?: string }
  | { type: "complete" };

export type StreamEventType = StreamEvent["type"];
