import { getPrompt } from "@/lib/prompts";
import { parseWorkflowStubs, type WorkflowStub } from "@/lib/parsers";
import { execute } from "./executor";

interface RunInput {
  contract: string;
  signal?: AbortSignal;
}

/**
 * op-2-1a: given a Project Contract, list the workflows the product needs.
 * Returns a flat list of stubs that op-2-1b will expand in parallel.
 */
export async function runWorkflowDiscovery(input: RunInput): Promise<WorkflowStub[]> {
  const prompt = getPrompt("phase2.workflow_discovery");
  const fewShot = prompt.fewShot ?? [];

  const messages = [
    ...fewShot.flatMap((ex) => [
      { role: "user" as const, content: ex.user },
      { role: "assistant" as const, content: ex.assistant },
    ]),
    {
      role: "user" as const,
      content: `<contract>\n${input.contract.trim()}\n</contract>`,
    },
  ];

  const { value } = await execute({
    system: prompt.system,
    messages,
    correctiveHint: prompt.correctiveHint,
    parser: parseWorkflowStubs,
    signal: input.signal,
    maxAttempts: 2,
  });
  return value;
}
