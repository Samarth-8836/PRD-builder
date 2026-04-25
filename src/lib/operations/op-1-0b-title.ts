import { parseTitle } from "@/lib/parsers";
import { execute } from "./executor";

/**
 * op-1-0b: derives a short product name from the user's idea sentence.
 * Runs in parallel with op-1-0 so the sidebar can label the session as soon
 * as possible — well before the long contract draft completes.
 */
export async function runTitle(userInput: string, signal?: AbortSignal): Promise<string> {
  const { value } = await execute({
    promptSlug: "phase1.title",
    user: userInput,
    parser: parseTitle,
    signal,
    maxAttempts: 2,
  });
  return value;
}
