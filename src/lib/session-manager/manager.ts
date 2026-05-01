import { randomUUID } from "node:crypto";
import {
  NoContractToValidateError,
  runConversation,
  runDriftCheck,
  runFirstMessage,
  runPhase2Conversation,
  runTitle,
  runValidate,
} from "@/lib/operations";
import { type SSEWriter } from "@/lib/streaming";
import {
  getStorage,
  type IStorage,
  type Phase2Snapshot,
  type Session,
  type SessionSummary,
} from "@/lib/storage";
import { runPhase2Cascade } from "./phase2-cascade";
import { runScreenStage } from "./screen-stage";
import { runWireframeStage } from "./wireframe-stage";
import { runWorkflowStage } from "./workflow-stage";

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

export class WrongPhaseError extends Error {
  readonly code = "WRONG_PHASE";
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

interface CompletePhase1Input {
  sessionId: string;
  sse: SSEWriter;
  signal?: AbortSignal;
}

interface RollbackInput {
  sessionId: string;
  sse: SSEWriter;
  signal?: AbortSignal;
}

interface ApproveInput {
  sessionId: string;
  sse: SSEWriter;
  signal?: AbortSignal;
}

/**
 * Top-level coordinator. Routes by phase:
 *
 *   - phase1 / phase1_complete:   Phase 1 conversation (questions + edits)
 *   - phase2_workflow_review |
 *     phase2_screen_review |
 *     phase2_wireframe_review:    Phase 2 review chat (questions, COMPATIBLE
 *                                 cascades, drift detection)
 *   - phase2_*_running:           rejected — stage is mid-flight
 *
 * Plus startSession (Phase 1 first-message), completePhase1 (validate +
 * auto-advance to workflow stage), approve (advance through Phase 2
 * sub-stages), and rollbackToPhase1 (snapshot Phase 2 state and return).
 */
export class SessionManager {
  private readonly busy = new Set<string>();

  constructor(private readonly storage: IStorage = getStorage()) {}

  // ---------------------------------------------------------------------
  // Phase 1: starting a session
  // ---------------------------------------------------------------------
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

  // ---------------------------------------------------------------------
  // Phase-aware chat router
  // ---------------------------------------------------------------------
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

      // Append the user message FIRST so it's persisted no matter what.
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

