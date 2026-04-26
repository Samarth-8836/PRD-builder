import { randomUUID } from "node:crypto";
import {
  NoContractToValidateError,
  runConversation,
  runFirstMessage,
  runTitle,
  runValidate,
} from "@/lib/operations";
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

interface CompletePhase1Input {
  sessionId: string;
  sse: SSEWriter;
  signal?: AbortSignal;
}

/**
 * Top-level coordinator. As of M3 it owns three paths:
 *
 *   - startSession: first-message draft (Phase 1 initial creation)
 *   - handleMessage: follow-up conversation in Phase 1 (questions + edits).
 *     If the session was in phase1_complete and the user produces an edit,
 *     phase is reset back to phase1 (the prior validation no longer holds).
 *   - completePhase1: validates the contract and transitions to
 *     phase1_complete on PASS.
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

      // If this edit mutated a previously-validated contract, the prior
      // validation no longer holds — reset phase to phase1 so the user
      // re-runs Done. Question mode does not change the contract, so it
      // doesn't reset.
      if (result.mode === "edit" && refreshed.phase === "phase1_complete") {
        const reset = await this.storage.setPhase(sessionId, "phase1");
        await this.storage.setContractSnapshot(sessionId, null);
        sse.send({ type: "phase", phase: reset.phase });
      }
    } finally {
      this.busy.delete(sessionId);
    }
  }

  async completePhase1(input: CompletePhase1Input): Promise<void> {
    const { sessionId, sse, signal } = input;

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

      sse.send({
        type: "meta",
        sessionId: session.id,
        title: session.title,
        phase: session.phase,
      });

      try {
        await runValidate({ session, sse, signal });
      } catch (err: unknown) {
        if (err instanceof NoContractToValidateError) {
          throw new NoContractError(sessionId);
        }
        throw err;
      }
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
