import { ensureChatCompressed } from "@/lib/context";
import { getPrompt } from "@/lib/prompts";
import {
  parsePhase2Conversation,
  type Phase2Conversation,
} from "@/lib/parsers";
import { PRD_SLOT_IDS } from "@/lib/pipeline/configs/prd-builder";
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
  const prompt = getPrompt("phase2.conversation");
  const fewShot = prompt.fewShot ?? [];

  // Compress chat to last 100 + rolling summary if needed.
  const session = await ensureChatCompressed(rawSession.id);

  const contract = getMarkdownContent(session.slots, PRD_SLOT_IDS.projectContract) ?? "";
  const workflowMap = getMarkdownContent(session.slots, PRD_SLOT_IDS.workflowMap) ?? "";
  const screenInventory = getMarkdownContent(session.slots, PRD_SLOT_IDS.screenInventory) ?? "";

  let systemWithDocs = `${prompt.system}

<project_contract>
${contract.trim()}
</project_contract>

<workflow_map>
${workflowMap.trim()}
</workflow_map>

<screen_inventory>
${screenInventory.trim()}
</screen_inventory>`;

  const wireframe = session.slots[PRD_SLOT_IDS.wireframeFiles];
  if (wireframe && wireframe.kind === "fileset") {
    const screenIds = Object.keys(wireframe.files)
      .filter((f) => f.endsWith(".html") && f !== "index.html")
      .map((f) => f.replace(/\.html$/, ""));
    systemWithDocs += `\n\n<wireframe_state>
A clickable wireframe has been generated (version ${wireframe.version}). Screen ids with rendered HTML files: ${screenIds.join(", ")}.
</wireframe_state>`;
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

  const { value } = await execute({
    system: systemWithDocs,
    messages,
    correctiveHint: prompt.correctiveHint,
    parser: parsePhase2Conversation,
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
