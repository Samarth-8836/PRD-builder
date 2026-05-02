import { buildContext, ensureChatCompressed } from "@/lib/context";
import {
  parseConversationResponse,
  type ParsedConversation,
} from "@/lib/parsers";
import { PRD_SLOT_IDS } from "@/lib/pipeline/configs/prd-builder";
import { getMarkdownContent, makeMarkdown, requireMarkdown } from "@/lib/pipeline/slots";
import { type SSEWriter } from "@/lib/streaming";
import { getStorage, type Session } from "@/lib/storage";
import { execute } from "./executor";

const STREAM_LOOKBACK = 32;
const MODE_LINE_RE = /^\s*(?:\*\*\s*)?mode\s*(?:\*\*)?\s*:\s*(question|edit|first_message)\s*\n/i;
const CONTRACT_MARKER_RE = /\n\s*(?:\*\*\s*)?contract\s*(?:\*\*)?\s*:\s*\n/i;

interface RunConversationInput {
  session: Session;
  userMessage: string;
  sse: SSEWriter;
  signal?: AbortSignal;
}

export interface RunConversationResult {
  mode: ParsedConversation["mode"];
  /** Assistant message to persist to chat (answer for question, summary for edit). */
  assistantMessage: string;
  /** Present only for edit mode. */
  newContractContent?: string;
  newContractVersion?: number;
}

type RouterState =
  | "detecting_mode"
  | "streaming_question"
  | "editing_buffering_summary"
  | "editing_streaming_contract";

/**
 * op-1-1: handles a follow-up message in Phase 1.
 *
 * The model classifies the user's intent (question vs edit) via a strict
 * `MODE: ...` prefix and then produces the appropriate body. We stream
 * progressively as soon as the mode is determined: question text streams
 * to chat, contract text streams to the document panel.
 *
 * On parse failure the executor retries once with a corrective hint —
 * during retry we suppress further streaming events to avoid duplicates.
 */
export async function runConversation(
  input: RunConversationInput
): Promise<RunConversationResult> {
  const { session, userMessage, sse, signal } = input;
  const storage = getStorage();
  const slotId = PRD_SLOT_IDS.projectContract;

  let state: RouterState = "detecting_mode";
  let emittedTo = 0;
  let lastAttempt = 0;
  let streamingResetSent = false;
  const oldContractContent =
    getMarkdownContent(session.slots, slotId) ?? "";
  const oldContractVersion = session.slots[slotId]?.version ?? 0;

  function resetRouter() {
    state = "detecting_mode";
    emittedTo = 0;
  }

  function processBuffer(accumulated: string) {
    let progressed = true;
    while (progressed) {
      progressed = false;
      if (state === "detecting_mode") {
        const m = accumulated.match(MODE_LINE_RE);
        if (!m) return;
        const mode = m[1]!.toLowerCase();
        emittedTo = m[0].length;
        state = mode === "question" ? "streaming_question" : "editing_buffering_summary";
        progressed = true;
        continue;
      }
      if (state === "streaming_question") {
        const safeUpTo = Math.max(emittedTo, accumulated.length - STREAM_LOOKBACK);
        if (safeUpTo > emittedTo) {
          const text = accumulated.slice(emittedTo, safeUpTo);
          sse.send({ type: "chunk", text });
          emittedTo = safeUpTo;
        }
        return;
      }
      if (state === "editing_buffering_summary") {
        const tail = accumulated.slice(emittedTo);
        const m = tail.match(CONTRACT_MARKER_RE);
        if (!m || m.index === undefined) return;
        emittedTo = emittedTo + m.index + m[0].length;
        state = "editing_streaming_contract";
        // Reset the artifact to empty so the streamed contract appears
        // as a clean progressive build instead of being appended onto
        // the previous version. Done once per attempt-1 entry into this
        // state. The canonical slot event after parse success
        // overwrites this with the full new content.
        if (!streamingResetSent) {
          sse.send({
            type: "slot",
            slotId,
            payload: {
              kind: "markdown",
              content: "",
              version: oldContractVersion,
            },
          });
          streamingResetSent = true;
        }
        progressed = true;
        continue;
      }
      if (state === "editing_streaming_contract") {
        const safeUpTo = Math.max(emittedTo, accumulated.length - STREAM_LOOKBACK);
        if (safeUpTo > emittedTo) {
          const text = accumulated.slice(emittedTo, safeUpTo);
          sse.send({ type: "slot_delta", slotId, text });
          emittedTo = safeUpTo;
        }
        return;
      }
    }
  }

  const onDelta = (_delta: string, ctx: { accumulated: string; attempt: number }) => {
    if (ctx.attempt !== 1) return;
    if (lastAttempt !== ctx.attempt) {
      lastAttempt = ctx.attempt;
      resetRouter();
    }
    processBuffer(ctx.accumulated);
  };

  const onRetry = (reason: string, attempt: number) => {
    sse.send({
      type: "progress",
      op: "op-1-1",
      status: "started",
      note: `Retry attempt ${attempt}: ${reason}`,
    });
    resetRouter();
  };

  sse.send({ type: "progress", op: "op-1-1", status: "started", note: "Thinking" });

  // Compress old chat into a rolling summary if the verbatim window
  // overflowed since the last call, so prompts retain coherent context
  // across long sessions without unbounded prompt growth.
  const compressedSession = await ensureChatCompressed(session.id);
  const ctx = buildContext({
    session: compressedSession,
    userMessage,
    promptSlug: "phase1.conversation",
  });

  let value: ParsedConversation;
  try {
    const result = await execute({
      system: ctx.system,
      messages: ctx.messages,
      correctiveHint: ctx.correctiveHint,
      parser: parseConversationResponse,
      signal,
      onDelta,
      onRetry,
    });
    value = result.value;
  } catch (err) {
    // If the streaming router cleared the artifact in preparation for
    // an EDIT and the parse never succeeded, restore the prior contract
    // so the doc panel doesn't show partial / corrupted text.
    if (streamingResetSent) {
      sse.send({
        type: "slot",
        slotId,
        payload: {
          kind: "markdown",
          content: oldContractContent,
          version: oldContractVersion,
        },
      });
    }
    throw err;
  }

  if (value.mode === "question") {
    // Canonical answer replaces any streamed chunks (necessary when a
    // corrective retry produced different content than attempt 1).
    sse.send({ type: "assistant_message", content: value.answer });
    sse.send({ type: "progress", op: "op-1-1", status: "completed" });
    return { mode: "question", assistantMessage: value.answer };
  }

  // EDIT mode — persist the new contract version and emit a canonical
  // slot event that overrides any partial deltas streamed. The summary
  // is the assistant's chat message for an edit.
  const updated = await storage.setSlot(
    session.id,
    slotId,
    makeMarkdown(value.contract.raw)
  );
  const payload = requireMarkdown(updated.slots, slotId);

  sse.send({ type: "slot", slotId, payload });
  sse.send({ type: "assistant_message", content: value.summary });
  sse.send({ type: "progress", op: "op-1-1", status: "completed" });

  return {
    mode: "edit",
    assistantMessage: value.summary,
    newContractContent: value.contract.raw,
    newContractVersion: payload.version,
  };
}
