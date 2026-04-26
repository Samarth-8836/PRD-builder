import { buildContext } from "@/lib/context";
import { parseTitle } from "@/lib/parsers";
import type { Session } from "@/lib/storage";
import { execute } from "./executor";

/**
 * op-1-0b: derives a short product name from the user's idea sentence.
 * Runs in parallel with op-1-0 so the sidebar can label the session as soon
 * as possible — well before the long contract draft completes.
 */
export async function runTitle(
  userInput: string,
  session: Session,
  signal?: AbortSignal
): Promise<string> {
  const ctx = buildContext({
    session,
    userMessage: userInput,
    promptSlug: "phase1.title",
  });

  const { value } = await execute({
    system: ctx.system,
    messages: ctx.messages,
    correctiveHint: ctx.correctiveHint,
    parser: parseTitle,
    signal,
    maxAttempts: 2,
  });
  return value;
}
