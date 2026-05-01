import { getPrompt } from "@/lib/prompts";
import { parseValidationResult, type ValidationResult } from "@/lib/parsers";
import { PRD_SLOT_IDS } from "@/lib/pipeline/configs/prd-builder";
import { requireMarkdown } from "@/lib/pipeline/slots";
import type { SessionLifecycle } from "@/lib/pipeline/state";
import { type SSEWriter } from "@/lib/streaming";
import { getStorage, type Session } from "@/lib/storage";
import { execute } from "./executor";

interface RunValidateInput {
  session: Session;
  sse: SSEWriter;
  signal?: AbortSignal;
}

export interface RunValidateResult {
  status: ValidationResult["status"];
  issues: string[];
  suggestions: string[];
  newState: SessionLifecycle;
}

export class NoContractToValidateError extends Error {
  readonly code = "NO_CONTRACT";
  constructor(public sessionId: string) {
    super(`Session ${sessionId} has no Project Contract to validate`);
  }
}

/**
 * op-1-2: validates the current Project Contract against a five-point
 * checklist. On PASS, transitions state to phase1_complete. On FAIL, leaves
 * state as-is and returns the issues + suggestions for the user to act on.
 */
export async function runValidate(
  input: RunValidateInput
): Promise<RunValidateResult> {
  const { session, sse, signal } = input;
  const storage = getStorage();

  const contractSlot = session.slots[PRD_SLOT_IDS.projectContract];
  if (!contractSlot) throw new NoContractToValidateError(session.id);
  const contract = requireMarkdown(session.slots, PRD_SLOT_IDS.projectContract);

  sse.send({
    type: "progress",
    op: "op-1-2",
    status: "started",
    note: "Validating contract",
  });

  const prompt = getPrompt("phase1.validate");

  const { value } = await execute({
    system: prompt.system,
    messages: [
      {
        role: "user",
        content: `<contract>\n${contract.content.trim()}\n</contract>`,
      },
    ],
    correctiveHint: prompt.correctiveHint,
    parser: parseValidationResult,
    signal,
    maxAttempts: 2,
  });

  sse.send({
    type: "validation_result",
    status: value.status,
    issues: value.issues,
    suggestions: value.suggestions,
  });

  let newState: SessionLifecycle = session.state;
  if (value.status === "PASS") {
    newState = { kind: "phase1_complete" };
    await storage.setState(session.id, newState);
    sse.send({ type: "state", state: newState });
  }

  sse.send({ type: "progress", op: "op-1-2", status: "completed" });

  return {
    status: value.status,
    issues: value.issues,
    suggestions: value.suggestions,
    newState,
  };
}
