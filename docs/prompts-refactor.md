# Prompts Refactor Guide

This document is the **operating manual** for the prompt layer of PRD-Builder.
It exists so that anyone (including future-you, six months from now) can rename
a domain term, reword a few-shot example, swap one step for another, or graft
on a new pipeline **without grepping through code first**.

The framework's contract: domain vocabulary lives in prompts. The engine, UI,
storage, and cascade rules know nothing about "Project Contract", "persona",
"workflow", or "screen". Renaming any of those is a prompt edit, not a code
change. If a rename ever requires touching code outside the prompt files and
their paired parsers, the framework has a leak — open an issue.

This file is created in M8 (skeleton) and filled in incrementally as each
milestone exposes more of the contract surface. Update it whenever you touch a
prompt file.

---

## 1. Prompt registry contract

A **prompt slug** is a string id of the form `<pipeline>.<step>` (e.g.,
`phase2.workflow_discovery`). It maps to a `PromptSpec`:

```ts
interface PromptSpec {
  system: string;
  fewShot?: { user: string; assistant: string }[];
  correctiveHint?: (reason: string) => string;
}
```

The registry lives at `src/lib/prompts/index.ts`. Adding a slug means:

1. Authoring `system` text (and optionally `fewShot`, `correctiveHint`) in a
   per-pipeline prompts file like `src/lib/prompts/phase2.ts` or
   `src/lib/prompts/research-report.ts`.
2. Adding a `PromptSlug` union member in `src/lib/prompts/index.ts`.
3. Wiring it into the `REGISTRY` map.

A pipeline config (`src/lib/pipeline/configs/*.ts`) references slugs by name
in its step runners. The engine resolves them via `getPrompt(slug)` at run
time.

---

## 2. Module-prompt cross-reference

For each prompt slug: where the system text lives, the parser it pairs with,
the step that consumes it, and the slot the step writes.

| Slug                          | Source file                                 | Parser (`src/lib/parsers/`)            | Step (PRD pipeline)             | Output slot          |
| ----------------------------- | ------------------------------------------- | -------------------------------------- | ------------------------------- | -------------------- |
| `phase1.first_message`        | `src/lib/prompts/phase1.ts`                 | `parseFirstMessage` (first-message.ts) | (Phase 1 — outside engine)      | `projectContract`    |
| `phase1.conversation`         | `src/lib/prompts/phase1.ts`                 | `parseConversationResponse` (conversation.ts) | (Phase 1 — outside engine) | `projectContract`    |
| `phase1.title`                | `src/lib/prompts/phase1.ts`                 | `parseTitle` (title.ts)                | (Phase 1 — outside engine)      | (no slot — session title) |
| `phase1.validate`             | `src/lib/prompts/phase1.ts`                 | `parseValidationResult` (validation.ts) | (Phase 1 — outside engine)      | (no slot — gate check) |
| `phase2.workflow_discovery`   | `src/lib/prompts/phase2.ts`                 | `parseWorkflowStubs` (phase2.ts)       | `workflow` (substep `discovery`) | `workflowMap`        |
| `phase2.workflow_detail`      | `src/lib/prompts/phase2.ts`                 | `parseWorkflowDetail` (phase2.ts)      | `workflow` (fanout substep `detail`) | `workflowMap`        |
| `phase2.screen_extract`       | `src/lib/prompts/phase2.ts`                 | `parseScreens` (phase2.ts)             | `screen` (substep `extract`)    | `screenInventory`    |
| `phase2.nav_validate`         | `src/lib/prompts/phase2.ts`                 | `parseNavValidation` (phase2.ts)       | `screen` (substep `validate`)   | (intermediate — no slot) |
| `phase2.screen_correct`       | `src/lib/prompts/phase2.ts`                 | `parseScreens` (phase2.ts)             | `screen` (substep `correct`, conditional) | `screenInventory` |
| `phase2.conversation`         | `src/lib/prompts/phase2.ts`                 | `parsePhase2Conversation` (phase2-review.ts) | (Review chat classifier)        | (no slot — routing) |
| `phase2.drift_check`          | `src/lib/prompts/phase2.ts`                 | `parseDriftCheck` (phase2-review.ts)   | (Review chat drift gate)        | (no slot — gate)     |
| `phase2.dummy_data`           | `src/lib/prompts/wireframe.ts`              | `parseDummyData` (wireframe.ts)        | `wireframeData`                 | `wireframeData`      |
| `phase2.wireframe_shell`      | `src/lib/prompts/wireframe.ts`              | `parseHtmlDocument` (wireframe.ts)     | `wireframeHtml` (substep `shell`) | `wireframeFiles`   |
| `phase2.screen_html`          | `src/lib/prompts/wireframe.ts`              | `parseHtmlDocument` (wireframe.ts)     | `wireframeHtml` (fanout substep `screens`) | `wireframeFiles` |

