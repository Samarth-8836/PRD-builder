import {
  FIRST_MESSAGE_CORRECTIVE_HINT,
  FIRST_MESSAGE_EXAMPLE_ASSISTANT,
  FIRST_MESSAGE_EXAMPLE_USER,
  FIRST_MESSAGE_SYSTEM,
  TITLE_SYSTEM,
} from "./phase1";

export type PromptSlug = "phase1.first_message" | "phase1.title";

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
  "phase1.title": {
    system: TITLE_SYSTEM,
  },
};

export function getPrompt(slug: PromptSlug): PromptSpec {
  const spec = REGISTRY[slug];
  if (!spec) throw new Error(`Unknown prompt slug: ${slug}`);
  return spec;
}
