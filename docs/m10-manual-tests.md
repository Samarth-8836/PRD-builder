# Manual Test Guide — M10

What's now engine-driven and how to verify nothing regressed across the
full 9-cell cascade matrix. Run on `M10-engine-runs-all-steps`.

## What changed in M10

- **All three Phase 2 stages run through `engine.runStep`**: workflow,
  screen, wireframe. The hand-wired sequencing in the stage files is
  gone; each stage is now a thin SSE-translation adapter (~120 LOC).
- **Cascade matrix collapses to a 4-way switch on `firstImpactStepId`**.
  The old 3×3 (review-phase × scope) matrix in `cascade.ts` is replaced
  by `phase2-cascade.ts` (`runPhase2Cascade`), which dispatches by step:
  - `workflow` → rewind: clear screen + wireframe, re-run workflow stage
  - `screen` → rewind: clear wireframe, re-run screen stage
  - `wireframeData` → patch in place: regen sample data, swap data.js
    inside the existing fileset
  - `wireframeHtml` → with itemId: regen one fanout item, patch the
    fileset; without itemId: clear wireframe, re-run wireframe stage
- **Review-chat parser emits `firstImpactStepId` + `firstImpactItemId`**.
  The legacy `scope: workflow_change|screen_only|data_only` and `target`
  fields are gone. The Phase 2 conversation prompt updated with
  first-impact step ids and per-step scope hints.
- **Compose runner skips substeps based on context**: the wireframeHtml
  step's shell substep is now skipped when `ctx.target` is set
  (single-item regen case), saving an LLM call. The reduce function
  reuses the prior `index.html` from the existing fileset.
- **Drift trigger generalized**: `handlePhase2ReviewChat` is now ready
  to accept calls from `complete` state too (M12 will wire that up).
  No behavior change in M10.
- **Storage shape unchanged**. SSE event vocabulary unchanged. `Phase`
  union still in place. M11 is the breaking storage cut.

## What stays on legacy code

Nothing in the Phase 2 routing path. Phase 1 (free-form contract chat)
stays as-is — it's not a producer step.

## Prereqs

```bash
git pull
git checkout M10-engine-runs-all-steps
npm install
npm run dev
```

## Verification (no LLM calls)

```bash
npm run typecheck       # passes clean
npm run test:pipeline   # 30/30 pass
npm run build           # production build succeeds
```

## Test 1 — Happy path through to complete

Same as M9 but every stage now runs through the engine.

1. New session → `I want to build a simple todo app` → Done.
2. Workflow stage runs. Progress notes (legacy SSE op names preserved):
   - `Identifying workflows`
   - `Detailing N workflows` → `1/N detailed`, `2/N`, …
   - `Workflow Map generated`
   - `Workflows ready - review then approve to generate screens`
3. Approve → screen stage. Progress notes:
   - `Deriving screens`
   - `Validating navigation graph`
   - (if gaps) `Patching screens to close gaps`
   - `Screen Inventory generated`
4. Approve → wireframe stage. Same progress as M9.
5. Approve → Complete. Export ZIP.

✅ **PASS** = identical artifact structure, no regressions, every
progress note appears as before.

## Test 2 — Cascade matrix (9 cells, ~ a few minutes each)

The old cascade matrix is now driven by the model picking a
`firstImpactStepId`. Trigger each cell from the relevant review state
and observe the right behavior. The user-facing language hasn't
changed; trigger phrases below match prior intuition.

**At workflow_review:**

- a) `Add a recurring task workflow` → first_impact: workflow → re-runs
  workflow stage with feedback. Lands at workflow_review.
- b) `Add a separate Today screen distinct from home` → first_impact:
  screen → system note: "Screen tweaks apply once the screen list is
  generated. Click Approve to move on, then ask again."
- c) `Make sample task names shorter` → first_impact: wireframeData →
  system note: "Sample-data tweaks take effect once the wireframe is
  generated. Click Approve through the next stages first."