Future slugs (added in later milestones):

- `phase2.diff_summary` (M12) — generates 1-2 sentence diff summaries for the
  changelog History panel. Pairs with a TBD parser; output is plain text.
- `research.outline`, `research.section_detail`, etc. (M13) — research-report
  pipeline prompts; pair with parsers under `src/lib/parsers/research-report/`.

---

## 3. Domain vocabulary inventory

Every domain term that appears **literally** in prompt text. Renaming any of
these means editing the prompt files listed; the code does not care.

| Term                  | Where it appears (prompt files)                                                                                | Notes                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Project Contract**  | phase1.first_message, phase1.conversation, phase1.validate, phase2.workflow_discovery, phase2.drift_check, etc. | The headline artifact. Renaming requires updating few-shot examples. |
| **Goal Statement**    | phase1.first_message (system + few-shot), parser: `parseContract` looks for `## Goal Statement` literal       | Section header inside the contract.                                  |
| **Persona** / **Personas** | phase1.first_message, phase2.workflow_detail, phase2.drift_check (NEW_PERSONA classification)             | Section header + drift-type literal.                                 |
| **Entity Map** / **entity** | phase1.first_message, phase2.workflow_detail, phase2.dummy_data, phase2.drift_check (NEW_ENTITY)         | Section header + drift-type literal.                                 |
| **Boundaries**        | phase1.first_message, phase2.drift_check (BOUNDARY_VIOLATION)                                                  | Section header + drift-type literal.                                 |
| **Workflow**          | phase2.workflow_discovery, phase2.workflow_detail, phase2.screen_extract, phase2.nav_validate, phase2.conversation (workflow_change scope) | Bulleted step lists; "Pre-conditions / Steps / Exit criteria / Edge cases" sections. |
| **Screen**            | phase2.screen_extract, phase2.nav_validate, phase2.screen_correct, phase2.conversation (screen_only scope), phase2.wireframe_shell, phase2.screen_html | Bulleted lists; lowercase kebab-case ids. |
| **Workflow Map**      | Section header in formatted output (`formatWorkflowMap`). Parser doesn't read it; renaming is safe.            |                                                                       |
| **Screen Inventory**  | Section header in formatted output (`formatScreenInventory`). The wireframe step parses this back via `parseScreenInventoryDoc` looking for `## \`<id>\`` headers. | Renaming the title is fine; the screen-id heading format must stay.   |

A literal renaming protocol — say, "persona" → "user role":

1. `grep -ri "persona" src/lib/prompts/` — all hits in system text or few-shots.
2. Update each hit to "user role" (or whatever).
3. Check `parseContract` — it looks for `## Personas` literal. Update it to
   `## User Roles` and update the formatter that produces the contract to
   match.
