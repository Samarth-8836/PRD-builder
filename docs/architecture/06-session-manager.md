# Chapter 06 — Session manager

Last touched: 2026-05-09 (M13).

The session manager is the top-level coordinator. It routes by
lifecycle state, dispatches by `pipelineId`, owns the per-session
busy lock, and translates user intent (start, send message, validate,
approve, rollback, confirm cascade) into engine + storage calls.

File: `src/lib/session-manager/manager.ts`. Class: `SessionManager`.
Singleton accessor: `getSessionManager()`.

## §6.1 The busy lock

`SessionManager.busy: Set<string>` holds session ids currently being
processed. Every public method:
1. Checks `if (this.busy.has(sessionId)) throw new SessionBusyError(...)`.
2. `this.busy.add(sessionId)`.
3. Wraps the body in `try { ... } finally { this.busy.delete(sessionId) }`.

This prevents concurrent writes for the same session. Cross-session
concurrency is fine (different sessions use different files).

The lock is in-process. If the dev server restarts mid-cascade, the
lock dies; the on-disk session is consistent because every `setSlot`
is an atomic write.

## §6.2 Routing by lifecycle

`handleMessage` is the chat-message router. Given the session's
current state:

| State | Handler |
|---|---|
| `phase1` / `phase1_complete` | `handlePhase1Chat` |
| `review:<stepId>` / `complete` | `handlePhase2ReviewChat` |
| `running:<stepId>` | throws `SessionBusyError` |

State transitions are owned by the operations themselves (validate,
approve, cascade). The manager doesn't compute next-state from a
table — each operation persists its own `setState` call.

## §6.3 Phase 1 dispatch

`handlePhase1Chat(session, message, sse, signal)`:

```ts
if (session.pipelineId === PRD_PIPELINE_ID) {
  // PRD: contract editing via op-1-1
  await runConversation({ session, userMessage: message, sse, signal });
  if (result.mode === "edit" && state === "phase1_complete") {
    setState({ kind: "phase1" }); // re-validation needed
  }
} else {
  // Other pipelines: replace the interactive slot wholesale
  await this.seedInteractiveSlot(session, message, sse);
}
```

Why not generalize? PRD's question/edit classifier + streamed contract
is heavily PRD-specific. Other pipelines that don't have an iterative
contract concept use the simpler "your message is the brief" pattern.

`seedInteractiveSlot(session, text, sse)` (private):
- Looks up `pipeline.ui?.interactiveSlot ?? pipeline.driftAnchor`.
- Calls `setSlot(slotId, { kind: "markdown", content: text, version: 0 })`.
- Emits `slot` SSE event.
- Appends an "ack" assistant message ("Got it — captured your X.
  Click Done to start generating.").

## §6.4 Phase 2 review chat — `handlePhase2ReviewChat`

The classifier-then-drift-then-preview flow:

1. `runPhase2Conversation({ session, userMessage })` → `{ mode, ... }`.
2. `clearPendingPreview(session.id)` — supersede any stale plan.
3. If `mode === "question"`: emit `assistant_message`, append to chat,
   return.
4. If `mode === "change"`:
   1. `runDriftCheck({ contract, changeDescription, promptSlug: pipeline.reviewChat.driftPrompt })`.
   2. Emit `drift` SSE event.
   3. If `DRIFT` or `FLAG`: return (no chat, no preview — banner only).
   4. If `COMPATIBLE`: `engine.previewCascade(...)`,
      `setPendingPreview(...)`, emit `cascade_preview` event.

The user's chat message is appended FIRST (in `handleMessage`) so
it's persisted no matter what. The change SUMMARY is NOT appended
yet — that happens only in `confirmCascade` (chapter §6.5).

## §6.5 Cascade preview gate — `confirmCascade` / `cancelCascade`

The pending preview is held in-memory in `preview-store.ts`:
- Keyed by sessionId.
- 5-minute TTL.
- Carries `{ preview, description, summary }`.
- Never persisted.

`confirmCascade(sessionId, sse, signal)`:
1. Look up pending preview. If absent: emit a friendly progress note
   (no error) — the plan may have expired or been cleared by a
   reload.
2. `appendChat({ assistant: pending.summary })` — canonical "change
   applied" record.
3. `appendChangeLog({ ... })` — append to the session's change log.
4. If state was `complete`: `setPendingVersionBump(true)` (M12.2).
5. `clearPendingPreview(sessionId)`.
6. `dispatchCascade({ session, sse, ..., firstImpactStepId, firstImpactItemId, description, state })`:
   - PRD: `runPhase2Cascade(...)` (hand-tuned dispatcher).
   - Other: `runGenericCascade(...)`.
7. After the cascade settles: if state is back at `complete` AND
   `wasComplete`, bump pipelineVersion + clear pendingVersionBump.
   This handles in-place patches (data-only, single-screen regen)
   that don't transition state. Full-rewind cascades stay
   `pendingVersionBump=true` and bump in `approve()` at the next
   transition to `complete`.

`cancelCascade(sessionId)`: just `clearPendingPreview(sessionId)`.
Server is fire-and-forget (204).

## §6.6 Approve — `approve(sessionId, sse, signal)`

State must be `review`. Generic walk:
1. Look up `currentStep` from `state.stepId`.
2. Find `nextStepId = engine.nextRunnableStep(session.slots)`.
3. If `null`: pipeline complete. Set state to `complete`, handle
   pending version bump.
4. Else if next step's `produces` are all populated: skip-when-
   populated path. Set state to next step's review (or running for
   auto). Emit a "skipped" progress note.
