import { getPrompt } from "@/lib/prompts";
import { parseDummyData, type DummyData } from "@/lib/parsers";
import { execute } from "./executor";

interface RunInput {
  contract: string;
  screenInventory: string;
  /** Optional Phase 2 review feedback (e.g. "make task names shorter"). */
  feedback?: string;
  signal?: AbortSignal;
}

/**
 * op-2-3a: generate realistic sample data for the entities defined in the
 * Project Contract. Output is a JSON object keyed by lowercase plural
 * entity names (e.g. "tasks", "lists"); each value is an array of 3-8
 * sample instances. Used to populate the wireframe via window.DATA.
 */
export async function runDummyData(input: RunInput): Promise<DummyData> {
  const prompt = getPrompt("phase2.dummy_data");
  let userBlock = `<contract>
${input.contract.trim()}
</contract>

<screen_inventory>
${input.screenInventory.trim()}
</screen_inventory>`;

  if (input.feedback) {
    userBlock += `\n\n<user_feedback>\n${input.feedback.trim()}\n</user_feedback>`;
  }

  const { value } = await execute({
    system: prompt.system,
    messages: [{ role: "user", content: userBlock }],
    correctiveHint: prompt.correctiveHint,
    parser: parseDummyData,
    signal: input.signal,
    maxAttempts: 2,
  });
  return value;
}
