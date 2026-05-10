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
import { PipelineEngine } from "@/lib/pipeline";
import { DEFAULT_PIPELINE_ID, getPipeline } from "@/lib/pipeline/configs";
import { getMarkdownContent } from "@/lib/pipeline/slots";
import type { SessionLifecycle } from "@/lib/pipeline/state";
import type { PipelineConfig, StepId } from "@/lib/pipeline/types";
import { type SSEWriter } from "@/lib/streaming";
import {
  getStorage,
  type IStorage,
  type Session,
  type SessionSummary,
  type SuspendedSnapshot,
} from "@/lib/storage";
import { runStepStage } from "./generic-stage";
import { runGenericCascade } from "./generic-cascade";
import { runPhase2Cascade } from "./phase2-cascade";
import { runScreenStage } from "./screen-stage";
import { runWireframeStage } from "./wireframe-stage";
import { runWorkflowStage } from "./workflow-stage";
import {
  clearPendingPreview,
  getPendingPreview,
  setPendingPreview,
} from "./preview-store";

const PRD_PIPELINE_ID = "prd-builder.v1";

/** Read the pipeline config for a session — pure lookup, no side effects. */
function pipelineFor(session: Session): PipelineConfig {
  return getPipeline(session.pipelineId ?? DEFAULT_PIPELINE_ID);
}

/** Dispatch the initial Phase-2 stage runner for a session by pipelineId.
 *  PRD uses its hand-tuned wrappers (legacy SSE op vocab); other pipelines
 *  fall through to the generic engine-driven runner. */
async function runFirstPhase2Stage(
  session: Session,
  sse: SSEWriter,
  signal?: AbortSignal
): Promise<void> {
  if (session.pipelineId === PRD_PIPELINE_ID) {
    await runWorkflowStage({ session, sse, signal });
    return;
  }
  const pipeline = pipelineFor(session);
  await runStepStage({ session, sse, signal, stepId: pipeline.initialStep });
}

/** Dispatch the cascade for a confirmed change. PRD has its own dispatcher
 *  with patch-in-place semantics for wireframeData and single-item regen
 *  for wireframeHtml. Other pipelines use the generic rewind dispatcher. */
async function dispatchCascade(args: {
  session: Session;
  sse: SSEWriter;
  signal?: AbortSignal;
  firstImpactStepId: string;
  firstImpactItemId?: string;
  description: string;
  state: SessionLifecycle;
}): Promise<void> {
  if (args.session.pipelineId === PRD_PIPELINE_ID) {
    await runPhase2Cascade(args);
    return;
  }
  await runGenericCascade(args);
}

/** Cached engine per pipelineId — re-creating on every call would re-run
 *  the topo-order computation. Engines are stateless after construction. */
const engineCache = new Map<string, PipelineEngine>();
function engineFor(pipelineId: string): PipelineEngine {
  let eng = engineCache.get(pipelineId);
  if (!eng) {
    eng = new PipelineEngine(getPipeline(pipelineId));
    engineCache.set(pipelineId, eng);
  }
  return eng;
}

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
  /** Optional pipeline id. Defaults to "prd-builder.v1" for the
   *  legacy single-pipeline flow. The picker UI passes the user's
   *  selection through here on session creation. */
  pipelineId?: string;
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

interface ConfirmCascadeInput {
  sessionId: string;
  sse: SSEWriter;
  signal?: AbortSignal;
}

interface CancelCascadeInput {
  sessionId: string;
}

