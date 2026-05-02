"use client";

import {
  PRD_PIPELINE,
  PRD_STEP_IDS,
} from "@/lib/pipeline/configs/prd-builder";
import type { SessionLifecycle } from "@/lib/pipeline/state";
import type { StreamEvent } from "@/lib/streaming";
import { useChatStore } from "@/stores/chat";
import { useDocumentStore } from "@/stores/document";
import { useSessionStore } from "@/stores/session";

/** Step id -> the slot id that step's review tab should display.
 *  Used to keep the active document tab in sync with the lifecycle so
 *  the user is always looking at the artifact relevant to their current
 *  approve gate (especially after a restore-from-suspended, where every
 *  slot's `setSlot` would otherwise leave the tab pinned to whichever
 *  slot was set last). */
const STEP_TAB_SLOT: Record<string, string> = Object.fromEntries(
  PRD_PIPELINE.steps.map((s) => [String(s.id), String(s.produces[0])] as const)
);

/** Switch the active tab to match the lifecycle state, when the tab's
 *  slot is finalized on the client. No-op if the slot isn't ready or
 *  the lifecycle doesn't map to a tab (phase1 / phase1_complete / running). */
function syncActiveTabToState(state: SessionLifecycle): void {
  let slotId: string | undefined;
  if (state.kind === "review") {
    slotId = STEP_TAB_SLOT[String(state.stepId)];
  } else if (state.kind === "complete") {
    // At complete, show the final artifact.
    slotId = STEP_TAB_SLOT[String(PRD_STEP_IDS.wireframeHtml)];
  }
  if (!slotId) return;
  const doc = useDocumentStore.getState();
  if (doc.slots[slotId]?.finalized) {
    doc.setActiveTab(slotId);
  }
}

interface SendMessageInput {
  message: string;
  sessionId?: string;
}

export async function sendChatMessage(input: SendMessageInput): Promise<void> {
  const chat = useChatStore.getState();
  const doc = useDocumentStore.getState();
  const session = useSessionStore.getState();

  if (!input.sessionId) {
    chat.reset();
    doc.reset();
  }
  // Each new message clears any previous drift / preview state — the
  // user's about to issue something new, the prior banner is no longer
  // the latest signal.
  session.setDrift(null);
  session.setPendingPreview(null);
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

export async function validatePhase1(sessionId: string): Promise<void> {
  const chat = useChatStore.getState();
  useSessionStore.getState().setDrift(null);
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

export async function approve(sessionId: string): Promise<void> {
  const chat = useChatStore.getState();
  useSessionStore.getState().setDrift(null);
  chat.setStreaming(true);
  try {
    const response = await fetch("/api/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Approve failed (${response.status}): ${detail.slice(0, 200)}`);
    }
    await consumeSSE(response.body, dispatch);
  } finally {
    useChatStore.getState().setStreaming(false);
  }
}

export async function confirmCascade(sessionId: string): Promise<void> {
  const chat = useChatStore.getState();
  // Drop the pending preview banner immediately — the server is about to
  // start streaming progress events, and the banner is no longer the
  // active "what should I do next" prompt.
  useSessionStore.getState().setPendingPreview(null);
  chat.setStreaming(true);
  try {
    const response = await fetch("/api/cascade/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, action: "confirm" }),
    });
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Confirm failed (${response.status}): ${detail.slice(0, 200)}`
      );
    }
    await consumeSSE(response.body, dispatch);
  } finally {
    useChatStore.getState().setStreaming(false);
  }
}

export async function cancelCascade(sessionId: string): Promise<void> {
  // Server side is fire-and-forget (204). Drop the local banner first so
  // the UI feels instant; if the network call fails the worst case is
  // the server keeps the plan in-memory until its TTL.
  useSessionStore.getState().setPendingPreview(null);
  await fetch("/api/cascade/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, action: "cancel" }),
  });
}

export async function rollbackToPhase1(sessionId: string): Promise<void> {
  const chat = useChatStore.getState();
  chat.setStreaming(true);
  try {
    const response = await fetch("/api/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Rollback failed (${response.status}): ${detail.slice(0, 200)}`
      );
    }
    await consumeSSE(response.body, dispatch);
    // After rollback, the doc panel should clear non-anchor slots locally
    // (the server already emitted slot_cleared events for each, but reset
    // is cheaper than tracking in-flight). Then re-fetch the contract.
    const sessId = useSessionStore.getState().current?.id;
    useDocumentStore.getState().reset();
    if (sessId) await loadSession(sessId);
    useSessionStore.getState().setDrift(null);
    useSessionStore.getState().setPendingPreview(null);
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
        state: event.state,
        pipelineVersion: event.pipelineVersion,
      });
      session.upsert({
        id: event.sessionId,
        title: event.title,
        state: event.state,
        updatedAt: new Date().toISOString(),
      });
      syncActiveTabToState(event.state);
      return;
    case "chunk":
      chat.appendChunk(event.text);
      return;
    case "assistant_message":
      chat.setPendingAssistant(event.content);
      return;
    case "slot_delta":
      doc.appendDelta(event.slotId, event.text);
      return;
    case "slot":
      doc.setSlot(event.slotId, event.payload);
      return;
    case "slot_cleared":
      doc.clearSlot(event.slotId);
      return;
    case "progress":
      if (event.status === "completed" && event.note) {
        chat.appendSystem(event.note);
      } else if (event.status === "failed" && event.note) {
        chat.appendSystem(`${event.op} failed: ${event.note}`);
      }
      return;
    case "state":
      if (session.current) {
        session.setCurrent({
          ...session.current,
          state: event.state,
        });
        session.upsert({
          id: session.current.id,
          title: session.current.title,
          state: event.state,
          updatedAt: new Date().toISOString(),
        });
      }
      // Each lifecycle transition repoints the visible tab to the
      // step's produced slot. Without this, restore-from-suspended
      // leaves the tab on the last setSlot target (typically
      // wireframeFiles), making it look like the user fast-forwarded
      // when really the lifecycle is at review:workflow.
      syncActiveTabToState(event.state);
      return;
    case "validation_result": {
      const text = formatValidationResult(event);
      chat.appendSystem(text);
      return;
    }
    case "drift":
      session.setDrift({
        classification: event.classification,
        driftType: event.driftType,
        reason: event.reason,
        scope: event.scope,
      });
      return;
    case "cascade_preview":
      session.setPendingPreview({
        description: event.description,
        preview: event.preview,
      });
      return;
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
    state: s.state,
    pipelineVersion: s.pipelineVersion ?? 1,
  });
  useSessionStore.getState().setDrift(null);
  useSessionStore.getState().setPendingPreview(null);
  useChatStore.getState().setMessages(s.chat);

  const doc = useDocumentStore.getState();
  doc.reset();
  for (const [slotId, payload] of Object.entries(s.slots)) {
    doc.setSlot(slotId, payload);
  }
  // Tab follows lifecycle on session load: pick the slot relevant to
  // the current state (review:X -> X's slot, complete -> wireframe).
  // Falls back to the drift anchor for phase1 / phase1_complete /
  // running states where there's no obvious "current" tab.
  syncActiveTabToState(s.state);
  if (
    s.state.kind === "phase1" ||
    s.state.kind === "phase1_complete" ||
    s.state.kind === "running"
  ) {
    const anchor = Object.keys(s.slots)[0];
    if (anchor) doc.setActiveTab(anchor);
  }
}
