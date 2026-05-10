# Chapter 09 — Pipeline implementations

Last touched: 2026-05-09 (M13).

This chapter describes the two pipelines that ship today. Read it for
worked examples of how the abstractions in chapters 02-05 fit together.

## §9.1 PRD-builder pipeline

File: `src/lib/pipeline/configs/prd-builder.ts`. Id: `"prd-builder.v1"`.

Domain: chat-driven product definition. One sentence → clickable
HTML wireframe.

### §9.1.1 Phases

| Phase id | Label | Steps |
|---|---|---|
| `phase1` | Phase 1 - Contract | (none — Phase 1 is special-cased outside the engine) |
| `design` | Phase 2 - Design | `workflow`, `screen` |
| `wireframe` | Phase 2 - Wireframe | `wireframeData`, `wireframeHtml` |

### §9.1.2 Slots

| Slot id | Kind | Label | File base name | Notes |
|---|---|---|---|---|
| `projectContract` | markdown | Project Contract | `project-contract.md` | Drift anchor; interactive slot (Phase 1 chat edits this) |
| `workflowMap` | markdown | Workflow Map | `workflow-map.md` | |
| `screenInventory` | markdown | Screen Inventory | `screen-inventory.md` | |
| `wireframeData` | json | Sample Data | `wireframe/data.js` | Internal — not a UI tab; used by wireframeHtml |
| `wireframeFiles` | fileset | Wireframe | (folder: `wireframe/`) | Iframe-rendered |

### §9.1.3 Steps

#### `workflow` (compose, gate=review)
- Substeps: `discovery` (single, prompt `phase2.workflow_discovery`) +
  `detail` (fanout over discovered stubs, prompt
  `phase2.workflow_detail`).
- Reduce: `formatWorkflowMap(detailed)` → markdown.
- Approve label: "Approve → Generate Screens".

#### `screen` (compose, gate=review)
- Substeps: `extract` (single, prompt `phase2.screen_extract`) +
  `validate` (single, prompt `phase2.nav_validate`) + `correct`
  (single, prompt `phase2.screen_correct`, skipped if validate ok).
- Reduce: `finalizeScreenList` + `formatScreenInventory` → markdown.
- Approve label: "Approve → Generate Wireframe".

#### `wireframeData` (single, gate=auto)
- Prompt `phase2.dummy_data` → JSON shape per the screen inventory.
- Reduce: `makeJson(parsed)`.

#### `wireframeHtml` (compose, gate=review)
- Substeps: `shell` (single, prompt `phase2.wireframe_shell` —
  index.html) + `screens` (fanout over screen inventory, prompt
  `phase2.screen_html` — one HTML file per screen).
- `shell` substep is skipped when `ctx.target` is set (single-screen
  regen reuses the existing index.html).
- Reduce: assembles fileset (`index.html` + `data.js` + per-screen
  HTML) and runs `runWireframeSmokeTest` to catch broken hrefs / missing
  files before persistence.
- Approve label: "Approve → Mark Complete".

### §9.1.4 Drift anchor + interactive slot

```ts
driftAnchor: SLOT_PROJECT_CONTRACT,
ui: {
  initialChatPlaceholder: "e.g. I want to build a simple todo app",
  interactiveSlot: SLOT_PROJECT_CONTRACT,
},
```

### §9.1.5 Review chat config

- `prompt`: `"phase2.conversation"` — the PRD-tuned classifier.
- `parser`: `classifyReviewChat` (private wrapper around
  `parsePhase2Conversation` with `KNOWN_STEP_IDS = [workflow, screen,
  wireframeData, wireframeHtml]`).
- `driftPrompt`: `"phase2.drift_check"`.
- `driftParser`: `parseDriftCheck`.
- `buildSystemContext(slots)`: appends `<project_contract>` +
  `<workflow_map>` + `<screen_inventory>` + (conditional)
  `<wireframe_state>` blocks.

### §9.1.6 Stage runners (PRD-only)

PRD has hand-tuned stage wrappers in `src/lib/session-manager/`:
- `workflow-stage.ts` — `runWorkflowStage`. Translates engine substep
  events into `phase2.workflow_discovery` + `phase2.workflow_detail` op
  names with the "N/M workflows detailed" ticker.
- `screen-stage.ts` — `runScreenStage`. Same pattern; ops are
  `phase2.screen_extract`, `phase2.nav_validate`,
  `phase2.screen_correct`, `phase2.screen_inventory`.