      switch (refreshed.phase) {
        case "phase1":
        case "phase1_complete":
          await this.handlePhase1Chat(refreshed, trimmed, sse, signal);
          return;
        case "phase2_workflow_review":
        case "phase2_screen_review":
        case "phase2_wireframe_review":
          await this.handlePhase2ReviewChat(refreshed, trimmed, sse, signal);
          return;
        case "phase2_workflow_running":
        case "phase2_screen_running":
        case "phase2_wireframe_running":
          throw new SessionBusyError(sessionId);
        case "complete":
          throw new WrongPhaseError(
            "Session is already marked complete; roll back to Phase 1 to revise."
          );
      }
    } finally {
      this.busy.delete(sessionId);
    }
  }

  private async handlePhase1Chat(
    session: Session,
    message: string,
    sse: SSEWriter,
    signal?: AbortSignal
  ): Promise<void> {
    const result = await runConversation({
      session,
      userMessage: message,
      sse,
      signal,
    });

    await this.storage.appendChat(session.id, {
      role: "assistant",
      content: result.assistantMessage,
      ts: new Date().toISOString(),
    });

    // If the contract was edited while the session sat in phase1_complete,
    // the prior validation no longer holds. Reset to phase1.
    if (result.mode === "edit" && session.phase === "phase1_complete") {
      const reset = await this.storage.setPhase(session.id, "phase1");
      await this.storage.setContractSnapshot(session.id, null);
      sse.send({ type: "phase", phase: reset.phase });
    }
  }

  /**
   * Handles a chat message during a review-style state. Today this is
   * called from any phase2_*_review state. M12 wires iteration-on-
   * complete so this same handler runs from `complete` too — the
   * structure (classify → drift-check → dispatch by first-impact step)
   * is identical; only the rollback/finalization semantics differ.
   * Drift check + cascade dispatch are generalized: they only depend on
   * the current contract content and the first-impact step id, not on
   * the specific phase.
   */
  private async handlePhase2ReviewChat(
    session: Session,
    message: string,
    sse: SSEWriter,
    signal?: AbortSignal
  ): Promise<void> {
    const conv = await runPhase2Conversation({
      session,
      userMessage: message,
      signal,
    });

    if (conv.mode === "question") {
      sse.send({ type: "assistant_message", content: conv.answer });
      await this.storage.appendChat(session.id, {
        role: "assistant",
        content: conv.answer,
        ts: new Date().toISOString(),
      });
      return;
    }

    // change mode — emit summary, run drift check, then either cascade or block.
    sse.send({ type: "assistant_message", content: conv.summary });
    await this.storage.appendChat(session.id, {
      role: "assistant",
      content: conv.summary,
      ts: new Date().toISOString(),
    });

    const drift = await runDriftCheck({
      contract: session.documents.projectContract!.content,
      changeDescription: conv.description,
      signal,
    });

    sse.send({
      type: "drift",
      classification: drift.classification,
      driftType: drift.type,
      reason: drift.reason,
      scope: conv.firstImpactStepId,
    });

    if (drift.classification === "DRIFT") {
      // Block. The frontend renders a red banner and locks the chat
      // until rollback. No doc changes here.
      return;
    }

    if (drift.classification === "FLAG") {
      // Borderline. Surface but do not cascade. The frontend renders a
      // yellow banner; the user can choose to roll back to Phase 1 or
      // re-send the request with a clearer scope.
      return;
    }

    // COMPATIBLE — dispatch the cascade by first-impact step.
    await runPhase2Cascade({
      session,
      sse,
      signal,
      firstImpactStepId: conv.firstImpactStepId,
      firstImpactItemId: conv.firstImpactItemId,
      description: conv.description,
      phase: session.phase,
    });
  }

  // ---------------------------------------------------------------------
  // Phase 1 -> Phase 2 gate (validate + auto-design)
  // ---------------------------------------------------------------------
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

      let validateResult;
      try {
        validateResult = await runValidate({ session, sse, signal });
      } catch (err: unknown) {
        if (err instanceof NoContractToValidateError) {
          throw new NoContractError(sessionId);
        }
        throw err;
      }
      if (validateResult.status !== "PASS") return;

      const refreshed = (await this.storage.getSession(sessionId))!;

      // Restore-from-snapshot: if the user previously rolled back from
      // Phase 2 review and the post-rollback contract is byte-identical
      // to the pre-rollback contract, the saved Phase 2 work is still
      // valid. Restore it instead of regenerating.
      const snapshot = refreshed.phase2Snapshot;
      if (snapshot && contractsMatch(refreshed, snapshot)) {
        await this.restorePhase2(refreshed, snapshot, sse);
        return;
      }
      // Different contract -> clear any stale snapshot before regen.
      if (snapshot) {
        await this.storage.setPhase2Snapshot(sessionId, null);
      }
      await runWorkflowStage({ session: refreshed, sse, signal });
    } finally {
      this.busy.delete(sessionId);
    }
  }

  private async restorePhase2(
    session: Session,
    snapshot: Phase2Snapshot,
    sse: SSEWriter
  ): Promise<void> {
    if (snapshot.workflowMap) {
      const updated = await this.storage.setDocument(
        session.id,
        "workflowMap",
        snapshot.workflowMap.content
      );
      sse.send({
        type: "document",
        name: "workflowMap",
        version: updated.documents.workflowMap!.version,
        content: snapshot.workflowMap.content,
      });
    }
    if (snapshot.screenInventory) {
      const updated = await this.storage.setDocument(
        session.id,
        "screenInventory",
        snapshot.screenInventory.content
      );
      sse.send({
        type: "document",
        name: "screenInventory",
        version: updated.documents.screenInventory!.version,
        content: snapshot.screenInventory.content,
      });
    }
    if (snapshot.wireframe) {
      const updated = await this.storage.setWireframe(
        session.id,
        snapshot.wireframe.files
      );
      sse.send({
        type: "wireframe_ready",
        version: updated.wireframe!.version,
        files: Object.keys(snapshot.wireframe.files),
      });
    }
    await this.storage.setPhase2Snapshot(session.id, null);
    // Always land at workflow_review (the first review state) regardless
    // of which review state the snapshot was taken from. The user walks
    // through one gate at a time; approve() skips stages whose outputs
    // are already populated, so it's still cheap (no LLM calls) when the
    // user just wants to traverse to a downstream review state.
    const final = await this.storage.setPhase(
      session.id,
      "phase2_workflow_review"
    );
    sse.send({ type: "phase", phase: final.phase });
    sse.send({
      type: "progress",
      op: "phase2.restore",
      status: "completed",
      note:
        "Restored your previous Phase 2 work — the contract is unchanged. " +
        "Step through Approve to revisit each stage; make a change at any " +
        "review to override what's restored.",
    });
  }

  // ---------------------------------------------------------------------
  // Phase 2 approve — dispatches by current phase
  // ---------------------------------------------------------------------
  async approve(input: ApproveInput): Promise<void> {
    const { sessionId, sse, signal } = input;
    if (this.busy.has(sessionId)) throw new SessionBusyError(sessionId);

    this.busy.add(sessionId);
    try {
      const session = await this.storage.getSession(sessionId);
      if (!session) {
        sse.error(`Session ${sessionId} not found`, "NOT_FOUND");
        return;
      }

      sse.send({
        type: "meta",
        sessionId: session.id,
        title: session.title,
        phase: session.phase,
      });

      if (session.phase === "phase2_workflow_review") {
        if (
          !session.documents.workflowMap ||
          !session.documents.projectContract
        ) {
          throw new WrongPhaseError(
            "Cannot approve — Workflow Map is missing"
          );
        }
        // Skip the LLM call when the next stage's output is already
        // populated (typically post-restore). The user can still trigger
        // regeneration by making a change at this review state.
        if (session.documents.screenInventory) {
          const updated = await this.storage.setPhase(
            sessionId,
            "phase2_screen_review"
          );
          sse.send({ type: "phase", phase: updated.phase });
          sse.send({
            type: "progress",
            op: "phase2.skip",
            status: "completed",
            note:
              "Screen Inventory already exists from restore — review it, then approve again to continue.",
          });
          return;
        }
        await runScreenStage({ session, sse, signal });
        return;
      }

      if (session.phase === "phase2_screen_review") {
        if (
          !session.documents.workflowMap ||
          !session.documents.screenInventory ||
          !session.documents.projectContract
        ) {
          throw new WrongPhaseError(
            "Cannot approve — Phase 2 documents are missing"
          );
        }
        if (session.wireframe) {
          const updated = await this.storage.setPhase(
            sessionId,
            "phase2_wireframe_review"
          );
          sse.send({ type: "phase", phase: updated.phase });
          sse.send({
            type: "progress",
            op: "phase2.skip",
            status: "completed",
            note:
              "Wireframe already exists from restore — review it, then approve again to mark complete.",
          });
          return;
        }
        await runWireframeStage({ session, sse, signal });
        return;
      }

      if (session.phase === "phase2_wireframe_review") {
        if (!session.wireframe) {
          throw new WrongPhaseError(
            "Cannot approve — wireframe artifact is missing"
          );
        }
        const updated = await this.storage.setPhase(sessionId, "complete");
        sse.send({ type: "phase", phase: updated.phase });
        sse.send({
          type: "progress",
          op: "phase2.complete",
          status: "completed",
          note:
            "All four artifacts are locked in. Click Export to download the bundle.",
        });
        return;
      }

      throw new WrongPhaseError(
        `Cannot approve from ${session.phase}; approval is only available from one of the Phase 2 review states`
      );
    } finally {
      this.busy.delete(sessionId);
    }
  }

  // ---------------------------------------------------------------------
  // Rollback Phase 2 -> Phase 1
  // ---------------------------------------------------------------------
  async rollbackToPhase1(input: RollbackInput): Promise<void> {
    const { sessionId, sse, signal: _signal } = input;
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
      if (
        session.phase !== "phase2_workflow_review" &&
        session.phase !== "phase2_screen_review" &&
        session.phase !== "phase2_wireframe_review"
      ) {
        throw new WrongPhaseError(
          `Cannot roll back from ${session.phase}; rollback is only available from Phase 2 review states`
        );
      }

      const snapshot: Phase2Snapshot = {
        workflowMap: session.documents.workflowMap,
        screenInventory: session.documents.screenInventory,
        wireframe: session.wireframe,
        phase: session.phase,
        contractAtRollback:
          session.documents.projectContract?.content ?? "",
        takenAt: new Date().toISOString(),
      };
      await this.storage.setPhase2Snapshot(sessionId, snapshot);

      // Clear the live Phase 2 docs so the doc panel doesn't show stale
      // content while the user edits the contract.
      if (session.documents.workflowMap) {
        await this.storage.clearDocument(sessionId, "workflowMap");
      }
      if (session.documents.screenInventory) {
        await this.storage.clearDocument(sessionId, "screenInventory");
      }
      if (session.wireframe) {
        await this.storage.clearWireframe(sessionId);
      }

      const updated = await this.storage.setPhase(sessionId, "phase1");
      sse.send({
        type: "meta",
        sessionId: updated.id,
        title: updated.title,
        phase: updated.phase,
      });
      sse.send({ type: "phase", phase: updated.phase });
      sse.send({
        type: "progress",
        op: "phase2.rollback",
        status: "completed",
        note:
          "Rolled back to Phase 1. Edit the contract and click Done to regenerate Phase 2 (or to restore your prior work if the contract is unchanged).",
      });
    } finally {
      this.busy.delete(sessionId);
    }
  }

  // ---------------------------------------------------------------------
  // Read-only helpers
  // ---------------------------------------------------------------------
  async listSessions(): Promise<SessionSummary[]> {
    return this.storage.listSessions();
  }

  async getSession(id: string): Promise<Session | null> {
    return this.storage.getSession(id);
  }
}

function contractsMatch(session: Session, snapshot: Phase2Snapshot): boolean {
  // Equivalence check: did the user end up with the same contract content
  // after the rollback? We compare the current contract to the
  // contract-at-rollback content stored INSIDE the phase2Snapshot. The
  // global session.contractSnapshot field can't be used here because
  // every validate-PASS overwrites it with the current contract — so any
  // edit followed by a re-validate would falsely look "unchanged".
  // Trim ignores stray whitespace.
  const baseline = snapshot.contractAtRollback?.trim();
  const current = session.documents.projectContract?.content.trim();
  if (!baseline || !current) return false;
  return (
    baseline === current &&
    (snapshot.phase === "phase2_workflow_review" ||
      snapshot.phase === "phase2_screen_review" ||
      snapshot.phase === "phase2_wireframe_review")
  );
}

let cached: SessionManager | null = null;

export function getSessionManager(): SessionManager {
  if (!cached) cached = new SessionManager();
  return cached;
}