/**
 * Top-level coordinator. Routes by lifecycle state:
 *
 *   - phase1 / phase1_complete:        Phase 1 conversation (questions + edits)
 *   - review:<stepId>:                 Phase 2 review chat (questions, COMPATIBLE
 *                                      cascades, drift detection)
 *   - running:<stepId>:                rejected — stage is mid-flight
 *   - complete:                        rejected (M12 unblocks for iteration)
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
    const { firstMessage, sse, signal, pipelineId = DEFAULT_PIPELINE_ID } = input;
    const trimmed = firstMessage.trim();
    if (!trimmed) {
      sse.error("Message was empty", "EMPTY_MESSAGE");
      return;
    }

    // Validate pipelineId before creating the session — getPipeline throws
    // for unknown ids and we want that to happen before storage allocation.
    getPipeline(pipelineId);

    const id = randomUUID();
    const session = await this.storage.createSession({
      id,
      title: "Untitled",
      pipelineId,
    });

    await this.storage.appendChat(id, {
      role: "user",
      content: trimmed,
      ts: new Date().toISOString(),
    });

    emitMeta(sse, session);

    this.busy.add(id);
    try {
      const titleTask = runTitle(trimmed, session, signal)
        .then(async (title) => {
          if (sse.isClosed()) return;
          const updated = await this.storage.setTitle(id, title);
          emitMeta(sse, updated);
        })
        .catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.warn("title generation failed:", err);
        });

      if (pipelineId === PRD_PIPELINE_ID) {
        // PRD: the LLM drafts a Project Contract from the user's idea
        // (extracts personas, entities, etc.). Streamed progressively.
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
      } else {
        // Other pipelines: take the user's first message as the seed
        // content of the pipeline's interactive slot directly. No LLM
        // call. Research-report's brief lives there. The user clicks
        // Done to validate and start the engine.
        await this.seedInteractiveSlot(session, trimmed, sse);
      }

      await titleTask;
    } finally {
      this.busy.delete(id);
    }
  }

  /** Seed the pipeline's `ui.interactiveSlot` with the user's first
   *  message verbatim (markdown). Used by non-PRD pipelines whose Phase
   *  1 doesn't run an LLM extraction. */
  private async seedInteractiveSlot(
    session: Session,
    text: string,
    sse: SSEWriter
  ): Promise<void> {
    const pipeline = pipelineFor(session);
    const slotId = pipeline.ui?.interactiveSlot ?? pipeline.driftAnchor;
    const updated = await this.storage.setSlot(session.id, slotId, {
      kind: "markdown",
      content: text,
      version: 0,
    });
    sse.send({
      type: "slot",
      slotId: String(slotId),
      payload: updated.slots[slotId]!,
    });
    const ack = `Got it — captured your ${pipeline.slots.find((s) => s.id === slotId)?.label ?? "input"}. Click Done to start generating.`;
    sse.send({ type: "assistant_message", content: ack });
    await this.storage.appendChat(session.id, {
      role: "assistant",
      content: ack,
      ts: new Date().toISOString(),
    });
  }

  // ---------------------------------------------------------------------
  // State-aware chat router
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
      const pipeline = pipelineFor(session);
      if (!session.slots[pipeline.driftAnchor]) {
        throw new NoContractError(sessionId);
      }

      // Append the user message FIRST so it's persisted no matter what.
      await this.storage.appendChat(sessionId, {
        role: "user",
        content: trimmed,
        ts: new Date().toISOString(),
      });
      const refreshed = (await this.storage.getSession(sessionId))!;
      emitMeta(sse, refreshed);

      const state = refreshed.state;
      switch (state.kind) {
        case "phase1":
        case "phase1_complete":
          await this.handlePhase1Chat(refreshed, trimmed, sse, signal);
          return;
        case "review":
        case "complete":
          // Iteration on complete (M12.2): a change request after the
          // pipeline locks runs through the same classifier + drift +
          // cascade-preview gate as a review-state change. The cascade
          // bumps `pipelineVersion` once the iteration settles.
          await this.handlePhase2ReviewChat(refreshed, trimmed, sse, signal);
          return;
        case "running":
          throw new SessionBusyError(sessionId);
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
    if (session.pipelineId === PRD_PIPELINE_ID) {
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
      if (result.mode === "edit" && session.state.kind === "phase1_complete") {
        const reset: SessionLifecycle = { kind: "phase1" };
        await this.storage.setState(session.id, reset);
        sse.send({ type: "state", state: reset });
      }
      return;
    }

    // Non-PRD pipelines: Phase 1 is a simple "your message replaces the
    // brief" pattern. No LLM extraction, no question/edit classifier.
    // The user can refine the brief by sending more messages until
    // they're happy, then click Done to validate.
    await this.seedInteractiveSlot(session, message, sse);
    if (session.state.kind === "phase1_complete") {
      const reset: SessionLifecycle = { kind: "phase1" };
      await this.storage.setState(session.id, reset);
      sse.send({ type: "state", state: reset });
    }
  }

  /**
   * Handles a chat message during a review-style state. Drift check +
   * cascade dispatch are generalized: they only depend on the current
   * contract content and the first-impact step id, not on the specific
   * step the user is reviewing.
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

    // A new chat message supersedes any prior pending plan. Drop it
    // server-side so a refresh-then-Confirm with a stale plan doesn't
    // reapply the OLD change.
    clearPendingPreview(session.id);

    if (conv.mode === "question") {
      sse.send({ type: "assistant_message", content: conv.answer });
      await this.storage.appendChat(session.id, {
        role: "assistant",
        content: conv.answer,
        ts: new Date().toISOString(),
      });
      return;
    }

    // Change mode — drift-check FIRST, before anything that looks like
    // "I applied this" lands in chat. Drift FLAG/DRIFT and cancelled
    // previews must leave no false-positive chat record. The
    // `assistant_message` + `appendChat` for a change happen only after
    // the user confirms (see confirmCascade below).
    const pipeline = pipelineFor(session);
    const contract = getMarkdownContent(
      session.slots,
      pipeline.driftAnchor
    ) ?? "";
    const drift = await runDriftCheck({
      contract,
      changeDescription: conv.description,
      promptSlug: pipeline.reviewChat.driftPrompt,
      signal,
    });

    sse.send({
      type: "drift",
      classification: drift.classification,
      driftType: drift.type,
      reason: drift.reason,
      scope: conv.firstImpactStepId,
    });

    if (drift.classification === "DRIFT" || drift.classification === "FLAG") {
      // The drift banner is the only response — no chat message,
      // because nothing was applied.
      return;
    }

    // COMPATIBLE — stash the plan in-memory and emit a preview event.
    // The client renders a Confirm/Cancel banner; the actual cascade
    // runs on a separate /api/cascade/confirm SSE round-trip if confirmed.
    const preview = engineFor(session.pipelineId).previewCascade({
      firstImpactStepId: conv.firstImpactStepId as StepId,
      firstImpactItemId: conv.firstImpactItemId,
      slots: session.slots,
    });
    setPendingPreview(session.id, preview, conv.description, conv.summary);
    sse.send({
      type: "cascade_preview",
      description: conv.description,
      summary: conv.summary,
      preview,
    });
  }

  // ---------------------------------------------------------------------
  // Cascade preview confirmation
  // ---------------------------------------------------------------------
  async confirmCascade(input: ConfirmCascadeInput): Promise<void> {
    const { sessionId, sse, signal } = input;
    if (this.busy.has(sessionId)) throw new SessionBusyError(sessionId);

    const pending = getPendingPreview(sessionId);
    if (!pending) {
      // Idempotent no-op. A refresh-then-Confirm or a confirmation that
      // arrives after the 5min TTL ends here. Surface a friendly note
      // rather than a hard error, since the user's reasonable
      // interpretation is "the change went through" — but it didn't,
      // so we tell them.
      sse.send({
        type: "progress",
        op: "phase2.cascade",
        status: "completed",
        note:
          "No pending change to confirm. The plan may have expired (5-minute TTL) or been cleared by a reload. Send your change request again.",
      });
      return;
    }

    this.busy.add(sessionId);
    try {
      const session = await this.storage.getSession(sessionId);
      if (!session) {
        sse.error(`Session ${sessionId} not found`, "NOT_FOUND");
        return;
      }
      emitMeta(sse, session);

      // Persist the change summary to chat history NOW (after Confirm).
      // This is the canonical "change applied" record — it never lands
      // for cancelled or drift-rejected attempts.
      sse.send({ type: "assistant_message", content: pending.summary });
      await this.storage.appendChat(sessionId, {
        role: "assistant",
        content: pending.summary,
        ts: new Date().toISOString(),
      });

      // Append the confirmed change to the session's change log so
      // subsequent regenerations can see why the artifact looks the way
      // it does (surfaced as `<change_history>` in step prompts).
      await this.storage.appendChangeLog(sessionId, {
        ts: new Date().toISOString(),
        description: pending.description,
        summary: pending.summary,
        firstImpactStepId: pending.preview.firstImpactStepId,
        firstImpactItemId: pending.preview.firstImpactItemId,
      });

      // Iteration tracking (M12.2): if the cascade started from
      // `complete`, mark the session so the next return-to-complete
      // bumps pipelineVersion. The flag is also bumped at the end of
      // this method for in-place patches that don't transition.
      const wasComplete = session.state.kind === "complete";
      if (wasComplete) {
        await this.storage.setPendingVersionBump(sessionId, true);
      }

      // Drop the pending preview before running so a mid-cascade reload
      // doesn't see a stale plan. The cascade itself drives state via
      // its own progress events.
      clearPendingPreview(sessionId);

      await dispatchCascade({
        session,
        sse,
        signal,
        firstImpactStepId: pending.preview.firstImpactStepId,
        firstImpactItemId: pending.preview.firstImpactItemId,
        description: pending.description,
        state: session.state,
      });

      // In-place patches (data-only, single-screen wireframe regen) do
      // not transition state. If we started from `complete` and the
      // state is still `complete` at the end of the cascade, bump now —
      // the iteration is done. Full-rewind cascades stay
      // `pendingVersionBump=true` and bump in approve() at the next
      // transition to `complete`.
      if (wasComplete) {
        const after = await this.storage.getSession(sessionId);
        if (after && after.state.kind === "complete") {
          const bumped = await this.storage.bumpPipelineVersion(sessionId);
          await this.storage.setPendingVersionBump(sessionId, false);
          emitMeta(sse, bumped);
          sse.send({
            type: "progress",
            op: "phase2.iteration",
            status: "completed",
            note: `Locked v${bumped.pipelineVersion ?? 1}.`,
          });
        }
      }
    } finally {
      this.busy.delete(sessionId);
    }
  }

  cancelCascade(input: CancelCascadeInput): void {
    clearPendingPreview(input.sessionId);
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
      const pipeline = pipelineFor(session);
      if (!session.slots[pipeline.driftAnchor]) {
        throw new NoContractError(sessionId);
      }

      emitMeta(sse, session);

      if (session.pipelineId === PRD_PIPELINE_ID) {
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
      } else {
        // Non-PRD pipelines: trivially auto-PASS. The interactive slot is
        // user-authored; if they're ready to click Done, we trust them.
        // Surface the same validation_result event the UI listens for so
        // the chat panel transitions correctly.
        sse.send({
          type: "validation_result",
          status: "PASS",
          issues: [],
          suggestions: [],
        });
        const next: SessionLifecycle = { kind: "phase1_complete" };
        await this.storage.setState(sessionId, next);
        sse.send({ type: "state", state: next });
      }

      const refreshed = (await this.storage.getSession(sessionId))!;

      // Restore-from-snapshot: if the user previously rolled back from
      // Phase 2 review and the post-rollback contract is byte-identical
      // to the contract-at-rollback content, the saved Phase 2 work is
      // still valid. Restore it instead of regenerating.
      const snapshot = refreshed.suspended;
      if (snapshot && contractsMatch(refreshed, snapshot)) {
        await this.restorePhase2(refreshed, snapshot, sse);
        return;
      }
      if (snapshot) {
        await this.storage.setSuspendedSnapshot(sessionId, null);
      }
      await runFirstPhase2Stage(refreshed, sse, signal);
    } finally {
      this.busy.delete(sessionId);
    }
  }

  private async restorePhase2(
    session: Session,
    snapshot: SuspendedSnapshot,
    sse: SSEWriter
  ): Promise<void> {
    // Restore every snapshotted slot. The drift-anchor slot (contract) is
    // not in the snapshot — it stays as whatever the user re-validated.
    let updated: Session = session;
    for (const [slotId, payload] of Object.entries(snapshot.slots)) {
      updated = await this.storage.setSlot(session.id, slotId, payload);
      sse.send({
        type: "slot",
        slotId,
        payload: updated.slots[slotId]!,
      });
    }
    // Restore the change log so subsequent regenerations remember the
    // user's prior intent (group-lists screen etc.). The summary block
    // is restored alongside.
    if (snapshot.changeLog && snapshot.changeLog.length > 0) {
      await this.storage.setChangeLogWindow(
        session.id,
        snapshot.changeLogSummary ?? "",
        [...snapshot.changeLog]
      );
    }
    // Restore pipelineVersion + pendingVersionBump so the version chip
    // and any in-flight iteration flag survive the rollback round-trip.
    if (snapshot.pipelineVersion !== undefined) {
      await this.storage.setPipelineVersion(
        session.id,
        snapshot.pipelineVersion
      );
    }
    if (snapshot.pendingVersionBump !== undefined) {
      await this.storage.setPendingVersionBump(
        session.id,
        snapshot.pendingVersionBump
      );
    }
    await this.storage.setSuspendedSnapshot(session.id, null);

    // Always land at the first step's review (regardless of which
    // lifecycle the snapshot was taken from). Whether the user rolled
    // back from review:* or from complete, the reason they rolled back
    // was to revisit; walking each gate gives them a chance to change
    // something at any stage. approve() skips stages whose outputs are
    // already populated, so the walk is cheap (no LLM calls) when
    // nothing actually needs to change.
    const pipeline = pipelineFor(session);
    const finalState: SessionLifecycle = {
      kind: "review",
      stepId: pipeline.initialStep,
    };
    await this.storage.setState(session.id, finalState);
    sse.send({ type: "state", state: finalState });
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
  // Phase 2 approve — dispatches by current review step
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

      emitMeta(sse, session);

      const state = session.state;
      if (state.kind !== "review") {
        throw new WrongPhaseError(
          `Cannot approve from ${state.kind}; approval is only available from a review state`
        );
      }

      const pipeline = pipelineFor(session);
      const currentStep = pipeline.steps.find((s) => s.id === state.stepId);
      if (!currentStep) {
        throw new WrongPhaseError(
          `Cannot approve from review:${String(state.stepId)}; step is not registered in pipeline ${pipeline.id}`
        );
      }

      // Validate every transitive dependency's slot is populated. This
      // is the generic equivalent of "Workflow Map is missing" /
      // "Screen Inventory is missing" defenses.
      const missingDep = currentStep.produces.find((s) => !session.slots[s]);
      if (missingDep) {
        throw new WrongPhaseError(
          `Cannot approve — ${pipeline.slots.find((s) => s.id === missingDep)?.label ?? String(missingDep)} is missing`
        );
      }

      // Find the next runnable step from the engine's perspective. If the
      // engine reports no next step, the pipeline is complete.
      const engine = engineFor(session.pipelineId);
      const nextStepId = engine.nextRunnableStep(session.slots);

      if (!nextStepId) {
        // Pipeline complete — transition to complete state, handle
        // iteration version bump if pending.
        const next: SessionLifecycle = { kind: "complete" };
        let updated = await this.storage.setState(sessionId, next);
        sse.send({ type: "state", state: next });

        if (session.pendingVersionBump) {
          updated = await this.storage.bumpPipelineVersion(sessionId);
          await this.storage.setPendingVersionBump(sessionId, false);
          emitMeta(sse, updated);
        }

        sse.send({
          type: "progress",
          op: `${pipeline.id}.complete`,
          status: "completed",
          note: session.pendingVersionBump
            ? `Locked v${updated.pipelineVersion ?? 1}. Click Export to download the bundle.`
            : "All artifacts are locked in. Click Export to download the bundle.",
        });
        return;
      }

      // Skip-when-populated: post-restore, the slot for the next step
      // already exists. Skip the LLM call and just advance state to the
      // next review gate.
      const nextStep = pipeline.steps.find((s) => s.id === nextStepId)!;
      if (nextStep.produces.every((s) => session.slots[s])) {
        const next: SessionLifecycle =
          nextStep.gate === "review"
            ? { kind: "review", stepId: nextStepId }
            : { kind: "running", stepId: nextStepId };
        await this.storage.setState(sessionId, next);
        sse.send({ type: "state", state: next });
        sse.send({
          type: "progress",
          op: `${pipeline.id}.skip`,
          status: "completed",
          note: `${nextStep.label} already exists from restore — review it, then approve again to continue.`,
        });
        return;
      }

      // Run the next stage. PRD pipeline uses its hand-tuned wrappers;
      // others use the generic runner.
      if (session.pipelineId === PRD_PIPELINE_ID) {
        await this.dispatchPrdStage(nextStepId, session, sse, signal);
        return;
      }
      await runStepStage({ session, sse, signal, stepId: nextStepId });
    } finally {
      this.busy.delete(sessionId);
    }
  }

  /** PRD-specific stage dispatch. Maps step ids to the legacy hand-tuned
   *  stage runners that emit PRD's specific SSE op vocabulary. */
  private async dispatchPrdStage(
    stepId: StepId,
    session: Session,
    sse: SSEWriter,
    signal: AbortSignal | undefined
  ): Promise<void> {
    const id = String(stepId);
    if (id === "workflow") {
      await runWorkflowStage({ session, sse, signal });
      return;
    }
    if (id === "screen") {
      await runScreenStage({ session, sse, signal });
      return;
    }
    if (id === "wireframeData" || id === "wireframeHtml") {
      await runWireframeStage({ session, sse, signal });
      return;
    }
    throw new WrongPhaseError(
      `PRD pipeline has no stage runner wired for step "${id}"`
    );
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
        session.state.kind !== "review" &&
        session.state.kind !== "complete"
      ) {
        throw new WrongPhaseError(
          `Cannot roll back from ${session.state.kind}; rollback is only available from a review state or after the pipeline locks`
        );
      }

      // Drop any stale pending cascade preview — the user is taking a
      // different path now, the in-memory plan is no longer valid.
      clearPendingPreview(sessionId);
      // Drop any cascade regen context — those cached prior versions
      // are not part of the rolled-back snapshot.
      await this.storage.clearRegenContext(sessionId);

      // Snapshot every slot except the drift anchor (contract). The user
      // is about to edit the contract; the rest of the artifacts are what
      // we want to restore on a clean re-validate.
      const pipeline = pipelineFor(session);
      const anchor = pipeline.driftAnchor;
      const snapshotSlots: Record<string, (typeof session.slots)[string]> = {};
      for (const [slotId, payload] of Object.entries(session.slots)) {
        if (slotId === anchor) continue;
        snapshotSlots[slotId] = payload;
      }
      const snapshot: SuspendedSnapshot = {
        slots: snapshotSlots,
        state: session.state,
        anchorAtRollback:
          getMarkdownContent(session.slots, anchor) ?? "",
        changeLog: session.changeLog ? [...session.changeLog] : undefined,
        changeLogSummary: session.changeLogSummary,
        pipelineVersion: session.pipelineVersion ?? 1,
        pendingVersionBump: session.pendingVersionBump,
        takenAt: new Date().toISOString(),
      };
      await this.storage.setSuspendedSnapshot(sessionId, snapshot);

      // Clear the live Phase 2 slots so the doc panel doesn't show stale
      // content while the user edits the contract.
      for (const slotId of Object.keys(snapshotSlots)) {
        await this.storage.clearSlot(sessionId, slotId);
        sse.send({ type: "slot_cleared", slotId });
      }
      // Drop the live change log too — the user is editing the contract
      // and the suspended snapshot already captured what we'd want to
      // restore. If the contract is unchanged on re-validate, the log
      // will be restored along with the slots.
      await this.storage.clearChangeLog(sessionId);
      // Drop the iteration flag — rolling back abandons whatever
      // iteration was in progress; no version bump is owed.
      if (session.pendingVersionBump) {
        await this.storage.setPendingVersionBump(sessionId, false);
      }

      const next: SessionLifecycle = { kind: "phase1" };
      const updated = await this.storage.setState(sessionId, next);
      emitMeta(sse, updated);
      sse.send({ type: "state", state: next });
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

