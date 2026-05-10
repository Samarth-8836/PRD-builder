# Chapter 11 — Adding a new pipeline

Last touched: 2026-05-09 (M13).

This is the playbook for shipping a third pipeline. The PRD pipeline
and research-report pipeline (chapter 09) are worked examples.

The acceptance criterion: **the only files modified should be NEW
files plus the registry**. If you find yourself editing the engine,
the storage layer, the runners, the UI components, or the streaming
types — the framework has a leak. Fix the abstraction first, then
come back here.

## §11.1 Decide the shape

Before writing code, answer:

1. **Domain.** What does the user produce with this pipeline? (e.g.,
   meeting notes, lesson plan, code review.)
2. **Phase 1.** Does the user need an iterative LLM-driven editor for
   the first artifact (PRD style), or is a single-message capture
   enough (research-report style)?
3. **Phase 2 steps.** What's the dependency DAG? Which steps are
   single, fanout, or compose? Which gates are review vs auto vs
   terminal?
4. **Slots.** What artifacts does each step produce? What kind
   (markdown / fileset / json)?
5. **Drift anchor.** Which slot is the locked artifact every change is
   checked against? (Usually the Phase 1 artifact.)
6. **Fileset / iframe?** Does any step produce a multi-file artifact
   that the user needs to view in an iframe? (Rare. Only PRD does this.)
7. **Cascade semantics.** Does any step need patch-in-place behavior
   (PRD's wireframeData) or single-item fanout regen (PRD's
   wireframeHtml)? Or is rewind-and-rerun (generic) enough?

If your answers are similar to research-report (simple Phase 1, all
markdown, gate=review per step, generic cascade), this is going to be
a small lift. If you need PRD-style features (LLM Phase 1 editor,
fileset, patch-in-place), expect to write some hand-tuned glue.

## §11.2 The minimal file checklist

For a basic pipeline (research-report-style, no fancy features):

### NEW
- `src/lib/pipeline/configs/<pipeline-id>.ts` — the pipeline config.
- `src/lib/prompts/<pipeline-id>.ts` — system prompts + few-shot
  examples + corrective hints for every step + drift + review-chat.
- `src/lib/parsers/<pipeline-id>.ts` — parsers for each step's output.

### MODIFIED
- `src/lib/pipeline/configs/index.ts` — import + register the new
  pipeline in `PIPELINES` and `REGISTERED_PIPELINES`.
- `src/lib/prompts/index.ts` — add new `PromptSlug` literals + import
  + register in `REGISTRY`.
- `src/lib/parsers/index.ts` — re-export `from "./<pipeline-id>"`.

That's it. No engine changes. No storage changes. No UI component
changes. No SessionManager changes (the manager dispatches by
pipelineId; non-PRD pipelines get the generic stage runner + cascade
dispatcher automatically).

For a PRD-style pipeline that needs a custom Phase 1 OR fileset OR
patch-in-place cascade, also add:
- `src/lib/operations/op-<pipeline>-*.ts` — Phase 1 ops (first
  message, conversation, validate). Mirror the op-1-* shape.
- `src/lib/session-manager/<pipeline>-cascade.ts` — custom cascade
  dispatcher. Mirror `phase2-cascade.ts`.
