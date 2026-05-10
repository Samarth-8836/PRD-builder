# Manual Test Guide — M13

Multi-pipeline + per-step `modelRole` + pipeline picker. The genericity
proof: the same engine + UI + storage + cascade machinery now hosts a
second pipeline (research-report: outline → sections → edit) alongside
PRD-builder.

Run on branch `M13-multi-pipeline-and-domain-prompts`.

## What changed

### Foundation
- `Session.pipelineId: string` field added. `createSession` defaults to
  `"prd-builder.v1"` for the legacy single-pipeline flow. Existing
  session JSONs without the field get auto-defaulted on read (no
  storage version bump).
- `SessionSummary.pipelineId` exposed for the sidebar.
- New pipeline registry at `src/lib/pipeline/configs/index.ts` exporting
  `PIPELINES`, `REGISTERED_PIPELINES`, `DEFAULT_PIPELINE_ID`,
  `getPipeline(id)`, `tryGetPipeline(id)`.

### Research-report pipeline (new)
- `src/lib/pipeline/configs/research-report.ts` — outline (single,
  review) → sections (fanout, review) → edit (single, review).
- `src/lib/prompts/research-report.ts` — outline / section_draft / edit
  / review_chat / drift_check prompts with research-report-specific
  few-shot examples.
- `src/lib/parsers/research-report.ts` — outline + section parsers.
- Phase 1 for research-report is "first message becomes the brief"
  (verbatim, no LLM extraction). Validate auto-PASSes.

### Generic stage runner + cascade (new, used by research-report)
- `src/lib/session-manager/generic-stage.ts` (`runStepStage`) — drives
  any pipeline step through `engine.runStep`, persists every produced
  slot, fires diff summaries, transitions state by gate. Walks
  auto-gated steps until a review or terminal.
- `src/lib/session-manager/generic-cascade.ts` (`runGenericCascade`) —
  rewind-from-step + re-run downstream. No patch-in-place magic.
- PRD pipeline keeps its existing hand-tuned stage runners
  (`workflow-stage.ts`, `screen-stage.ts`, `wireframe-stage.ts`,
  `phase2-cascade.ts`) for the legacy SSE op vocabulary.

### Pipeline-aware manager
- `manager.ts` now uses `pipeline.driftAnchor` instead of
  `PRD_SLOT_IDS.projectContract`, `pipeline.initialStep` instead of
  hardcoded `PRD_STEP_IDS.workflow`. Approve walks steps generically via
  `engine.nextRunnableStep` with skip-when-populated for restore.
- Stage + cascade dispatch by `session.pipelineId`: PRD path → existing
  hand-tuned runners; other pipelines → generic.
- Phase-1 dispatch by pipeline: PRD uses `runFirstMessage` /
  `runConversation` / `runValidate`; non-PRD uses
  `seedInteractiveSlot` + auto-PASS validate.

### `ReviewChatConfig.buildSystemContext`
- New optional config function each pipeline implements to inject its
  populated artifacts into the review-chat classifier's system prompt
  (PRD's `<project_contract>` + `<workflow_map>` + `<screen_inventory>`
  + `<wireframe_state>`; research-report's `<brief>` + `<outline>` +
  `<sections>` + `<final_report>`). `op-2-9-conversation.ts` is now
  pipeline-aware via this hook.
- `runDriftCheck` accepts a `promptSlug` param so the manager can pass
  `pipeline.reviewChat.driftPrompt`.

### `StepConfig.modelRole` honored
- `engine.runStep` now forwards `step.modelRole` to the runners; the
  runners forward to `execute({role})`; `streamCompletion({role})` calls
  `resolveModel(role)`.
- `resolveModel(role)` reads `OPENROUTER_FAST_MODEL` /
  `OPENROUTER_REASONING_MODEL` (and the GROQ equivalents). Falls back to
  the unsuffixed `OPENROUTER_MODEL` / `GROQ_MODEL` so legacy single-
  model setups keep working unchanged.
- The summarize prompts (chat_window, changelog_window, diff_summary)
  benefit from `role: "fast"` if the env var is set.

### Pipeline picker UI
- New `PipelinePicker.tsx` modal shown when the user clicks
  "+ New session" in the sidebar.
- Lists every registered pipeline with its label + step count + first-
  phase hint + `initialChatPlaceholder` example.
- Picker selection sets `useSessionStore.draftPipelineId`. The chat
  panel uses it for placeholder + review-step labels until the first
  message creates the session, then `current.pipelineId` takes over.
- `SessionSidebar` shows each session's pipeline label as a sub-line.

### UI components — pipeline-driven
- `DocumentPanel`, `PhaseIndicator`, `ChatPanel`, `WireframeViewer`,
  `CascadePreviewBanner` no longer import `PRD_PIPELINE` directly. Each
  resolves the pipeline from `current?.pipelineId` (or
  `draftPipelineId` for ChatPanel pre-creation) via
  `tryGetPipeline(...)`.
- API routes `/api/export/[sessionId]` and
  `/api/wireframe/[sessionId]/[...path]` look up the session's pipeline
  and use its slots. PRD's wireframe iframe path stays backwards
  compatible because PRD still exposes a fileset slot.

## What stays unchanged

- PRD pipeline's behavior end-to-end. The PRD path still uses
  `phase2.conversation` + `phase2.drift_check` + `runWorkflowStage` /
  `runScreenStage` / `runWireframeStage` / `runPhase2Cascade`. Old
  session JSONs continue to load (pipelineId defaults to PRD).
- Engine + slot storage + state machine + ChangeLog + sliding-window
  summarization + HistoryPanel + iterate-on-complete — all generic
  already, no changes needed.

## Verification (no LLM calls)