function emitMeta(sse: SSEWriter, session: Session): void {
  sse.send({
    type: "meta",
    sessionId: session.id,
    title: session.title,
    state: session.state,
    pipelineVersion: session.pipelineVersion ?? 1,
    pipelineId: session.pipelineId,
  });
}

function contractsMatch(session: Session, snapshot: SuspendedSnapshot): boolean {
  // Equivalence check: did the user end up with the same contract content
  // after the rollback? We compare the current contract to the
  // anchor-at-rollback content stored INSIDE the snapshot (validate-PASS
  // never mutates a snapshot). Trim ignores stray whitespace.
  const baseline = snapshot.anchorAtRollback?.trim();
  const pipeline = getPipeline(session.pipelineId ?? DEFAULT_PIPELINE_ID);
  const current = getMarkdownContent(
    session.slots,
    pipeline.driftAnchor
  )?.trim();
  if (!baseline || !current) return false;
  // Restore is valid for snapshots taken from any review state OR from
  // complete (M12.2 unblocks rollback at complete). Anything else
  // (phase1 / phase1_complete / running) is not a rollback path.
  if (snapshot.state.kind !== "review" && snapshot.state.kind !== "complete") {
    return false;
  }
  return baseline === current;
}

let cached: SessionManager | null = null;

export function getSessionManager(): SessionManager {
  if (!cached) cached = new SessionManager();
  return cached;
}
