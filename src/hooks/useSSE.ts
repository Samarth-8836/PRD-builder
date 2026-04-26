"use client";

import type { DocumentName, StreamEvent } from "@/lib/streaming";
import { useChatStore } from "@/stores/chat";
import { useDocumentStore } from "@/stores/document";
import { useSessionStore } from "@/stores/session";

interface SendMessageInput {
  message: string;
  sessionId?: string;
}

/**
 * Posts a chat message to /api/chat and streams the SSE response,
 * dispatching each typed event to the right Zustand store.
 *
 * Returns when the server closes the stream (`complete` event or stream
 * end). Throws on transport errors. Per-event errors arrive as `error`
 * events and are surfaced as system chat messages — they don't reject.
 */
export async function sendChatMessage(input: SendMessageInput): Promise<void> {
  const chat = useChatStore.getState();
  const doc = useDocumentStore.getState();

  if (!input.sessionId) {
    chat.reset();
    doc.reset();
  }
  chat.appendUser(input.message);
  chat.setPendingAssistant("");
  chat.setStreaming(true);

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: input.message, sessionId: input.sessionId }),
    });

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Chat request failed (${response.status}): ${detail.slice(0, 200)}`);
    }

    await consumeSSE(response.body, dispatch);
  } finally {
    useChatStore.getState().finalizePending();
    useChatStore.getState().setStreaming(false);
  }
}

/**
 * Posts to /api/phase/complete and consumes the SSE stream of validation
 * events (and on PASS, the auto-triggered Phase 2 design stage events).
 */
export async function validatePhase1(sessionId: string): Promise<void> {
  const chat = useChatStore.getState();
  chat.setStreaming(true);

  try {
    const response = await fetch("/api/phase/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Validate request failed (${response.status}): ${detail.slice(0, 200)}`
      );
    }
    await consumeSSE(response.body, dispatch);
  } finally {
    useChatStore.getState().setStreaming(false);
  }
}

async function consumeSSE(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: StreamEvent) => void
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sepIdx: number;
      while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + 2);

        const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        const payload = dataLine.slice("data:".length).trim();
        if (!payload) continue;

        let parsed: StreamEvent;
        try {
          parsed = JSON.parse(payload) as StreamEvent;
        } catch {
          continue;
        }
        onEvent(parsed);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function dispatch(event: StreamEvent): void {
  const session = useSessionStore.getState();
  const chat = useChatStore.getState();
  const doc = useDocumentStore.getState();

  switch (event.type) {
    case "meta":
      session.setCurrent({
        id: event.sessionId,
        title: event.title,
        phase: event.phase,
      });
      session.upsert({
        id: event.sessionId,
        title: event.title,
        phase: event.phase,
        updatedAt: new Date().toISOString(),
      });
      return;
    case "chunk":
      chat.appendChunk(event.text);
      return;
    case "assistant_message":
      chat.setPendingAssistant(event.content);
      return;
    case "document_delta":
      doc.appendDelta(event.name as DocumentName, event.text);
      return;
    case "document":
      doc.setDocument(event.name as DocumentName, event.content, event.version);
      return;
    case "progress":
      // Surface "completed" milestones as system chat messages so the
      // user sees stage progress. "started" notes are silent — too
      // noisy to render every sub-step kickoff.
      if (event.status === "completed" && event.note) {
        chat.appendSystem(event.note);
      }
      return;
    case "phase":
      if (session.current) {
        session.setCurrent({ ...session.current, phase: event.phase });
        session.upsert({
          id: session.current.id,
          title: session.current.title,
          phase: event.phase,
          updatedAt: new Date().toISOString(),
        });
      }
      return;
    case "validation_result": {
      const text = formatValidationResult(event);
      chat.appendSystem(text);
      return;
    }
    case "error":
      chat.appendSystem(`Error: ${event.message}`);
      return;
    case "complete":
      chat.setStreaming(false);
      return;
  }
}

function formatValidationResult(event: {
  status: "PASS" | "FAIL";
  issues: string[];
  suggestions: string[];
}): string {
  if (event.status === "PASS") {
    return "Phase 1 validated. Starting Phase 2 design...";
  }
  const lines = ["Phase 1 validation failed.", "", "Issues:"];
  for (const issue of event.issues) lines.push(`- ${issue}`);
  lines.push("", "Suggestions:");
  for (const s of event.suggestions) lines.push(`- ${s}`);
  return lines.join("\n");
}

export async function refreshSessionList(): Promise<void> {
  const res = await fetch("/api/sessions");
  if (!res.ok) return;
  const data = (await res.json()) as { sessions: import("@/lib/storage").SessionSummary[] };
  useSessionStore.getState().setList(data.sessions);
}

export async function loadSession(id: string): Promise<void> {
  const res = await fetch(`/api/sessions/${id}`);
  if (!res.ok) return;
  const data = (await res.json()) as { session: import("@/lib/storage").Session };
  const s = data.session;

  useSessionStore.getState().setCurrent({
    id: s.id,
    title: s.title,
    phase: s.phase,
  });
  useChatStore.getState().setMessages(s.chat);

  const doc = useDocumentStore.getState();
  doc.reset();
  if (s.documents.projectContract) {
    doc.setDocument(
      "projectContract",
      s.documents.projectContract.content,
      s.documents.projectContract.version
    );
  }
  if (s.documents.workflowMap) {
    doc.setDocument(
      "workflowMap",
      s.documents.workflowMap.content,
      s.documents.workflowMap.version
    );
  }
  if (s.documents.screenInventory) {
    doc.setDocument(
      "screenInventory",
      s.documents.screenInventory.content,
      s.documents.screenInventory.version
    );
  }
  // Reset to the contract tab so the user lands somewhere familiar.
  doc.setActiveTab("projectContract");
}