- Edit `manager.ts` — add a branch for the new pipelineId in
  `startSession` / `handlePhase1Chat` / `completePhase1` /
  `dispatchCascade` etc. (This is the only change that crosses the
  guard rail; it's per-pipeline dispatch, not framework code.)

## §11.3 Step-by-step: building a basic pipeline

Worked example: a hypothetical `meeting-notes.v1` pipeline.

### Step 1 — sketch the config

```ts
// src/lib/pipeline/configs/meeting-notes.ts
const SLOT_TRANSCRIPT = docSlotId("transcript");
const SLOT_SUMMARY = docSlotId("summary");
const SLOT_ACTION_ITEMS = docSlotId("actionItems");
const SLOT_FINAL = docSlotId("finalNotes");

const STEP_SUMMARIZE = stepId("summarize");
const STEP_EXTRACT_ACTIONS = stepId("extractActions");
const STEP_ASSEMBLE = stepId("assemble");

export const MEETING_NOTES_PIPELINE: PipelineConfig = {
  id: "meeting-notes.v1",
  label: "Meeting Notes",
  phases: [
    { id: phaseId("transcript"), label: "Phase 1 - Transcript", order: 0 },
    { id: phaseId("draft"), label: "Phase 2 - Draft", order: 1 },
    { id: phaseId("finalize"), label: "Phase 2 - Finalize", order: 2 },
  ],
  slots: [
    { id: SLOT_TRANSCRIPT, label: "Transcript", kind: "markdown", fileBaseName: "transcript.md", emptyMessage: "Paste your transcript to start." },
    { id: SLOT_SUMMARY, label: "Summary", kind: "markdown", fileBaseName: "summary.md", emptyMessage: "Summary will appear here." },
    { id: SLOT_ACTION_ITEMS, label: "Action Items", kind: "markdown", fileBaseName: "action-items.md", emptyMessage: "Action items will appear here." },
    { id: SLOT_FINAL, label: "Meeting Notes", kind: "markdown", fileBaseName: "meeting-notes.md", emptyMessage: "Final notes will appear here." },
  ],
  driftAnchor: SLOT_TRANSCRIPT,
  initialStep: STEP_SUMMARIZE,
  ui: {
    initialChatPlaceholder: "Paste a meeting transcript...",
    interactiveSlot: SLOT_TRANSCRIPT,
  },
  reviewChat: {
    prompt: "meeting_notes.review_chat",
    parser: classifyReviewChat,
    driftPrompt: "meeting_notes.drift_check",
    driftParser: parseDriftCheck,
    buildSystemContext: (slots) => /* inject populated slots */,
  },
  steps: [
    {
      id: STEP_SUMMARIZE,
      phase: phaseId("draft"),
      label: "Summary",
      scope: "Decisions about which themes / discussions the summary captures.",
      dependsOn: [],
      produces: [SLOT_SUMMARY],
      gate: "review",
      runner: { kind: "single", prompt: "meeting_notes.summarize", buildUserMessage: ..., parser: ..., format: ... },
      approveLabel: "Approve → Extract Action Items",
    },
    {
      id: STEP_EXTRACT_ACTIONS,
      phase: phaseId("draft"),
      label: "Action Items",
      scope: "Decisions about which action items / owners / deadlines are captured.",
      dependsOn: [STEP_SUMMARIZE],
      produces: [SLOT_ACTION_ITEMS],
      gate: "review",
      runner: { ... },
      approveLabel: "Approve → Assemble Final Notes",
    },
    {
      id: STEP_ASSEMBLE,
      phase: phaseId("finalize"),
      label: "Final Notes",
      scope: "Decisions about formatting / structure of the final notes document.",
      dependsOn: [STEP_SUMMARIZE, STEP_EXTRACT_ACTIONS],
      produces: [SLOT_FINAL],
      gate: "review",
      runner: { ... },
      approveLabel: "Approve → Mark Complete",
    },
  ],
  changelog: { autoSummarize: true, maxEntries: 200 },
};
```

### Step 2 — write the prompts

`src/lib/prompts/meeting-notes.ts` exports:
- `SUMMARIZE_SYSTEM` + `SUMMARIZE_CORRECTIVE_HINT`
- `EXTRACT_ACTIONS_SYSTEM` + `EXTRACT_ACTIONS_CORRECTIVE_HINT`
- `ASSEMBLE_SYSTEM` + `ASSEMBLE_CORRECTIVE_HINT`
- `REVIEW_CHAT_SYSTEM` + few-shot pairs + `REVIEW_CHAT_CORRECTIVE_HINT`
- `DRIFT_CHECK_SYSTEM` + few-shot pair + `DRIFT_CHECK_CORRECTIVE_HINT`

Then in `src/lib/prompts/index.ts`:
```ts
import { SUMMARIZE_SYSTEM, ... } from "./meeting-notes";

type PromptSlug = ... | "meeting_notes.summarize" | "meeting_notes.extract_actions" | "meeting_notes.assemble" | "meeting_notes.review_chat" | "meeting_notes.drift_check";

const REGISTRY = {
  ...,
  "meeting_notes.summarize": { system: SUMMARIZE_SYSTEM, correctiveHint: SUMMARIZE_CORRECTIVE_HINT },
  // etc.
};
```

### Step 3 — write the parsers

`src/lib/parsers/meeting-notes.ts` exports `parseSummary`,
`parseActionItems`, etc. Each returns a `ParseResult<T>`.
Re-export from `src/lib/parsers/index.ts`.

### Step 4 — register the pipeline

`src/lib/pipeline/configs/index.ts`:
```ts
import { MEETING_NOTES_PIPELINE } from "./meeting-notes";

export const PIPELINES = {
  ...,
  [MEETING_NOTES_PIPELINE.id]: MEETING_NOTES_PIPELINE,
};

export const REGISTERED_PIPELINES = [
  ...,
  MEETING_NOTES_PIPELINE,
];
```

### Step 5 — verify

```bash
npm run typecheck       # should be clean
npm run test:pipeline   # 30/30 still pass — unit tests don't reference your pipeline
npm run build           # production build succeeds
npm run dev             # open the app
```

### Step 6 — smoke test

1. Click "+ New session" → picker → pick **Meeting Notes** → Start.
2. Paste a transcript → click Done → engine runs Summary → review →
   approve → Action Items → review → approve → Final Notes → review →
   approve → complete.
3. Trigger a cascade in any review state.
4. Open History panel; check entries land with diff summaries.
5. Export → ZIP contains `transcript.md`, `summary.md`,
   `action-items.md`, `meeting-notes.md`.

### Step 7 — write a manual test guide

`docs/m{N}-manual-tests.md`. Mirror the M13 guide structure: explain
what the pipeline does, walk through the happy path, exercise edge
cases (drift, cascade, restore, iterate-on-complete).

## §11.4 The `buildSystemContext` block

The review-chat classifier prompt expects specific tag names in the
appended context (e.g., `<transcript>`, `<summary>`, etc.). Each
pipeline's config provides the function that produces them:

```ts
buildSystemContext: (slots) => {
  const transcript = getMarkdownContent(slots, SLOT_TRANSCRIPT) ?? "";
  const summary = getMarkdownContent(slots, SLOT_SUMMARY) ?? "";
  const actions = getMarkdownContent(slots, SLOT_ACTION_ITEMS) ?? "";
  const final = getMarkdownContent(slots, SLOT_FINAL) ?? "";

  let block = `\n\n<transcript>\n${transcript.trim()}\n</transcript>`;
  if (summary.trim().length > 0) {
    block += `\n\n<summary>\n${summary.trim()}\n</summary>`;
  }
  if (actions.trim().length > 0) {
    block += `\n\n<action_items>\n${actions.trim()}\n</action_items>`;
  }
  if (final.trim().length > 0) {
    block += `\n\n<final_notes>\n${final.trim()}\n</final_notes>`;
  }
  return block;
},
```

The few-shot examples in `REVIEW_CHAT_SYSTEM` should reference these
exact tag names so the model's pattern-matching agrees.

## §11.5 Picker UI

Picker UI is automatic — `REGISTERED_PIPELINES` drives the picker. Your
pipeline shows up the moment it's registered. The picker renders:
- `pipeline.label`
- `pipeline.id` + step count + first phase label
- `pipeline.ui?.initialChatPlaceholder` as an example

No UI changes required.

## §11.6 Per-step `modelRole`

If your pipeline has cheap classification steps (e.g., "is this an
action item?") and expensive reasoning steps (e.g., "summarize this
transcript"), declare `modelRole: "fast"` on the cheap ones. The
engine forwards to the runner → execute → resolveModel.

Set env vars:
```
OPENROUTER_FAST_MODEL=<some smaller free model>
OPENROUTER_REASONING_MODEL=<your normal model>
```

## §11.7 Common pitfalls

### Forgetting to register the prompt slug
Symptom: `Error: Unknown prompt slug: meeting_notes.summarize`.
Fix: add to `PromptSlug` union AND to `REGISTRY` in `prompts/index.ts`.

### Forgetting to set `format` on a step that produces non-markdown
Symptom: payload kind is markdown when you wanted json/fileset.
Fix: set `runner.format: (parsed) => ({ [SLOT_X]: makeJson(parsed) })`.

### `parser` returning the wrong shape for the next step's `items()`
Symptom: TypeError or silent regen of all items in a fanout.
Fix: parser must return the same shape `items()` consumes; keep the
types in sync.

### `dependsOn` includes a step that doesn't produce the slot you need
Symptom: `requireMarkdown(ctx.inputs, SLOT_X)` throws "slot not
found".
Fix: every slot you read in `buildUserMessage` must come from a step
listed in `dependsOn` (transitively).

### Phase 1 chat doesn't iterate
Symptom: Sending a Phase 1 message just replaces the brief; no
question/answer flow.
Cause: the generic Phase 1 path treats every message as a brief
replacement (chapter 09 §9.2.8).
Fix: if you want PRD-style iterative editing, implement custom Phase
1 ops and add a per-pipelineId branch in `manager.handlePhase1Chat` /
`startSession` / `completePhase1`. This crosses the genericity guard
rail — accept the trade-off.

### Cascade re-runs all fanout items even when item id is set
Symptom: User asks "change just section X" but all sections regenerate.
Cause: the generic cascade dispatcher forwards `target` but doesn't
populate `priorResults` (chapter 06 §6.13). The fanout runner falls
back to running every item.
Fix: in your cascade logic (which would have to be a per-pipeline
dispatcher), parse the prior fanout-output slot into per-item entries
and pass them as `priorResults`.

### Drift prompt mentions "contract" instead of your domain term
Symptom: drift check feels off — the model is reasoning about a
"Project Contract" when your anchor is a "Brief".
Fix: write a pipeline-specific `<pipeline>.drift_check` prompt with
your domain vocabulary. The drift check input is wrapped in
`<contract>...</contract>` regardless (engine-side stable interface),
but the system prompt can call it whatever your domain calls it.

## §11.8 The genericity test

After shipping your pipeline, ask: did I edit any of these files
(beyond the registry one-line additions)?

- `src/lib/pipeline/engine.ts`
- `src/lib/pipeline/state.ts`
- `src/lib/pipeline/slots.ts`
- `src/lib/pipeline/runners/*.ts`
- `src/lib/streaming/types.ts`
- `src/lib/storage/types.ts` or `file-storage.ts`
- Any UI component (other than `PipelinePicker.tsx` if you're
  improving the picker itself)

If yes → understand WHY. The framework should have given you the
abstraction you needed. If it didn't, fix the framework first
(generalize the abstraction), THEN come back to your pipeline.

If no → you've passed the test. The framework is generic.
