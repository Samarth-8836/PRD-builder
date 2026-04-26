import { getPrompt } from "@/lib/prompts";
import { parseWorkflowStubs, type WorkflowStub } from "@/lib/parsers";
import { execute } from "./executor";

interface RunInput {
  contract: string;
  /** Optional Phase 2 review feedback that should bias the discovery —
   *  e.g. "Add an Undo workflow". When provided, the prompt also receives
   *  the existing workflow stubs so it can preserve unchanged ones. */
  feedback?: string;
  existingWorkflows?: WorkflowStub[];
  signal?: AbortSignal;
}

/**
 * op-2-1a: given a Project Contract, list the workflows the product needs.
 * Optionally accepts user feedback + the previous workflow list during
 * a Phase 2 review cascade so the model can apply surgical updates
 * instead of regenerating the entire list.
 */
export async function runWorkflowDiscovery(input: RunInput): Promise<WorkflowStub[]> {
  const prompt = getPrompt("phase2.workflow_discovery");
  const fewShot = prompt.fewShot ?? [];

  let userBlock = `<contract>\n${input.contract.trim()}\n</contract>`;
  if (input.existingWorkflows && input.existingWorkflows.length > 0) {
    const stubs = input.existingWorkflows
      .map((s) => `- **${s.name}** — ${s.description}`)
      .join("\n");
    userBlock += `\n\n<existing_workflows>\n${stubs}\n</existing_workflows>`;
  }
  if (input.feedback) {
    userBlock += `\n\n<user_feedback>\n${input.feedback.trim()}\n</user_feedback>`;
  }

  const messages = [
    ...fewShot.flatMap((ex) => [
      { role: "user" as const, content: ex.user },
      { role: "assistant" as const, content: ex.assistant },
    ]),
    { role: "user" as const, content: userBlock },
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
