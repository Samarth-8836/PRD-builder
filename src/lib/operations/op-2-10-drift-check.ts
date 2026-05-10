import { getPrompt, type PromptSlug } from "@/lib/prompts";
import { parseDriftCheck, type DriftResult } from "@/lib/parsers";
import { execute } from "./executor";

interface RunInput {
  contract: string;
  changeDescription: string;
  signal?: AbortSignal;
  /** Pipeline-specific drift prompt. Defaults to PRD's
   *  "phase2.drift_check" so legacy callers don't need to pass anything. */
  promptSlug?: PromptSlug;
}

/**
 * op-2-10: drift checker. Independent LLM call that decides whether the
 * requested change can be implemented without modifying the locked
 * drift anchor (Project Contract for PRD; Research Brief for
 * research-report). Returns COMPATIBLE / FLAG / DRIFT plus a reason.
 */
export async function runDriftCheck(input: RunInput): Promise<DriftResult> {
  const prompt = getPrompt(input.promptSlug ?? "phase2.drift_check");
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