- `wireframe-stage.ts` — `runWireframeStage`. Runs the wireframeData
  step (auto gate) AND the wireframeHtml step (review gate) in one
  call. Ops include `phase2.dummy_data`, `phase2.wireframe_shell`,
  `phase2.screen_html`, `phase2.wireframe_html`.

Why are these PRD-specific? Two reasons:
1. The legacy SSE op vocabulary the chat panel renders as polished
   tickers depends on these specific op names.
2. The wireframe stage spans two pipeline steps (data + html), and the
   "auto-then-review" pattern is hard-coded in this wrapper.

### §9.1.7 Cascade dispatcher (PRD-only)

`src/lib/session-manager/phase2-cascade.ts`. Dispatches by
`firstImpactStepId`:
- `workflow` → mark workflowMap + screenInventory + wireframeFiles +
  wireframeData for regen, run workflow-stage.
- `screen` → mark screenInventory + wireframeFiles + wireframeData
  for regen, run screen-stage.
- `wireframeData` → patch in place. Re-run wireframeData step;
  regenerate `data.js` inside the existing fileset; preserve HTML
  files. Stay at review:wireframeHtml.
- `wireframeHtml` with item id → regen one fanout item; patch the
  matching `<id>.html` in the fileset; preserve the rest.
  wireframeHtml without item id → mark wireframeFiles + wireframeData
  for regen, run wireframe-stage from scratch.

The `data_only` and `screen_only +target` patches are why PRD has its
own cascade dispatcher. The generic dispatcher would do full re-runs.

### §9.1.8 Phase 1 (PRD-specific)

PRD's Phase 1 is the question/edit chat-driven contract editor. Lives
outside the engine in `op-1-0-first-message`, `op-1-1-conversation`,
`op-1-2-validate`. The session manager calls these directly when
`pipelineId === "prd-builder.v1"`.

The op-1-* files import `PRD_SLOT_IDS.projectContract` directly —
they're intentionally PRD-coupled. For other pipelines the manager
uses a different code path (chapter 06 §6.3).

## §9.2 Research-report pipeline

File: `src/lib/pipeline/configs/research-report.ts`. Id:
`"research-report.v1"`.

Domain: research report drafting. Topic + scope → polished markdown
report.

### §9.2.1 Phases

| Phase id | Label | Steps |
|---|---|---|
| `brief` | Phase 1 - Brief | (none — Phase 1 captures the brief verbatim) |
| `draft` | Phase 2 - Draft | `outline`, `sections` |
| `finalize` | Phase 2 - Finalize | `edit` |

### §9.2.2 Slots

| Slot id | Kind | Label | File base name |
|---|---|---|---|
| `brief` | markdown | Research Brief | `research-brief.md` |
| `outline` | markdown | Outline | `outline.md` |
| `sections` | markdown | Section Drafts | `section-drafts.md` |
| `finalReport` | markdown | Final Report | `final-report.md` |

All markdown. No json or fileset.

### §9.2.3 Steps

#### `outline` (single, gate=review, modelRole=reasoning)
- Prompt: `research_report.outline`.
- Input: `<brief>`, optional `<existing_outline>` (from
  `priorOutputs`), `<change_history>`, `<user_feedback>`.
- Parser: `parseOutline` → `OutlineSection[]` from
  `## <id> — <title>` headers + purpose paragraphs.
- Format: `formatOutline(sections)` → markdown.
- Approve label: "Approve → Draft Sections".

#### `sections` (fanout over outline items, gate=review,
modelRole=reasoning)
- Prompt: `research_report.section_draft`.
- Items: parsed outline sections. itemId = section id.
- Input per item: `<brief>`, `<outline>`, `<section>` block (id +
  title + purpose), plus `<change_history>` / `<user_feedback>`.
- Parser: `parseSection` → trimmed string body.
- Reduce: concat with `## <title>` headers between sections.
- Approve label: "Approve → Polish Final Report".

#### `edit` (single, gate=review, modelRole=reasoning)
- Prompt: `research_report.edit`.
- Input: `<brief>`, `<sections>`, optional `<existing_final_report>`,
  `<change_history>`, `<user_feedback>`.
- Parser: trivial (`(text) => ok(text.trim())`).
- Approve label: "Approve → Mark Complete".

### §9.2.4 Drift anchor + interactive slot

```ts
driftAnchor: SLOT_BRIEF,
ui: {
  initialChatPlaceholder: "e.g. The economic impact of remote work on mid-sized US cities (2020-2025)",
  interactiveSlot: SLOT_BRIEF,
},
```

