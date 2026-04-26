import { getPrompt } from "@/lib/prompts";
import { parseScreens, type ScreenSpec } from "@/lib/parsers";
import { execute } from "./executor";
import { formatScreenList } from "./format-helpers";

interface RunInput {
  workflowMap: string;
  screens: ScreenSpec[];
  gaps: string[];
  signal?: AbortSignal;
}

/**
 * op-2-2c: given a screen list and identified nav gaps, produce a
 * corrected list. Conditional — only runs when op-2-2b reports gaps.
 */
export async function runScreenCorrect(input: RunInput): Promise<ScreenSpec[]> {
  const prompt = getPrompt("phase2.screen_correct");
  const userBlock = `<screens>
${formatScreenList(input.screens)}
</screens>

<workflow_map>
${input.workflowMap.trim()}
</workflow_map>

<gaps>
${input.gaps.map((g) => `- ${g}`).join("\n")}
</gaps>`;

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
