# Manual Test Guide — M8 + M9

What's been wired through the new pipeline engine after M9, and how to verify
nothing regressed end-to-end. Run these against `npm run dev` on the
`M9-engine-wireframe-step` branch.

## What changed in M9

- The wireframe stage now runs through `PipelineEngine.runStep` for two
  steps: `wireframeData` (single, gate=auto) and `wireframeHtml` (compose:
  shell substep + per-screen fanout substep). The compose runner produces
  the same `index.html`, `data.js`, and `<screen-id>.html` files the old
  code did. Concurrency is still 1 (free-tier safe).
- The `wireframe_review × data_only` cascade also runs through the engine
  (`engine.runStep("wireframeData")` with feedback, then patch the new
  `data.js` into the existing artifact).
- Workflow stage, screen stage, and the other cascade cells (workflow_change
  rewinds, screen_only at screen-review, screen_only+target at
  wireframe-review) still use the legacy hand-wired code. They migrate in
  M10.
- Storage shape unchanged. Old session JSONs still load. SSE event names
  unchanged.

## Prereqs

```bash
git checkout M9-engine-wireframe-step
npm install                 # if you switched branches
cp .env.local.example .env.local
# fill in OPENROUTER_API_KEY or GROQ_API_KEY
npm run dev
```

Open http://localhost:3000.

## Verification (no LLM calls)

```bash
npm run typecheck           # should pass clean
npm run test:pipeline       # 30/30 should pass
npm run build               # Next.js production build should succeed
```

If any of these fail before you've made changes, that's a bug — file it.

## Test 1 — Happy path through to complete

**Goal:** confirm the engine-driven wireframe stage produces an artifact
identical in structure to what the old code produced.

1. Click "New session" (or just go to `/`).
2. Type: `I want to build a simple todo app`.
3. Wait for the contract to draft. Read it. Click **Done — Validate &
   Complete Phase 1**.
4. Wait through "Phase 2 - Designing Workflows". You should see progress
   notes like "Discovering workflows" → "Detailing 1/N", "2/N", etc.
5. Workflow review state. Click **Approve → Generate Screens**.
6. Wait through "Phase 2 - Designing Screens". Progress notes:
   "Extracting screens", "Validating navigation", possibly "Correcting nav
   gaps".
7. Screen review state. Click **Approve → Generate Wireframe**.
8. **This is the new path.** Watch the chat panel. You should see
   progress notes in this order:
   - `Generating realistic sample data`
   - `Sample data ready (N entities)`
   - `Building index.html`
   - `Shell ready`
   - `Rendering per-screen HTML`
   - `1/N screens rendered`, `2/N screens rendered`, etc.
   - `All N screens rendered`
   - `All screens linked and reachable`
   - `Wireframe ready - click the Wireframe tab to view`
9. Click the **Wireframe** tab. Iframe loads the home/index page. Click
   through each nav link — every screen should render with vanilla DOM,
   no console errors.
10. Click **Approve → Mark Complete**. Phase indicator shows "Complete".
11. Click **Export ↓**. Open the ZIP — should contain
    `project-contract.md`, `workflow-map.md`, `screen-inventory.md`, and a
    `wireframe/` folder with `index.html`, `data.js`, and one HTML per
    screen.

✅ **PASS** = wireframe is reachable, no broken links, all artifacts
exported. ❌ **FAIL** = any error toast in the chat, broken iframe link,
or missing file in the ZIP.

## Test 2 — `data_only` cascade (engine path)

**Goal:** confirm regenerating sample data via the engine preserves all
HTML files and only swaps `data.js`.

1. From a wireframe-review state (you can roll back to Phase 1 from a
   completed session and re-approve through, OR continue from Test 1 by
   rolling back from `complete` — actually `complete` is a one-way trip
   in M9, see "Known limitations" below — so just run Test 1 again and
   stop at step 9 instead of step 10).
