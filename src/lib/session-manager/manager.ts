import { randomUUID } from "node:crypto";
import { runFirstMessage, runTitle } from "@/lib/operations";
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

export class NotImplementedInM1Error extends Error {
  readonly code = "NOT_IMPLEMENTED";
  constructor(message: string) {
    super(message);
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
 * Top-level coordinator. For M1 it owns one path: starting a new session
 * from a first-message and producing a Project Contract. Follow-up messages
 * (edits, questions) and Phase 2 stage runners arrive in later milestones.
 *
 * The per-session in-memory lock rejects overlapping operations on the same
 * session rather than queuing them — matches the spec's "chat lock" idea.
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
      const titleTask = runTitle(trimmed, signal)
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
          // Title generation failure is non-fatal; the session keeps "Untitled".
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
    const { sessionId, sse } = input;
    if (this.busy.has(sessionId)) {
      throw new SessionBusyError(sessionId);
    }
    const session = await this.storage.getSession(sessionId);
    if (!session) {
      sse.error(`Session ${sessionId} not found`, "NOT_FOUND");
      return;
    }
    throw new NotImplementedInM1Error(
      "Follow-up messages (edits, questions) arrive in M2. For now, start a new session by sending a message without a sessionId."
    );
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
