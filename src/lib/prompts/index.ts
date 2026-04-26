import {
  CONVERSATION_CORRECTIVE_HINT,
  CONVERSATION_EXAMPLE_BOUNDARY_ASSISTANT,
  CONVERSATION_EXAMPLE_BOUNDARY_USER,
  CONVERSATION_EXAMPLE_EDIT_ASSISTANT,
  CONVERSATION_EXAMPLE_EDIT_USER,
  CONVERSATION_EXAMPLE_QUESTION_ASSISTANT,
  CONVERSATION_EXAMPLE_QUESTION_USER,
  CONVERSATION_SYSTEM,
  FIRST_MESSAGE_CORRECTIVE_HINT,
  FIRST_MESSAGE_EXAMPLE_ASSISTANT,
  FIRST_MESSAGE_EXAMPLE_USER,
  FIRST_MESSAGE_SYSTEM,
  TITLE_SYSTEM,
} from "./phase1";

export type PromptSlug =
  | "phase1.first_message"
  | "phase1.conversation"
  | "phase1.title";

export interface PromptSpec {
  system: string;
  fewShot?: { user: string; assistant: string }[];
  correctiveHint?: (reason: string) => string;
}

const REGISTRY: Record<PromptSlug, PromptSpec> = {
  "phase1.first_message": {
    system: FIRST_MESSAGE_SYSTEM,
    fewShot: [
      {
        user: FIRST_MESSAGE_EXAMPLE_USER,
        assistant: FIRST_MESSAGE_EXAMPLE_ASSISTANT,
      },
    ],
    correctiveHint: FIRST_MESSAGE_CORRECTIVE_HINT,
  },
  "phase1.conversation": {
    system: CONVERSATION_SYSTEM,
    fewShot: [
      {
        user: CONVERSATION_EXAMPLE_QUESTION_USER,
        assistant: CONVERSATION_EXAMPLE_QUESTION_ASSISTANT,
      },
      {
        user: CONVERSATION_EXAMPLE_EDIT_USER,
        assistant: CONVERSATION_EXAMPLE_EDIT_ASSISTANT,
      },
      {
        user: CONVERSATION_EXAMPLE_BOUNDARY_USER,
        assistant: CONVERSATION_EXAMPLE_BOUNDARY_ASSISTANT,
      },
    ],
    correctiveHint: CONVERSATION_CORRECTIVE_HINT,
  },
  "phase1.title": {
    system: TITLE_SYSTEM,
  },
};

export function getPrompt(slug: PromptSlug): PromptSpec {
  const spec = REGISTRY[slug];
  if (!spec) throw new Error(`Unknown prompt slug: ${slug}`);
  return spec;
}
