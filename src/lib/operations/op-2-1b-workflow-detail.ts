import { getPrompt } from "@/lib/prompts";
import {
  parseContract,
  parseWorkflowDetail,
  type WorkflowDetail,
  type WorkflowStub,
} from "@/lib/parsers";
import { execute } from "./executor";

interface RunOneInput {
  contract: string;
  stub: WorkflowStub;
  signal?: AbortSignal;
}

/**
 * op-2-1b: expand one workflow stub into a full Pre-conditions / Steps /
 * Exit criteria / Edge cases spec. Called once per workflow by the stage
 * runner, typically in parallel via Module 9.
 *
 * To minimize per-call tokens (helpful on free tiers with strict TPM
 * limits), we send only the personas + entity map sections from the
 * contract — the goal statement and boundaries don't influence step-by-
 * step user actions and would just inflate the token count.
 */
export async function runWorkflowDetail(input: RunOneInput): Promise<WorkflowDetail> {
  const prompt = getPrompt("phase2.workflow_detail");
  const trimmedContract = trimContractForDetail(input.contract);
  const userBlock = `<contract>
${trimmedContract}
</contract>

<workflow>
**${input.stub.name}** — ${input.stub.description}
</workflow>`;

  const { value } = await execute({
    system: prompt.system,
    messages: [{ role: "user", content: userBlock }],
    correctiveHint: prompt.correctiveHint,
    parser: parseWorkflowDetail,
    signal: input.signal,
    maxAttempts: 2,
  });
  return value;
}

function trimContractForDetail(contract: string): string {
  const parsed = parseContract(contract);
  if (!parsed.ok) return contract.trim();
  return `## Personas
${parsed.value.personas}

## Entity Map
${parsed.value.entityMap}`;
}
