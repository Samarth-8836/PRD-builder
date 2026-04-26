import { getPrompt } from "@/lib/prompts";
import { parseScreens, type ScreenSpec } from "@/lib/parsers";
import { execute } from "./executor";
import { formatScreenList } from "./format-helpers";

interface RunInput {
  contract: string;
  workflowMap: string;
  feedback?: string;
  existingScreens?: ScreenSpec[];
  signal?: AbortSignal;
}

/**
 * op-2-2a: derive the minimum set of screens needed to support every
 * workflow. Optionally accepts user feedback and the existing screen list
 * for surgical updates during a Phase 2 review cascade.
 */
export async function runScreenExtract(input: RunInput): Promise<ScreenSpec[]> {
  const prompt = getPrompt("phase2.screen_extract");
  let userBlock = `<contract>
${input.contract.trim()}
</contract>

<workflow_map>
${input.workflowMap.trim()}
</workflow_map>`;

  if (input.existingScreens && input.existingScreens.length > 0) {
    userBlock += `\n\n<existing_screens>\n${formatScreenList(input.existingScreens)}\n</existing_screens>`;
  }
  if (input.feedback) {
    userBlock += `\n\n<user_feedback>\n${input.feedback.trim()}\n</user_feedback>`;
  }

  const { value } = await execute({
    system: prompt.system,
    messages: [{ role: "user", content: userBlock }],
    correctiveHint: prompt.correctiveHint,
    parser: parseScreens,
    signal: input.signal,
    maxAttempts: 2,
  });
  return value;
}
