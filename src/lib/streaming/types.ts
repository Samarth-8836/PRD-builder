import type { Phase } from "@/lib/storage";

export type DocumentName = "projectContract" | "workflowMap" | "screenInventory";

export type StreamEvent =
  | { type: "meta"; sessionId: string; title: string; phase: Phase }
  | { type: "chunk"; text: string }
  | { type: "document_delta"; name: DocumentName; text: string }
  | {
      type: "document";
      name: DocumentName;
      version: number;
      content: string;
    }
  | { type: "phase"; phase: Phase }
  | { type: "progress"; op: string; status: "started" | "completed" | "failed"; note?: string }
  | { type: "error"; message: string; code?: string }
  | { type: "complete" };

export type StreamEventType = StreamEvent["type"];
