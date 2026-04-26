"use client";

import type { StreamEvent } from "@/lib/streaming";
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
      if (event.name === "projectContract") doc.appendDelta(event.text);
      return;
    case "document":
      if (event.name === "projectContract")
        doc.setDocument(event.content, event.version);
      return;
    case "progress":
      // No UI for progress in M2 — could surface a subtle indicator later.
      return;
    case "phase":
      if (session.current) {
        session.setCurrent({ ...session.current, phase: event.phase });
      }
      return;
    case "error":
      chat.appendSystem(`Error: ${event.message}`);
      return;
    case "complete":
      chat.setStreaming(false);
      return;
  }
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
  const contract = s.documents.projectContract;
  if (contract) {
    useDocumentStore
      .getState()
      .setDocument(contract.content, contract.version);
  } else {
    useDocumentStore.getState().reset();
  }
}
