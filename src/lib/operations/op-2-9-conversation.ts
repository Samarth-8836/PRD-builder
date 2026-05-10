import { ensureChatCompressed } from "@/lib/context";
import { getPrompt } from "@/lib/prompts";
import {
  parsePhase2Conversation,
  type Phase2Conversation,
} from "@/lib/parsers";
import { getPipeline } from "@/lib/pipeline/configs";
import { getMarkdownContent } from "@/lib/pipeline/slots";
import type { Session } from "@/lib/storage";
import { execute } from "./executor";

interface RunInput {
  session: Session;
  userMessage: string;
  signal?: AbortSignal;
}

/**
 * op-2-9: Phase 2 review-stage chat handler. Classifies the user's
 * message into a question or a change request and (for changes) emits
 * a structured change_context block that the downstream drift checker
 * (op-2-10) operates on.
 *
 * Buffered, not streamed. The visible response is short and arrives in
 * the chat as a single assistant_message after parsing succeeds (or after
 * a corrective retry).
 */
export async function runPhase2Conversation(
  input: RunInput
): Promise<Phase2Conversation> {
  const { session: rawSession, userMessage, signal } = input;

  // Compress chat to last 100 + rolling summary if needed.
  const session = await ensureChatCompressed(rawSession.id);
  const pipeline = getPipeline(session.pipelineId);
  const prompt = getPrompt(pipeline.reviewChat.prompt);
  const fewShot = prompt.fewShot ?? [];

  let systemWithDocs = prompt.system;
  if (pipeline.reviewChat.buildSystemContext) {
    systemWithDocs += pipeline.reviewChat.buildSystemContext(session.slots);
  } else {
    // Fallback for pipelines that don't provide a builder: dump every
    // populated markdown slot in `<{slotId}>` tags. Sufficient for
    // simple pipelines whose review-chat prompt is permissive.
    for (const slot of pipeline.slots) {
      const content = getMarkdownContent(session.slots, slot.id);
      if (content && content.trim().length > 0) {
        systemWithDocs += `\n\n<${slot.id}>\n${content.trim()}\n</${slot.id}>`;
      }
    }
  }

  if (session.chatSummary && session.chatSummary.trim().length > 0) {
    systemWithDocs += `\n\n<earlier_conversation_summary>\n${session.chatSummary.trim()}\n</earlier_conversation_summary>`;
  }

  const messages = [
    ...fewShot.flatMap((ex) => [
      { role: "user" as const, content: ex.user },
      { role: "assistant" as const, content: ex.assistant },
    ]),
    ...verbatimChatTurns(session),
    { role: "user" as const, content: userMessage },
  ];

  // Validation allow-list — the registered step ids for this pipeline.
  // Restricts the parsed firstImpactStep to ones the engine can dispatch.
  const knownStepIds = pipeline.steps.map((s) => String(s.id));

  const { value } = await execute({
    system: systemWithDocs,
    messages,
    correctiveHint: prompt.correctiveHint,
    parser: (text) => parsePhase2Conversation(text, { knownStepIds }),
    signal,
    maxAttempts: 2,
  });
  return value;
}

function verbatimChatTurns(session: Session) {
  // The session is already trimmed to the verbatim window by
  // ensureChatCompressed; we just need to drop system entries.
  return session.chat
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));
}
