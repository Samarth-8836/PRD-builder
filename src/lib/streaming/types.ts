import type { Phase } from "@/lib/storage";

export type DocumentName = "projectContract" | "workflowMap" | "screenInventory";

export type StreamEvent =
  | { type: "meta"; sessionId: string; title: string; phase: Phase }
  /** Streamed token of the in-progress assistant chat message. Additive. */
  | { type: "chunk"; text: string }
  /** Canonical assistant chat message — replaces whatever chunks were
   *  streamed (used to recover from a corrective-retry that produced
   *  different output than was streamed on attempt 1). */
  | { type: "assistant_message"; content: string }
  | { type: "document_delta"; name: DocumentName; text: string }
  | {
      type: "document";
      name: DocumentName;
      version: number;
      content: string;
    }
  | { type: "phase"; phase: Phase }
  | { type: "progress"; op: string; status: "started" | "completed" | "failed"; note?: string }
  | {
      type: "validation_result";
      status: "PASS" | "FAIL";
      issues: string[];
      suggestions: string[];
    }
  | { type: "error"; message: string; code?: string }
  | { type: "complete" };

export type StreamEventType = StreamEvent["type"];
