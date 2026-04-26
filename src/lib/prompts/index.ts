import {
  CONVERSATION_CORRECTIVE_HINT,
  CONVERSATION_EXAMPLE_BOUNDARY_ASSISTANT,
  CONVERSATION_EXAMPLE_BOUNDARY_USER,
  CONVERSATION_EXAMPLE_QUESTION_ASSISTANT,
  CONVERSATION_EXAMPLE_QUESTION_USER,
  CONVERSATION_SYSTEM,
  FIRST_MESSAGE_CORRECTIVE_HINT,
  FIRST_MESSAGE_EXAMPLE_ASSISTANT,
  FIRST_MESSAGE_EXAMPLE_USER,
  FIRST_MESSAGE_SYSTEM,
  TITLE_SYSTEM,
  VALIDATE_CORRECTIVE_HINT,
  VALIDATE_SYSTEM,
} from "./phase1";
import {
  NAV_VALIDATE_CORRECTIVE_HINT,
  NAV_VALIDATE_SYSTEM,
  SCREEN_CORRECT_CORRECTIVE_HINT,
  SCREEN_CORRECT_SYSTEM,
  SCREEN_EXTRACT_CORRECTIVE_HINT,
  SCREEN_EXTRACT_SYSTEM,
  WORKFLOW_DETAIL_CORRECTIVE_HINT,
  WORKFLOW_DETAIL_SYSTEM,
  WORKFLOW_DISCOVERY_CORRECTIVE_HINT,
  WORKFLOW_DISCOVERY_EXAMPLE_ASSISTANT,
  WORKFLOW_DISCOVERY_EXAMPLE_USER,
  WORKFLOW_DISCOVERY_SYSTEM,
} from "./phase2";

export type PromptSlug =
  | "phase1.first_message"
  | "phase1.conversation"
  | "phase1.title"
  | "phase1.validate"
  | "phase2.workflow_discovery"
  | "phase2.workflow_detail"
  | "phase2.screen_extract"
  | "phase2.nav_validate"
  | "phase2.screen_correct";

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
        user: CONVERSATION_EXAMPLE_BOUNDARY_USER,
        assistant: CONVERSATION_EXAMPLE_BOUNDARY_ASSISTANT,
      },
    ],
    correctiveHint: CONVERSATION_CORRECTIVE_HINT,
  },
  "phase1.title": {
    system: TITLE_SYSTEM,
  },
  "phase1.validate": {
    system: VALIDATE_SYSTEM,
    correctiveHint: VALIDATE_CORRECTIVE_HINT,
  },
  "phase2.workflow_discovery": {
    system: WORKFLOW_DISCOVERY_SYSTEM,
    fewShot: [
      {
        user: WORKFLOW_DISCOVERY_EXAMPLE_USER,
        assistant: WORKFLOW_DISCOVERY_EXAMPLE_ASSISTANT,
      },
    ],
    correctiveHint: WORKFLOW_DISCOVERY_CORRECTIVE_HINT,
  },
  "phase2.workflow_detail": {
    system: WORKFLOW_DETAIL_SYSTEM,
    correctiveHint: WORKFLOW_DETAIL_CORRECTIVE_HINT,
  },
  "phase2.screen_extract": {
    system: SCREEN_EXTRACT_SYSTEM,
    correctiveHint: SCREEN_EXTRACT_CORRECTIVE_HINT,
  },
  "phase2.nav_validate": {
    system: NAV_VALIDATE_SYSTEM,
    correctiveHint: NAV_VALIDATE_CORRECTIVE_HINT,
  },
  "phase2.screen_correct": {
    system: SCREEN_CORRECT_SYSTEM,
    correctiveHint: SCREEN_CORRECT_CORRECTIVE_HINT,
  },
};

export function getPrompt(slug: PromptSlug): PromptSpec {
  const spec = REGISTRY[slug];
  if (!spec) throw new Error(`Unknown prompt slug: ${slug}`);
  return spec;
}