### §9.2.5 Review chat config

- `prompt`: `"research_report.review_chat"` — research-report-tuned
  classifier with examples for outline / section / edit changes.
- `parser`: `classifyReviewChat` (same private wrapper, with
  `KNOWN_STEP_IDS = [outline, sections, edit]`).
- `driftPrompt`: `"research_report.drift_check"` — brief-anchored
  drift check.
- `driftParser`: `parseDriftCheck` (the result shape is identical to
  PRD's, so the parser is shared).
- `buildSystemContext(slots)`: appends `<brief>` + (conditional)
  `<outline>`, `<sections>`, `<final_report>` blocks.

### §9.2.6 Stage runner (generic)

Research-report uses `generic-stage.ts` (chapter 06 §6.12) — no
hand-tuned wrappers. Progress events are
`research-report.v1.<stepId>` and
`research-report.v1.<stepId>.<substepId>` (for the sections fanout).

### §9.2.7 Cascade dispatcher (generic)

`generic-cascade.ts` (chapter 06 §6.13). Pure rewind-from-step. No
patch-in-place. Single-section regen still works in the sense that the
fanout's `target` is forwarded — but unlike PRD, all sections actually
re-run; only the targeted section gets the user's specific feedback
applied (others get regenerated from outline + brief without
feedback).

To optimize: parse the prior `sections` markdown into per-section
bodies, populate `priorResults`, pass through `runStepStage`. Deferred
work.

### §9.2.8 Phase 1 (generic)

For research-report, Phase 1 is the simplest possible:
- First message → `seedInteractiveSlot` writes the brief slot
  verbatim. No LLM extraction.
- Phase 1 chat → same `seedInteractiveSlot` (each message replaces
  the brief). If state is `phase1_complete`, transitions back to
  `phase1` (re-validation needed).
- Validate → auto-PASS. Emits `validation_result` PASS, sets state to
  `phase1_complete`.

The generic Phase 1 path is in `manager.ts`:
- `startSession` non-PRD branch → `seedInteractiveSlot`.
- `handlePhase1Chat` non-PRD branch → `seedInteractiveSlot`.
- `completePhase1` non-PRD branch → emit auto-PASS,
  setState(`phase1_complete`), then `runStepStage(initialStep)`.

This is the minimum viable Phase 1. Pipelines that need a richer
Phase 1 (clarifying questions, multi-message brief assembly) would
need their own ops.

### §9.2.9 No fileset / iframe

Research-report's Final Report is markdown. The iframe-based
`/api/wireframe/...` route returns 404 for sessions whose pipeline has
no fileset slot. The `WireframeViewer` component checks
`pipeline.slots.find(s => s.kind === "fileset")` and renders nothing
when absent. The `DocumentPanel` only mounts WireframeViewer when the
active tab IS a fileset slot — research-report's tabs are all
markdown, so the iframe never mounts.

### §9.2.10 Export

The export route (`/api/export/[sessionId]`) iterates
`pipeline.slots` and emits one file per markdown slot using
`fileBaseName`. Research-report's export ZIP contains:
- `research-brief.md`
- `outline.md`
- `section-drafts.md`
- `final-report.md`

Plus the `-v<n>.zip` suffix when `pipelineVersion > 1`.

## §9.3 Comparing the two

| Concern | PRD | Research-report |
|---|---|---|
| Phase 1 | LLM-driven contract editor (3 ops) | Brief verbatim + auto-PASS |
| First message slot | Drafted contract (LLM) | User's text (no LLM) |
| Stage runner | Hand-tuned (workflow / screen / wireframe) | Generic |
| Cascade dispatcher | Hand-tuned (4 impact handlers, patch-in-place) | Generic (rewind only) |
| Single-item regen | Yes (per-screen wireframe) | Forwards target but re-runs all items |
| Fileset / iframe | Yes (wireframe HTML) | No (markdown only) |
| Drift prompt | `phase2.drift_check` | `research_report.drift_check` |
| Review-chat prompt | `phase2.conversation` | `research_report.review_chat` |
| modelRole | Inherited (no overrides) | Explicit `reasoning` per step |
| Steps | 4 | 3 |
| Slots | 5 | 4 |

The research-report pipeline is intentionally minimal. It exists to
prove the framework's genericity, not to be a polished product. The
lessons learned about what's missing (richer Phase 1, single-item
fanout regen, per-pipeline progress UI hooks) should inform the next
generation of pipelines.