2. In the chat panel (placeholder: "Ask about the wireframe, request a
   content tweak, or change a screen…"), type:
   `make the task names shorter and use realistic project names`
3. Watch for:
   - The drift banner appears briefly with classification COMPATIBLE.
   - Progress notes:
     - `Regenerating sample data — screen HTML will be preserved`
     - `Sample data refreshed (N entities)`
     - `Sample data updated — reload the wireframe to see the new content`
   - The wireframe tab refreshes (iframe reloads with bumped version).
4. Click **Wireframe** tab. The same screens should render but with
   different sample data (shorter task names, project names instead of
   "Task 1").
5. Right-click the iframe → Inspect → Network. Reload the iframe. Check
   that `data.js` is the only updated file (other screens still cached or
   re-served from the bumped artifact). Open the **Sources** tab to see
   `window.DATA = {…}` reflects your new content.

✅ **PASS** = HTML structure unchanged, only sample content differs.
❌ **FAIL** = any HTML re-rendered, broken layout, or "drift" toast that
shouldn't have appeared.

## Test 3 — `screen_only +target` cascade (legacy path, kept for parity)

**Goal:** confirm the legacy single-screen regen path still works (this
is NOT routed through the engine in M9 — it'll be in M10).

1. From a wireframe-review state.
2. Type something like:
   `on the home screen, group tasks by due date instead of just listing them`
   (substitute a real screen id from your inventory; check the Screen
   Inventory tab to find ids).
3. The phase2.conversation classifier should emit a `<change_context>`
   with `scope: screen_only` and `target: home` (or whichever screen).
4. Watch for:
   - `Regenerating the <id> screen — others preserved`
   - `1/1 screens regenerated`
   - `Updated <id>.html`
5. Click **Wireframe** tab → click the targeted screen. Layout should
   reflect the new instruction. Other screens should look unchanged from
   before the request.

✅ **PASS** = only the target screen is different. ❌ **FAIL** = other
screens also regenerated, or no change to the target.

## Test 4 — `workflow_change` cascade (legacy path)

**Goal:** confirm full rewind to workflow stage still works.

1. From a wireframe-review state.
2. Type:
   `I want a separate "share with a friend" workflow added`
3. Drift check should classify COMPATIBLE.
4. Cascade kicks off:
   - `Rewinding to the Workflow stage; you'll re-approve screens and the wireframe after`
   - Wireframe is cleared (Wireframe tab disappears).
   - Workflow stage runs with the feedback.
5. Phase indicator returns to "Workflow Review".
6. Approve through workflow → screen → wireframe. The new workflow
   should appear in the new artifact.

✅ **PASS** = wireframe cleared, all three stages re-run, new workflow
present. ❌ **FAIL** = any artifact carried over the cascade or stuck
phase.

## Test 5 — Error rollback

**Goal:** confirm the engine path's error rollback still goes back to
`phase2_screen_review` (not Phase 1).

This one's harder to trigger reliably without a fault injection. The
simplest way: kill your network mid-cascade during Test 1's step 8
(after step 7, when wireframe stage starts). Cmd-click "Disable cache" in
DevTools → drop into Offline. The LLM call should fail.

Expected:
- Progress note: `Wireframe smoke test failed: …` OR `Per-screen HTML
  batch failed: …`
- Phase rolls back to `phase2_screen_review`.
- Click **Approve → Generate Wireframe** again to retry.

✅ **PASS** = phase ends at `phase2_screen_review`, retry works.
❌ **FAIL** = phase rolls all the way back to Phase 1, or stays stuck
in `phase2_wireframe_running`.

## Known limitations after M9

- `complete` state is still a terminal one-way trip — typing in the chat
  there is blocked. Iteration on complete is M12.
- `screen_only +target` and `workflow_change` cascades still use legacy
  code (M10 routes them through the engine).
- Storage shape is still document-keyed (`session.documents.*`,
  `session.wireframe`). Slot storage lands in M11.
- No change-estimation preview yet (M12).
- No inter-version changelog yet (M12).

## Where to look if something breaks

- Engine logic: `src/lib/pipeline/engine.ts` (runStep, runner dispatch).
- Slot adapter: `src/lib/pipeline/adapter.ts` (sessionToSlots).
- Wireframe wrapper: `src/lib/session-manager/wireframe-stage.ts`.
- data_only cascade: `src/lib/session-manager/cascade.ts`
  (`runDataOnlyWireframeCascade`).
- Pipeline config: `src/lib/pipeline/configs/prd-builder.ts`.

If a regression bisects to the M9 engine path, the most likely culprit
is the compose runner's `reduce` function in the wireframeHtml step
(which builds the fileset) or the fanout's `itemId` (must be the screen
id, not a per-index counter).