```bash
npm run typecheck       # clean
npm run test:pipeline   # 30/30 pass
npm run build           # production build succeeds
```

## Test 1 — PRD path still works (regression check)

1. `npm run dev`. Open the app.
2. Click `+ New session` → picker appears. **PRD Builder** is
   pre-selected. Click **Start**.
3. Sidebar shows the picker hint banner ("New session pipeline: PRD
   Builder"). Chat placeholder shows the PRD example.
4. Type a one-line product idea. Run end-to-end:
   - First message → contract drafted → `Done` validates → workflow
     stage → review → approve → screen review → approve → wireframe
     review → approve → complete.
5. Try one cascade in any review state. Confirm it runs.
6. Open History panel. Entry visible with diff summaries.
7. Export ZIP → filename + contents look correct.
8. Sidebar entry shows **PRD Builder** as the sub-line.

## Test 2 — Research-report end-to-end (genericity proof)

1. Click `+ New session` → picker → choose **Research Report** → Start.
2. Sidebar banner says "New session pipeline: Research Report". Chat
   placeholder is the research-report example.
3. Type a research topic, e.g. *"The economic impact of remote work on
   mid-sized US cities (2020-2025). Audience: policy researchers and
   city planners. Focus on changes in employment, commercial real
   estate, and downtown vibrancy. Out of scope: rural areas, large
   coastal metros, international comparisons."*
4. Expect:
   - The brief appears verbatim in the **Research Brief** tab.
   - An assistant ack message confirms capture.
   - Click **Done — Validate & Complete Phase 1**: validation auto-
     PASSes (no LLM call), state moves to phase1_complete, then engine
     runs the **outline** step.
5. Outline streams in. Review state lands at `review:outline`. The
   chip strip shows `Phase 1 ✓ / Phase 2: Outline ●`.
6. (Optional) Send a question: *"Why did you start with framing rather
   than methodology?"* — expect a question-mode answer (no preview
   banner).
7. Send a change: *"Add a section on second-order effects on commercial
   real estate before the conclusion."* → drift COMPATIBLE → preview
   banner appears (first impact: Outline; affects Outline). Click
   Confirm → cascade runs, outline regenerates, review:outline.
8. Approve → engine fans out to draft each section. Review at
   `review:sections` once all sections complete.
9. Send a section-level change: *"In the methodology section, can you
   say more about which data sources you'd use and any limitations?"*
   → preview banner shows first_impact_step: sections, first_impact_item:
   methodology. Confirm → only that section regenerates.
10. Approve → edit step polishes the report. Review at `review:edit`.
11. Approve → complete state. Header chip stays at v1 unless you ran
    iterations on a locked session. Open History panel — entries with
    per-slot diff summaries visible.
12. Export → ZIP filename includes the report slug; contents are
    `research-brief.md`, `outline.md`, `section-drafts.md`,
    `final-report.md`.

## Test 3 — modelRole env-var override (optional, requires LLM call)

1. Set in `.env.local`:
   ```
   OPENROUTER_FAST_MODEL=<some other free model id>
   OPENROUTER_REASONING_MODEL=<your normal model>
   ```
   (Or use `OPENROUTER_MODEL` as the catch-all if you don't want
   per-role split.)
2. Trigger a cascade in any session — the post-hoc diff summary call
   uses `role: "fast"` and should hit `OPENROUTER_FAST_MODEL`.
3. Trigger a stage runner (e.g., approve at workflow review) — the step
   uses `role: "reasoning"` (the default for research-report's outline /
   sections / edit; PRD's steps don't override) and should hit
   `OPENROUTER_REASONING_MODEL`.
4. Verify by setting two distinct model ids and observing the API logs
   on the provider side. There's no in-app indicator.

## Test 4 — Sidebar identifies session pipelines

1. Create one PRD session and one research-report session.
2. Sidebar should show:
   - PRD session → sub-line **PRD Builder**.
   - Research session → sub-line **Research Report**.
3. Click between them — chat + document panels should swap to reflect
   each session's pipeline (PRD shows the legacy phases; research-report
   shows brief / outline / section drafts / final report).
4. Refresh the page. Both sessions reload with their pipelines.

## Test 5 — Picker UX edge cases

1. `+ New session` → Picker → **Cancel** → picker closes, no draft set.
2. `+ New session` → pick **Research Report** → without typing, click
   `+ New session` again and choose **PRD Builder** → draft updates.
   First message creates a PRD session.
3. After picking research-report, click an existing PRD session in the
   sidebar → draft is cleared, the active session takes over.

## Known limitations

- Research-report's Phase 1 is a one-shot brief capture. The user can
  refine the brief by sending additional Phase 1 messages (each replaces
  the brief slot wholesale), but there's no PRD-style question/edit
  classifier — every message is treated as a brief replacement until
  Done is clicked.
- Research-report's drift check is brief-anchored. If the user wants to
  expand the scope, they need to roll back to Phase 1 and edit the brief
  directly.
- The generic stage runner emits `<pipelineId>.<stepId>` SSE op names
  (e.g. `research-report.v1.outline`). The progress tickers in the chat
  panel are unstyled for these — they show up as plain progress notes,
  not the polished "N/M workflows detailed" tickers PRD has.
- Research-report's Final Report tab renders as markdown. There's no
  fileset / iframe view (correct — the artifact is markdown). The
  `/api/wireframe/...` route stays PRD-only by design.
- The cascade dispatcher for research-report is the simple
  rewind-and-re-run pattern. There's no equivalent of PRD's "patch
  data.js inside the wireframe fileset" or "regenerate one screen html"
  optimizations. Single-section regen for research-report still works
  because the engine's fanout runner honors `target` / `priorResults`,
  and the generic-cascade dispatcher forwards `firstImpactItemId`.
