import { type ChatMessage } from "@/lib/llm/provider";
import { PRD_SLOT_IDS } from "@/lib/pipeline/configs/prd-builder";
import { getMarkdownContent } from "@/lib/pipeline/slots";
import { getPrompt, type PromptSlug } from "@/lib/prompts";
import type { Session } from "@/lib/storage";

export interface BuiltContext {
  system: string;
  messages: ChatMessage[];
  correctiveHint?: (reason: string) => string;
}

export interface BuildContextInput {
  session: Session;
  userMessage: string;
  promptSlug: PromptSlug;
}

/**
 * Module 7 — Context Builder.
 *
 * Assembles `{system, messages, correctiveHint}` for an Operation by
 * combining (a) the registered prompt's system + few-shot, (b) any
 * slug-specific context augmentations (e.g. injecting the current
 * Project Contract + rolling chat summary), and (c) the verbatim chat
 * window (last 100 user/assistant turns by construction — call
 * `ensureChatCompressed` upstream to enforce that bound).
 */
export function buildContext(input: BuildContextInput): BuiltContext {
  const prompt = getPrompt(input.promptSlug);
  const messages: ChatMessage[] = [];

  if (prompt.fewShot) {
    for (const ex of prompt.fewShot) {
      messages.push({ role: "user", content: ex.user });
      messages.push({ role: "assistant", content: ex.assistant });
    }
  }

  const includeHistory = input.promptSlug !== "phase1.first_message";
  if (includeHistory) {
    for (const m of input.session.chat) {
      if (m.role === "user" || m.role === "assistant") {
        messages.push({ role: m.role, content: m.content });
      }
    }
  }

  messages.push({ role: "user", content: input.userMessage });

  let system = prompt.system;
  const contractContent = getMarkdownContent(
    input.session.slots,
    PRD_SLOT_IDS.projectContract
  );
  if (input.promptSlug === "phase1.conversation" && contractContent) {
    system =
      system +
      "\n\n<current_contract>\n" +
      contractContent.trim() +
      "\n</current_contract>";
  }
  if (
    includeHistory &&
    input.session.chatSummary &&
    input.session.chatSummary.trim().length > 0
  ) {
    system =
      system +
      "\n\n<earlier_conversation_summary>\n" +
      input.session.chatSummary.trim() +
      "\n</earlier_conversation_summary>";
  }

  return {
    system,
    messages,
    correctiveHint: prompt.correctiveHint,
  };
}
