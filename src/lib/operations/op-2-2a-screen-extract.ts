import { getPrompt } from "@/lib/prompts";
import { parseScreens, type ScreenSpec } from "@/lib/parsers";
import { execute } from "./executor";

interface RunInput {
  contract: string;
  workflowMap: string;
  signal?: AbortSignal;
}

/**
 * op-2-2a: derive the minimum set of screens needed to support every
 * workflow. Returns a structured screen list with per-screen nav targets.
 */
export async function runScreenExtract(input: RunInput): Promise<ScreenSpec[]> {
  const prompt = getPrompt("phase2.screen_extract");
  const userBlock = `<contract>
${input.contract.trim()}
</contract>

<workflow_map>
${input.workflowMap.trim()}
</workflow_map>`;

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