**At screen_review:**

- d) `Add a recurring task workflow` → first_impact: workflow → clears
  screen (and wireframe if any), rewinds to workflow stage, lands at
  workflow_review.
- e) `Add a separate Today screen distinct from home` → first_impact:
  screen → re-runs screen stage with feedback. Lands at screen_review.
- f) `Make sample task names shorter` → system note: wireframe not yet
  generated.

**At wireframe_review:**

- g) `Add a recurring task workflow` → first_impact: workflow → clears
  screen + wireframe, rewinds to workflow stage. Lands at
  workflow_review. (Walk back: Approve → screen review → Approve →
  wireframe review.)
- h) `Add a separate Today screen distinct from home` → first_impact:
  screen → clears wireframe, re-runs screen stage. Lands at
  screen_review.
- i) `On the home screen, group tasks by date` → first_impact:
  wireframeHtml + first_impact_item: home → patches `home.html` in
  place, regenerates ALL screen HTML (because today's behavior was
  "regenerate target screen + reuse others"). **Important M10 change**:
  the shell substep (index.html) is now SKIPPED during single-item
  regen (saves one LLM call per cascade). The reduce function reuses
  the existing index.html from the fileset.
- j) `Make sample task names shorter` → first_impact: wireframeData →
  patches data.js in the existing fileset. HTML files preserved
  byte-for-byte.

✅ **PASS** = each cell produces the right phase transition + artifact
update. Spot-check that single-item regen for screen X really only
regenerates `<X>.html` (other files in `data/sessions/<id>.json` should
be unchanged from before the cascade).

## Test 3 — Rollback + restore (no contract change)

Same as M9 — confirms the M9 fix carried forward.

1. Get to wireframe_review.
2. Roll back to Phase 1.
3. Click Done immediately (no contract changes).
4. Land at workflow_review with all docs restored.
5. Approve → screen_review (instant, no LLM call).
6. Approve → wireframe_review (instant, no LLM call).
7. Approve → Complete.

## Test 4 — Drift block

1. Get to any review state.
2. Type a clearly contract-violating change: `Add team collaboration so
   coworkers can share lists`.
3. Drift banner appears RED with `BOUNDARY VIOLATION`.
4. Chat textarea is locked. The only out is "Roll back to Phase 1".

✅ **PASS** = banner shows, no cascade runs, no documents change.

## Test 5 — Restored full transcript

A meta-test. Open `data/sessions/<id>.json` in a text editor after
running through tests 1–4. Verify:

- `chat[]` has reasonable user/assistant pairs.
- Assistant change-mode replies are PAST TENSE (e.g., "Updated the
  Workflow Map to include an undo flow"), not imperative ("Add an undo
  flow"). Past tense was a M9b/M10 fix in the Phase 2 conversation
  prompt.
- The contract content matches what's shown in the artifact panel.

## Known limitations after M10

- `complete` state still blocks chat input. Iteration on complete
  (M12) re-uses the same handlePhase2ReviewChat path.
- No change-estimation preview yet (M12).
- No inter-version changelog yet (M12).
- Storage shape still document-keyed. M11 lands the slot cut.

## Where to look if something breaks

- Stage adapter logic: `src/lib/session-manager/{workflow,screen,wireframe}-stage.ts`
- Cascade dispatcher: `src/lib/session-manager/phase2-cascade.ts`
- Pipeline config + step definitions: `src/lib/pipeline/configs/prd-builder.ts`
- Compose runner skip behavior: `src/lib/pipeline/runners/compose.ts`
- Review-chat prompt: `src/lib/prompts/phase2.ts` (PHASE2_CONVERSATION_*)
- Parser (firstImpactStepId/firstImpactItemId): `src/lib/parsers/phase2-review.ts`

If a regression bisects to "first_impact_step is empty/wrong/never
parsed", look first at the few-shot examples in `phase2.ts` — those are
the model's pattern source for the new format.
