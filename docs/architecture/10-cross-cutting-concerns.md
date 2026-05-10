# Chapter 10 — Cross-cutting concerns

Last touched: 2026-05-09 (M13).

These features don't belong to any one chapter — they thread through
storage, operations, UI, and the cascade flow. Each is described once
here, with cross-links back to the chapter that owns the relevant code.

## §10.1 Drift checking

**Goal.** Reject changes that can't be implemented without modifying
the locked drift anchor (PRD's contract; research-report's brief).

**Mechanism.**
1. Review-chat classifier (chapter 04 §4.4) returns `mode: "change"`
   with a `description` (factual, internal — read by the drift
   checker, not the user).
2. `runDriftCheck` (chapter 04 §4.5) is called BEFORE any chat
   message is appended for the change. Returns `COMPATIBLE | FLAG |
   DRIFT` + reason.
3. Manager emits a `drift` SSE event. If FLAG or DRIFT, returns
   immediately — banner is the only response.
4. If COMPATIBLE, manager proceeds to `previewCascade` and emits
   `cascade_preview`.

**Trigger condition.** Any chat message in `review:*` or `complete`.
`SessionManager.handlePhase2ReviewChat` is the entry point.

**Per-pipeline drift prompt.** `pipeline.reviewChat.driftPrompt`. PRD
uses `phase2.drift_check`; research-report uses
`research_report.drift_check`. Each prompt has its own concept of
what "out of scope" means.

**Why drift check before chat-append.** So that drift-rejected
attempts leave NO false-positive chat record. Pre-M12.1 the change
summary was appended before drift check, leading to "Added X" lingering
in chat after a rejection. Fix: defer the summary append to
`confirmCascade`.

## §10.2 Regen context — preserving customizations across cascades

**Goal.** When a cascade rewinds upstream, the regenerated downstream
artifacts should preserve user-driven customizations from the previous
generation. E.g., if the user added a "group lists" screen in a
cascade, then later changed the workflows, the screen inventory regen
should still include "group lists".

**Mechanism.**
1. `Session.regenContext: Record<string, SlotPayload>` — cache of slot
   payloads moved aside before clearing. Lives on disk in the session
   JSON.
2. `IStorage.markSlotForRegen(id, slotId)` — copies the live slot's
   payload to `regenContext[slotId]` and removes the live slot. Called
   by cascade dispatchers in place of `clearSlot` for slots being
   regenerated.
3. Stage runners read `session.regenContext` and pass it to
   `engine.runStep` as `priorOutputs`.
4. The runner forwards `priorOutputs` to `StepContext`. Step
   `buildUserMessage` callbacks include `<existing_workflows>` /
   `<existing_screens>` / `<existing_outline>` blocks from
   `ctx.priorOutputs?.[slotId]`.
5. After a successful `setSlot`, the corresponding `regenContext[key]`
   is cleared (in `FileStorage.setSlot`).

**Lifecycle.** Populated on cascade rewind. Consumed by the next stage
run. Cleared per-key on success. Wholesale cleared on rollback to
phase1 (`clearRegenContext`).

**Where steps include the prior block.** Each pipeline config's
runner `buildUserMessage` callback. PRD's workflow.discovery,
screen.extract, wireframeData; research-report's outline, edit. (The
sections fanout doesn't currently use `priorOutputs` because per-
section bodies aren't extracted from the prior `sections` markdown —
see §9.2.7.)

**Design note.** This pattern (cache prior + inject into prompt) is a
simpler alternative to differential regeneration. Instead of computing
a diff and applying it, we ask the LLM to start from the prior
artifact and only change what the feedback demands. Works because the
prompts treat `<existing_*>` blocks as "preserve unless feedback says
otherwise".

## §10.3 ChangeLog and `<change_history>` injection

**Goal.** Step prompts that re-run during a cascade should know WHY
the existing artifacts look the way they do (which prior changes the
user requested), not just what they currently are.

**Mechanism.**
1. `Session.changeLog: ChangeLogEntry[]` — append-only record of
   confirmed cascades. Each entry: `{ ts, description, summary,
   firstImpactStepId, firstImpactItemId?, diffSummaries? }`.
2. Appended in `SessionManager.confirmCascade` AFTER the user
   confirms (chapter 06 §6.5). Never appended for question / drift /
   cancel.
