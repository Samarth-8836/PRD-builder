import { type ChatMessage } from "@/lib/llm/provider";
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
  /** Number of recent user/assistant pairs to include from session.chat.
   *  Default 5. The first-message slug ignores history because no
   *  meaningful prior turns exist. */
  historyTurns?: number;
}

/**
 * Module 7 — Context Builder.
 *
 * Assembles `{system, messages, correctiveHint}` for an Operation by
 * combining (a) the registered prompt's system + few-shot, (b) any
 * slug-specific context augmentations (e.g. injecting the current
 * Project Contract for the conversation slug), and (c) recent chat history.
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
    const turns = input.historyTurns ?? 5;
    const recent = sliceRecentTurns(input.session.chat, turns);
    for (const m of recent) {
      if (m.role === "user" || m.role === "assistant") {
        messages.push({ role: m.role, content: m.content });
      }
    }
  }

  messages.push({ role: "user", content: input.userMessage });

  let system = prompt.system;
  const contract = input.session.documents.projectContract;
  if (input.promptSlug === "phase1.conversation" && contract) {
    system =
      system +
      "\n\n<current_contract>\n" +
      contract.content.trim() +
      "\n</current_contract>";
  }

  return {
    system,
    messages,
    correctiveHint: prompt.correctiveHint,
  };
}

interface ChatLike {
  role: string;
  content: string;
}

function sliceRecentTurns(history: ChatLike[], turns: number): ChatLike[] {
  // Keep only user/assistant turns, then take the last 2*turns of them.
  const filtered = history.filter((m) => m.role === "user" || m.role === "assistant");
  return filtered.slice(Math.max(0, filtered.length - turns * 2));
}