5. Else: run the next stage.
   - PRD: `dispatchPrdStage(nextStepId, session, sse, signal)` —
     hand-tuned wrappers.
   - Other: `runStepStage({ session, sse, signal, stepId: nextStepId })`.

`dispatchPrdStage` (private) is a 3-way switch on `String(nextStepId)`
(`"workflow"` → `runWorkflowStage`, `"screen"` → `runScreenStage`,
`"wireframeData" | "wireframeHtml"` → `runWireframeStage`). The
wireframe stage handles both data + HTML in one runner because
they're consecutive auto/review pair.

## §6.7 Rollback — `rollbackToPhase1`

Allowed from `review:*` or `complete`. Steps:
1. `clearPendingPreview` — pending plan no longer valid.
2. `clearRegenContext` — cached priors are not part of the rolled-
   back snapshot.
3. Build `SuspendedSnapshot` capturing every non-anchor slot, the
   state, the anchor content (for the equivalence check), the
   changeLog, the changeLogSummary, the pipelineVersion, the
   pendingVersionBump.
4. `setSuspendedSnapshot(snapshot)`.
5. For each non-anchor slot: `clearSlot` + emit `slot_cleared`.
6. `clearChangeLog` — drop the live changelog (snapshot has it).
7. `setPendingVersionBump(false)` if it was set.
8. `setState({ kind: "phase1" })` + emit meta + state events.

The DRIFT-anchor slot (PRD: contract; research-report: brief) stays
populated. The user is about to edit it.

## §6.8 Restore — `restorePhase2`

Triggered by `completePhase1` when the post-validation contract is
byte-identical to the snapshot's anchor (`contractsMatch`).

1. Restore every snapshot slot via `setSlot` + emit `slot` events.
2. Restore `changeLog` + `changeLogSummary` if present.
3. Restore `pipelineVersion` + `pendingVersionBump`.
4. `setSuspendedSnapshot(null)`.
5. Set state to `{ kind: "review", stepId: pipeline.initialStep }` —
   ALWAYS land at the first step's review, regardless of what state
   the snapshot was taken from.
6. Emit a system note explaining the restore.

The "always land at initialStep" rule (M12.3 fix `e7a4dec`) was the
result of trying both alternatives: landing at the snapshot's state
made the user feel skipped-ahead; landing at initialStep with skip-
when-populated lets them walk forward without re-running anything but
keeps every gate visible. `approve()` skips stages whose outputs are
already populated, so the walk is cheap (no LLM calls).

## §6.9 `completePhase1`

The "Done" button handler:
1. Look up session, check drift anchor exists, emit meta.
2. Run validate:
   - PRD: `runValidate(...)` — full LLM checklist.
   - Other: emit auto-PASS validation_result + setState to phase1_complete.
3. If FAIL: return.
4. If PASS: refresh session, check for snapshot.
   - If `contractsMatch`: `restorePhase2(refreshed, snapshot, sse)`.
   - Else if snapshot exists: drop it
     (`setSuspendedSnapshot(null)`).
   - Run the first Phase 2 stage:
     - PRD: `runWorkflowStage(...)`.
     - Other: `runStepStage({ stepId: pipeline.initialStep })`.