3. Surfaced to step prompts as `<change_history>` in the user
   message. Each pipeline's `renderChangeHistory(history)` helper
   builds the block.
4. The block lists recent changes verbatim ("Added X workflow")
   followed by an optional "Summary of older changes" if the rolling
   summary is set.
5. Step prompts treat each entry as a binding requirement. The exact
   wording is in each prompt's system text ("do not undo any prior
   change unless `<user_feedback>` explicitly contradicts it").

**Where stage runners include it.** Every stage runner calls
`ensureChangeLogCompressed(sessionId)` first, then uses
`changeLogWindowFor(session)` to build the `ChangeHistoryWindow`,
then passes it to `engine.runStep` as `changeHistory`. The runner
forwards to `StepContext.changeHistory`.

**Cleared on rollback.** `rollbackToPhase1` calls `clearChangeLog`. If
the contract comes back unchanged, the snapshot's changeLog is
restored.

## §10.4 Cascade preview gate

**Goal.** Show the user what's about to happen before any LLM work
runs. Confirm/Cancel.

**Mechanism (see chapter 06 §6.4 + §6.5).**
1. Review-chat classifier returns `change` mode.
2. Drift COMPATIBLE.
3. `engine.previewCascade(...)` computes the impact set (no I/O).
4. `setPendingPreview(sessionId, preview, description, summary)` —
   in-memory store keyed by sessionId, 5-minute TTL.
5. Emit `cascade_preview` SSE event.
6. UI renders `CascadePreviewBanner` with Confirm / Cancel buttons.
7. User clicks Confirm → POST `/api/cascade/confirm` → second SSE
   round-trip runs the cascade.
8. Or user clicks Cancel → POST `/api/cascade/confirm` (action:
   "cancel") → 204 no-content; client banner is dismissed.
9. Or 5 minutes pass → preview drops; next confirm gets a friendly
   "no pending change" note.

**Why in-memory + TTL.** The pending preview is ephemeral by design.
If the server restarts or the user reloads, the change has to be
re-described. No "ghost" cascades from an old session state.

## §10.5 Per-slot diff summaries

**Goal.** After every cascade, attach a 1-2 sentence summary to each
regenerated slot describing what concretely changed.

**Mechanism (see chapter 04 §4.6).**
1. Stage runner calls `setSlot` → `fireDiffSummary({ sessionId,
   slotId, slotLabel, before, after })`.
2. `fireDiffSummary` schedules an LLM call via `setImmediate` —
   fire-and-forget, never blocks the caller.
3. The call uses `summarize.diff_summary` prompt with
   `role: "fast"`. Truncates before/after to ~6KB.
4. On success: `IStorage.appendDiffSummary` attaches the summary to
   the most-recent ChangeLogEntry. Overwrites existing summary for the
   same slotId (last regen wins).
5. No-op if there's no current ChangeLogEntry (initial generation).
6. Errors are swallowed (logged to `console.warn`).

**UI surface.** `HistoryPanel`. Entries show "summaries pending" until
the diff calls land. User clicks Refresh to re-fetch. No live
subscription.

## §10.6 Sliding-window summarization

**Goal.** Keep LLM context bounded as sessions grow long, without
losing important decisions.

**Mechanism.** Two windows, same shape:

### Chat window
- File: `src/lib/context/window.ts`. Function:
  `ensureChatCompressed(sessionId)`.
- Constants: `VERBATIM_KEEP = 100`, `COMPRESS_THRESHOLD = 110`.
- When `chat.length > COMPRESS_THRESHOLD`: take the oldest
  `chat.length - VERBATIM_KEEP` messages, summarize them into a
  rolling summary via `summarize.chat_window` prompt
  (`role: "fast"`), call `setChatWindow(summary, remainingChat)`.
- Soft-fail: if the summarize call errors, leaves the chat unchanged
  (a long unsummarized window degrades prompt quality, doesn't break
  it).
- Called by `runConversation` (op-1-1) and `runPhase2Conversation`
  (op-2-9) before they build their messages.

### ChangeLog window
- Same file. Function: `ensureChangeLogCompressed(sessionId)`.
- Same constants.
- Summary uses `summarize.changelog_window` prompt.
- Called by every stage runner before building the
  `ChangeHistoryWindow`.

