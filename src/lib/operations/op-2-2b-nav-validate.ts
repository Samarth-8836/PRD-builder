import { getPrompt } from "@/lib/prompts";
import {
  parseNavValidation,
  type NavValidationResult,
  type ScreenSpec,
} from "@/lib/parsers";
import { execute } from "./executor";
import { formatScreenList } from "./format-helpers";

interface RunInput {
  workflowMap: string;
  screens: ScreenSpec[];
  signal?: AbortSignal;
}

/**
 * op-2-2b: verify every workflow can be completed by walking the
 * navigation graph. Returns "ok" or a list of gaps to address.
 */
export async function runNavValidate(input: RunInput): Promise<NavValidationResult> {
  const prompt = getPrompt("phase2.nav_validate");
  const userBlock = `<workflow_map>
${input.workflowMap.trim()}
</workflow_map>

<screens>
${formatScreenList(input.screens)}
</screens>`;

  const { value } = await execute({
    system: prompt.system,
    messages: [{ role: "user", content: userBlock }],
    correctiveHint: prompt.correctiveHint,
    parser: parseNavValidation,
    signal: input.signal,
    maxAttempts: 2,
  });
  return value;
}