`runFirstPhase2Stage(session, sse, signal)` (helper) does the dispatch.

## §6.10 `startSession`

The first-message handler. Validates `pipelineId` (throws on unknown
before allocating a session), creates the session via storage, appends
the user message to chat, emits meta.

Then in parallel:
- `runTitle` (background) — emits meta when title arrives.
- For PRD: `runFirstMessage` (foreground) — drafts the contract.
- For others: `seedInteractiveSlot` (foreground) — captures the brief.

## §6.11 PRD-specific stage runners

Files: `workflow-stage.ts`, `screen-stage.ts`, `wireframe-stage.ts`,
`phase2-cascade.ts`. All in `src/lib/session-manager/`.

These are thin wrappers around `engine.runStep`. They:
- Set state to `running:<stepId>`.
- Emit a `<pipelineId>.<step>_stage started` progress event.
- Translate engine progress events into PRD's legacy SSE op vocabulary
  (`phase2.workflow_discovery`, `phase2.workflow_detail`,
  `phase2.workflow_map`, etc.).
- Maintain ticker counters for fanout substeps ("3/8 workflows
  detailed").
- Persist produced slots, fire diff summaries.
- Set state to `review:<stepId>` (or auto-advance if the next step is
  `auto`).
- On error: rollback to `errorRollbackState` (default
  `phase1_complete`).

`phase2-cascade.ts` has 4 hand-coded impact handlers
(`runWorkflowImpact`, `runScreenImpact`, `runWireframeDataImpact`,
`runWireframeHtmlImpact`). `wireframeData` patches `data.js` inside
the existing fileset. `wireframeHtml` with item id regenerates one
screen HTML file in place. These optimizations are why PRD has its own
cascade dispatcher.

## §6.12 Generic stage runner — `generic-stage.ts`

`runStepStage(input)` handles non-PRD pipelines:
1. Construct `engineFor(session.pipelineId)`.
2. Loop over steps starting at `input.stepId`:
   a. Set state to running, emit progress.
   b. `ensureChangeLogCompressed`, build `changeHistory`.
   c. `engine.runStep` with `inputs`, `priorOutputs`,
      `changeHistory`, `feedback` (only for the first iteration of
      the loop), `target` (same), `priorResults` (same).
   d. For each produced slot: `setSlot`, emit `slot`,
      `fireDiffSummary`.
   e. If `gate === "terminal"` or `nextRunnableStep === null`:
      transition to `complete` and return.
   f. If `gate === "review"`: transition to `review:<stepId>` and
      return.
   g. If `gate === "auto"`: refresh session, find next runnable step,
      continue loop.

Emits `<pipelineId>.<stepId>` progress events. No domain-specific
ticker. The substep / fanout-item events are forwarded as
`<pipelineId>.<stepId>.<substepId>` and `<pipelineId>.<stepId>.item`.

## §6.13 Generic cascade dispatcher — `generic-cascade.ts`

`runGenericCascade(input)`:
1. Resolve pipeline + start step.
2. Mark start step's slot AND every populated transitive descendant
   slot for regen via `markSlotForRegen` (moves payload to
   `regenContext`, clears the live slot, emits `slot_cleared`).
3. Refresh session.
4. `runStepStage({ session, sse, signal, stepId: startStepId, feedback,
   errorRollbackState, target: firstImpactItemId })`.

No patch-in-place. No single-item fanout regen optimization beyond
forwarding `target` to the engine. If the user requests a
section-only change in research-report, all sections regenerate (the
target gets the user's specific feedback applied; others get
regenerated from the existing outline + brief).

Optimizing single-item regen for research-report requires parsing
prior section bodies out of the concatenated `sections` markdown, then
populating `priorResults`. Deferred from M13.

## §6.14 Errors and the SSEWriter

The SSE response is written through `SSEWriter` (`src/lib/streaming/`).
The manager wraps every public method's body in try/finally. The
caller (the route handler in `/api/*/route.ts`) catches typed errors
(`SessionBusyError`, `NoContractError`, `WrongPhaseError`) and emits
`sse.error(message, code)` events. Untyped errors get `sse.error(msg)`.

`sse.complete()` emits the `complete` event in the route's `finally`
block — always, even after errors. The client uses this to clear
streaming state.
