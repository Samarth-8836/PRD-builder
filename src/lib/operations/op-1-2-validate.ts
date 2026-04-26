import { getPrompt } from "@/lib/prompts";
import { parseValidationResult, type ValidationResult } from "@/lib/parsers";
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
  newPhase: Session["phase"];
}

export class NoContractToValidateError extends Error {
  readonly code = "NO_CONTRACT";
  constructor(public sessionId: string) {
    super(`Session ${sessionId} has no Project Contract to validate`);
  }
}

/**
 * op-1-2: validates the current Project Contract against a five-point
 * checklist. On PASS, transitions phase to phase1_complete and snapshots
 * the contract so a future rollback can detect "structurally identical"
 * resumes (M5+). On FAIL, leaves phase as-is and returns the issues +
 * suggestions for the user to act on.
 */
export async function runValidate(
  input: RunValidateInput
): Promise<RunValidateResult> {
  const { session, sse, signal } = input;
  const storage = getStorage();

  const contract = session.documents.projectContract;
  if (!contract) throw new NoContractToValidateError(session.id);

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

  let newPhase = session.phase;
  if (value.status === "PASS") {
    const updated = await storage.setPhase(session.id, "phase1_complete");
    await storage.setContractSnapshot(session.id, contract.content);
    newPhase = updated.phase;
    sse.send({ type: "phase", phase: newPhase });
  }

  sse.send({ type: "progress", op: "op-1-2", status: "completed" });

  return {
    status: value.status,
    issues: value.issues,
    suggestions: value.suggestions,
    newPhase,
  };
}
