import { randomUUID } from "node:crypto";
import { runConversation, runFirstMessage, runTitle } from "@/lib/operations";
import { type SSEWriter } from "@/lib/streaming";
import {
  getStorage,
  type IStorage,
  type Session,
  type SessionSummary,
} from "@/lib/storage";

export class SessionBusyError extends Error {
  readonly code = "SESSION_BUSY";
  constructor(public sessionId: string) {
    super(`Session ${sessionId} is busy`);
  }
}

export class NoContractError extends Error {
  readonly code = "NO_CONTRACT";
  constructor(public sessionId: string) {
    super(`Session ${sessionId} has no Project Contract yet`);
  }
}

interface StartSessionInput {
  firstMessage: string;
  sse: SSEWriter;
  signal?: AbortSignal;
}

interface HandleMessageInput {
  sessionId: string;
  message: string;
  sse: SSEWriter;
  signal?: AbortSignal;
}

/**
 * Top-level coordinator. As of M2 it owns two paths:
 *
 *   - startSession: first-message draft (Phase 1 initial creation)
 *   - handleMessage: follow-up conversation in Phase 1 (questions + edits)
 *
 * Phase 2 stage runners and rollback paths arrive in later milestones.
 *
 * The per-session in-memory busy lock rejects overlapping operations on
 * the same session rather than queuing them, matching the spec's
 * "chat lock" semantics.
 */
export class SessionManager {
  private readonly busy = new Set<string>();

  constructor(private readonly storage: IStorage = getStorage()) {}

  async startSession(input: StartSessionInput): Promise<void> {
    const { firstMessage, sse, signal } = input;
    const trimmed = firstMessage.trim();
    if (!trimmed) {
      sse.error("Message was empty", "EMPTY_MESSAGE");
      return;
    }

    const id = randomUUID();
    const session = await this.storage.createSession({ id, title: "Untitled" });

    await this.storage.appendChat(id, {
      role: "user",
      content: trimmed,
      ts: new Date().toISOString(),
    });

    sse.send({
      type: "meta",
      sessionId: session.id,
      title: session.title,
      phase: session.phase,
    });

    this.busy.add(id);
    try {
      const titleTask = runTitle(trimmed, session, signal)
        .then(async (title) => {
          if (sse.isClosed()) return;
          const updated = await this.storage.setTitle(id, title);
          sse.send({
            type: "meta",
            sessionId: id,
            title: updated.title,
            phase: updated.phase,
          });
        })
        .catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.warn("title generation failed:", err);
        });

      const result = await runFirstMessage({
        session,
        userInput: trimmed,
        sse,
        signal,
      });

      await this.storage.appendChat(id, {
        role: "assistant",
        content: result.summary,
        ts: new Date().toISOString(),
      });

      await titleTask;
    } finally {
      this.busy.delete(id);
    }
  }

  async handleMessage(input: HandleMessageInput): Promise<void> {
    const { sessionId, message, sse, signal } = input;
    const trimmed = message.trim();
    if (!trimmed) {
      sse.error("Message was empty", "EMPTY_MESSAGE");
      return;
    }

    if (this.busy.has(sessionId)) {
      throw new SessionBusyError(sessionId);
    }

    this.busy.add(sessionId);
    try {
      const session = await this.storage.getSession(sessionId);
      if (!session) {
        sse.error(`Session ${sessionId} not found`, "NOT_FOUND");
        return;
      }
      if (!session.documents.projectContract) {
        throw new NoContractError(sessionId);
      }

      // Append the user message to chat BEFORE the LLM call so it's
      // persisted regardless of how the operation completes.
      await this.storage.appendChat(sessionId, {
        role: "user",
        content: trimmed,
        ts: new Date().toISOString(),
      });

      const refreshed = (await this.storage.getSession(sessionId))!;

      sse.send({
        type: "meta",
        sessionId: refreshed.id,
        title: refreshed.title,
        phase: refreshed.phase,
      });

      const result = await runConversation({
        session: refreshed,
        userMessage: trimmed,
        sse,
        signal,
      });

      await this.storage.appendChat(sessionId, {
        role: "assistant",
        content: result.assistantMessage,
        ts: new Date().toISOString(),
      });
    } finally {
      this.busy.delete(sessionId);
    }
  }

  async listSessions(): Promise<SessionSummary[]> {
    return this.storage.listSessions();
  }

  async getSession(id: string): Promise<Session | null> {
    return this.storage.getSession(id);
  }
}

let cached: SessionManager | null = null;

export function getSessionManager(): SessionManager {
  if (!cached) cached = new SessionManager();
  return cached;
}
