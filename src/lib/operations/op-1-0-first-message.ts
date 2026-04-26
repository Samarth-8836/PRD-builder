import { buildContext } from "@/lib/context";
import { parseFirstMessage } from "@/lib/parsers";
import { type SSEWriter } from "@/lib/streaming";
import { getStorage, type Session } from "@/lib/storage";
import { execute } from "./executor";

const CONTRACT_MARKER_RE = /\n\s*(?:\*\*\s*)?contract\s*(?:\*\*)?\s*:\s*\n/i;
const CONTRACT_DELTA_LOOKBACK = 32;

interface RunFirstMessageInput {
  session: Session;
  userInput: string;
  sse: SSEWriter;
  signal?: AbortSignal;
}

export interface RunFirstMessageResult {
  summary: string;
  contractContent: string;
  version: number;
}

/**
 * op-1-0: drafts a Project Contract from a one-line product idea.
 *
 * Streams the contract body progressively to the document panel as it
 * arrives (after the CONTRACT marker is detected). The summary is sent at
 * the end as a single chat chunk, then a canonical `document` event with
 * the parsed content overrides any partial deltas (important if a retry
 * was needed mid-stream).
 */
export async function runFirstMessage(
  input: RunFirstMessageInput
): Promise<RunFirstMessageResult> {
  const { session, userInput, sse, signal } = input;
  const storage = getStorage();

  let contractStartIdx: number | null = null;
  let lastEmittedAttempt = 0;
  let emittedTo = 0;

  const onDelta = (_delta: string, ctx: { accumulated: string; attempt: number }) => {
    if (ctx.attempt !== 1) return;
    if (lastEmittedAttempt !== ctx.attempt) {
      lastEmittedAttempt = ctx.attempt;
      emittedTo = 0;
    }

    if (contractStartIdx === null) {
      const m = ctx.accumulated.match(CONTRACT_MARKER_RE);
      if (!m || m.index === undefined) return;
      contractStartIdx = m.index + m[0].length;
      emittedTo = contractStartIdx;
    }

    const safeUpTo = Math.max(emittedTo, ctx.accumulated.length - CONTRACT_DELTA_LOOKBACK);
    if (safeUpTo > emittedTo) {
      const text = ctx.accumulated.slice(emittedTo, safeUpTo);
      if (text) {
        sse.send({ type: "document_delta", name: "projectContract", text });
      }
      emittedTo = safeUpTo;
    }
  };

  const onRetry = (reason: string, attempt: number) => {
    sse.send({
      type: "progress",
      op: "op-1-0",
      status: "started",
      note: `Retry attempt ${attempt}: ${reason}`,
    });
    contractStartIdx = null;
    emittedTo = 0;
  };

  sse.send({ type: "progress", op: "op-1-0", status: "started", note: "Drafting contract" });

  const ctx = buildContext({
    session,
    userMessage: userInput,
    promptSlug: "phase1.first_message",
  });

  const { value } = await execute({
    system: ctx.system,
    messages: ctx.messages,
    correctiveHint: ctx.correctiveHint,
    parser: parseFirstMessage,
    signal,
    onDelta,
    onRetry,
  });

  const updated = await storage.setDocument(
    session.id,
    "projectContract",
    value.contract.raw
  );

  sse.send({ type: "assistant_message", content: value.summary });
  sse.send({
    type: "document",
    name: "projectContract",
    version: updated.documents.projectContract!.version,
    content: value.contract.raw,
  });
  sse.send({ type: "progress", op: "op-1-0", status: "completed" });

  return {
    summary: value.summary,
    contractContent: value.contract.raw,
    version: updated.documents.projectContract!.version,
  };
}