4. Update `phase2.drift_check`'s `NEW_PERSONA` enum if you want the drift
   classification to use the new vocabulary in the user-facing reason text.
   (The enum string itself can stay — that's an internal id, not user-facing.)
5. No code outside `prompts/` and `parsers/contract.ts` should need changes.

---

## 4. Renaming playbook (short version)

For renaming any domain term:

1. **Find** every prompt file that mentions it (`grep -ri "<term>" src/lib/prompts/`).
2. **Update** the prompt text and few-shot examples.
3. **Check the paired parser** — if the term appears as a literal markdown
   header (e.g., `## Goal Statement`) the parser will fail. Update both the
   parser and any formatter (`format-helpers.ts`) that produces the same
   header text.
4. **Update the slot label** in the relevant `PipelineConfig` if the term is
   the user-facing name of an artifact (e.g., the slot's `label` field). The
   slot id (the dictionary key) is internal; you don't need to change it.
5. **Smoke test**: run `npm run dev`, make sure a fresh session through to
   wireframe still works.

If any code outside `src/lib/prompts/`, `src/lib/parsers/`, or
`src/lib/pipeline/configs/` needs to change for a rename, file an issue —
that's a framework leak.

---

## 5. Adding a new step playbook

Adding a step to an existing pipeline:

1. **Author the prompt**. Add the system text and any few-shot examples to a
   per-pipeline file (`src/lib/prompts/phase2.ts` or similar). Add the slug
   to the `PromptSlug` union and the `REGISTRY` map.
2. **Author the parser** in `src/lib/parsers/`. Pair it with the prompt
   format. Export it from the parsers barrel.
3. **Add the step** to the pipeline config:
   ```ts
   {
     id: stepId("my-new-step"),
     phase: phaseId("design"),
     label: "My New Step",
     scope: "What this step decides — a one-liner so the review-chat classifier knows when this is the first-impact step.",
     dependsOn: [STEP_WORKFLOW],            // or [] for an opening step
     produces: [SLOT_MY_NEW_OUTPUT],        // add the slot to `slots` too
     gate: "review",                        // or "auto" / "terminal"
     runner: { kind: "single", prompt: "phase2.my_new_step", buildUserMessage: ..., parser: ... },
   }
   ```
4. **Add the output slot** to `config.slots` with kind / label / fileBaseName.
5. **No engine, storage, or UI changes**. The engine reads the new step from
   config; the UI renders the new tab from `config.slots`; the storage layer
   keys by slot id.

If anything else needs to change to add a step, the framework has a leak.

---

## 6. Adding a new pipeline playbook

Adding an entirely new domain pipeline (e.g., research-report):

1. **Create the prompts file** at `src/lib/prompts/<pipeline-name>.ts`. Author
   all prompts. Register slugs in the `PromptSlug` union and `REGISTRY`.
2. **Create the parsers folder** at `src/lib/parsers/<pipeline-name>/`. Author
   parsers paired with prompts. Export them from a per-pipeline barrel.
3. **Create the config** at `src/lib/pipeline/configs/<pipeline-name>.ts`.
   Define phases, slots, steps, drift anchor, initial step, review-chat
   classifier.
4. **Register the config** in the pipeline picker (M13). Add the pipeline id
   to `Session.pipelineId` consumers.
5. **Run end-to-end** — verify the engine + UI works for the new pipeline.
   The whole point is that this should require **only** changes in steps 1-4.

The M13 milestone validates that this works by adding a `research-report`
pipeline with the same engine and UI hosting it.

---

## 7. Cheat sheet — what NOT to do

- ❌ Don't put domain vocabulary in `src/lib/pipeline/engine.ts` or
  `src/components/`. The framework should be able to host any domain.
- ❌ Don't hard-code prompt slugs in operations. Operations call
  `getPrompt(slug)` with the slug from the config.
- ❌ Don't add `if (pipelineId === "prd-builder")` branches anywhere. If two
  pipelines need different behavior, they need different config entries —
  not different code paths.
- ❌ Don't bypass the parser to extract data from raw model output. If you
  need new data, change the prompt + parser.
- ❌ Don't write per-pipeline UI components. Components render from config.

If you find yourself wanting to do any of these, stop and rethink the
abstraction.