### Rolling summary characteristics
- 1-3 short paragraphs, max ~150 words.
- Preserves decisions, agreements, scope boundaries, persistent
  constraints.
- Drops greetings, retries, superseded ideas.
- Plain prose — no headers, no bullets.
- Designed to be re-folded: the next compression takes "prior summary
  + new batch" and produces a new summary that supersedes the prior
  one.

### Where the summary appears in prompts
- `chatSummary` → injected as `<earlier_conversation_summary>` by
  `context/builder.ts` (PRD's op-1-1) and `op-2-9-conversation.ts`.
- `changeLogSummary` → embedded inside the `<change_history>` block
  by each pipeline's `renderChangeHistory` helper.

## §10.7 pipelineVersion + pendingVersionBump

**Goal.** Track and surface "this is iteration N" to the user. Affects
the version chip in the document panel header and the export filename.

**Mechanism (see manager.ts).**
- `Session.pipelineVersion: number` — 1 on creation. Bumped each time
  the user iterates on `complete` and re-locks.
- `Session.pendingVersionBump: boolean | undefined` — true when a
  cascade has started from `complete` and the session has transitioned
  away from complete. Cleared (with a bump) when the user re-reaches
  complete via Approve.

**Two cases.**
1. **Full-rewind cascade** (e.g., adding a workflow at complete). The
   cascade runs the workflow stage, transitioning to review:workflow.
   `pendingVersionBump` stays true. The user walks back through
   approves; on the final transition to complete (in `approve()`), the
   version is bumped.
2. **In-place patch** (e.g., data-only change at complete that just
   refreshes data.js). No state transition. The cascade ends still at
   complete. `confirmCascade` detects this and bumps right away.

**Restore.** `SuspendedSnapshot.pipelineVersion` /
`pendingVersionBump` are restored if the user rolls back from
mid-iteration and the contract is unchanged.

## §10.8 Tab follows lifecycle

**Goal.** The visible document tab should always show the artifact
the user is currently being asked to review or approve.

**Mechanism.** `syncActiveTabToState(state, pipelineId)` in
`useSSE.ts` (chapter §8.2.4). Called on every `meta` event, every
`state` event, and on `loadSession`.

For PRD this matters most after restore-from-suspended: every slot's
`setSlot` would otherwise leave the tab pinned to whichever was set
last (typically wireframeFiles), making it look like the user got
fast-forwarded when actually the lifecycle is at review:workflow.

## §10.9 Lock + release pattern

Every public manager method follows:
```
if (this.busy.has(sessionId)) throw new SessionBusyError(sessionId);
this.busy.add(sessionId);
try {
  // ... do work ...
} finally {
  this.busy.delete(sessionId);
}
```

Plus the route handler wraps the manager call in try/finally to
guarantee `sse.complete()`. This pair (busy lock + sse complete)
ensures both server-side state and client-side state always converge,
even on uncaught throws.

## §10.10 Suspended snapshot + equivalence check

**Goal.** When the user rolls back to Phase 1 and comes back without
changing the contract, restore the prior Phase 2 work instead of
regenerating it.

**Mechanism.**
1. `rollbackToPhase1` builds a `SuspendedSnapshot` (chapter 03 §3.6),
   stores it via `setSuspendedSnapshot`.
2. `completePhase1` PASS path → `contractsMatch(refreshed, snapshot)`
   compares the trimmed current contract to the snapshot's
   `anchorAtRollback`.
3. If match: `restorePhase2(refreshed, snapshot, sse)` (chapter 06
   §6.8). Else: drop snapshot, run the first stage from scratch.

**Why we always land at `initialStep` on restore.** Walking each gate
gives the user a chance to change something at any stage. `approve()`
skips stages whose outputs are populated, so the walk is cheap. See
M12.3 fix `e7a4dec`.

## §10.11 Concurrency model

- **Per-session writes**: serialized by the busy lock.
- **Cross-session writes**: parallel (different files, no shared
  state).
- **Intra-step fanout**: `concurrency` field on the runner; default
  1 for free-tier safety.
- **Fire-and-forget LLM calls**: diff summaries (`fireDiffSummary`)
  use `setImmediate`; titled (`runTitle`) is awaited but in parallel
  with the foreground op via Promise.all.

There's no global concurrency limiter. Free-tier rate limits are
enforced provider-side; if you hit them, the executor's retry kicks in
once and then surfaces the error.
