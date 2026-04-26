import { getPrompt } from "@/lib/prompts";
import { parseDriftCheck, type DriftResult } from "@/lib/parsers";
import { execute } from "./executor";

interface RunInput {
  contract: string;
  changeDescription: string;
  signal?: AbortSignal;
}

/**
 * op-2-10: drift checker. Independent LLM call that decides whether the
 * requested change can be implemented without modifying the locked
 * Project Contract. Returns COMPATIBLE / FLAG / DRIFT plus a reason.
 */
export async function runDriftCheck(input: RunInput): Promise<DriftResult> {
  const prompt = getPrompt("phase2.drift_check");
  const fewShot = prompt.fewShot ?? [];

  const messages = [
    ...fewShot.flatMap((ex) => [
      { role: "user" as const, content: ex.user },
      { role: "assistant" as const, content: ex.assistant },
    ]),
    {
      role: "user" as const,
      content: `<contract>
${input.contract.trim()}
</contract>

<change>
${input.changeDescription.trim()}
</change>`,
    },
  ];

  const { value } = await execute({
    system: prompt.system,
    messages,
    correctiveHint: prompt.correctiveHint,
    parser: parseDriftCheck,
    signal: input.signal,
    maxAttempts: 2,
  });
  return value;
}
