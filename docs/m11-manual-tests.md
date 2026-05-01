# Manual Test Guide — M11

Slot-keyed storage + lifecycle cut. **Breaking change** — pre-M11 session
JSONs are not readable. The `data/sessions/` directory was cleared at the
M11 cut.

Run on branch `M11-slot-storage-and-lifecycle`.

## What changed in M11

- **`Session.documents` + `Session.wireframe` → `Session.slots`**. Sessions
  now hold an opaque slot map keyed by ids declared in
  `PipelineConfig.slots`. There are no more named-document fields.
- **`Phase` 9-string union → `SessionLifecycle` tagged union**:
  `{ kind: "phase1" | "phase1_complete" | "running" | "review" | "complete", stepId? }`.
  The hand-rolled TRANSITIONS map is gone; valid transitions are derived
  from the pipeline DAG.
- **`IStorage` collapses to four generic methods**: `setSlot`, `clearSlot`,
  `setState`, `setSuspendedSnapshot`. The seven document-/wireframe-/phase-
  specific writers are gone.
- **SSE events renamed**: `document` → `slot`, `document_delta` → `slot_delta`,
  `wireframe_ready` + `wireframe_cleared` are subsumed into `slot` /
  `slot_cleared`, `phase` → `state`. Every event carries a slot id (a
  string), not a hard-coded enum.
- **`session.contractSnapshot` is gone**. The rollback equivalence check
  uses `suspended.anchorAtRollback` (frozen on rollback, never overwritten).
- **UI components are config-driven**: `DocumentPanel` derives tabs from
  `PipelineConfig.slots`; `PhaseIndicator` derives the chip strip from
  `PipelineConfig.phases`/`steps`; `ChatPanel` reads `StepConfig.reviewPlaceholder`;
  approve labels come from `StepConfig.approveLabel`. Adding a step to
  the config now adds a chip, a tab, and an approve action without UI edits.
- **Storage file version bumped to 2**. Any pre-M11 JSON in `data/sessions/`
  fails to load with a clear error.

## What stays on legacy code

Nothing in the storage, SSE, or UI paths. Phase 1 free-form contract chat
still runs through `SessionManager.handlePhase1Chat` (it's not a producer
step) but it now reads/writes via slot accessors.

## Prereqs

```bash
git pull
git checkout M11-slot-storage-and-lifecycle
npm install
rm -f data/sessions/*.json   # clean dev state
npm run dev
```

## Verification (no LLM calls)

```bash
npm run typecheck       # passes clean
npm run test:pipeline   # 30/30 pass
npm run build           # production build succeeds
```

## Test 1 — Happy path on the new shape

1. New session → `I want to build a simple todo app` → contract drafts in.
2. Click **Done — Validate & Complete Phase 1**. Phase 2 design runs,
   then the wireframe stage runs.
3. Approve at each review gate. End at **Complete**.
4. Open `data/sessions/<id>.json`. Confirm:
   - Top-level `state` is `{ "kind": "complete" }`.
   - Top-level `slots` is a map keyed by `projectContract`, `workflowMap`,
     `screenInventory`, `wireframeData` (json), `wireframeFiles` (fileset).
   - There is no `documents`, `wireframe`, `phase`, or `contractSnapshot`
     field anywhere.
5. In dev tools network tab, watch the SSE stream. Events are
   `slot` / `slot_delta` / `slot_cleared` / `state` / `meta` / `progress`.
   No `document` / `document_delta` / `wireframe_ready` / `wireframe_cleared` /
   `phase` events.

## Test 2 — Rollback + restore (unchanged contract)

1. From any Phase 2 review (workflow, screen, or wireframe), click
   **Roll back to Phase 1**.
2. Click Done immediately without editing the contract.
3. Expect: `Restored your previous Phase 2 work — the contract is unchanged.`
4. Walk through Approve at each review state. No LLM calls — each Approve
   transitions state in <100ms (the `phase2.skip` progress note appears).

## Test 3 — Rollback + edit contract (regenerate)

1. From any Phase 2 review, roll back to Phase 1.
2. Edit the contract (e.g., "add a mood board entity tied to user profile").
3. Click Done.
4. Expect: Phase 2 regenerates from scratch (workflow stage runs anew with
   the updated contract). The "Restored" message does NOT appear.

## Test 4 — Cascades (4 firstImpactStepId values)

At wireframe review, run each of these and verify the right cascade fires:

- `add a new workflow for sharing a board with a friend` → workflow rewind,
  ends back at workflow review.
- `add a settings screen with theme preferences` → screen rewind, ends
  back at screen review.
- `make the task names a bit shorter in the sample data` → data patch in
  place; HTML preserved; stays at wireframe review.
- `change the home screen layout to use a card grid` → fanout single-item
  regen on `home.html`; other screens preserved; stays at wireframe review.

## Test 5 — Persistence across reload

1. Mid-session (any state), refresh the browser page.
2. Expect: chat history, all slots, and the lifecycle state restore exactly.
   Approve buttons appear in the right places.

## Test 6 — Pre-M11 session JSONs are rejected

1. If you happen to have a pre-M11 JSON file kicking around, drop it in
   `data/sessions/`.
2. Refresh the session list.
3. Expect: a server error like `Session <id> was written with file version
   1, expected 2. M11 changed the storage shape — clear data/sessions/ to
   start fresh.` Acceptable behavior — no migration code by design (clean
   break per the M11 plan).

## Known limitations

- Iteration on `complete` is still blocked (M12 unblocks it).
- Cascade-preview gate (Confirm/Cancel before running) lands in M12.
- Inter-version changelog lands in M12.
