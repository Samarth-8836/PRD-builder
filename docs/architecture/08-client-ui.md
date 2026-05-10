# Chapter 08 — Client UI

Last touched: 2026-05-09 (M13).

The client is a single-page React app. Three Zustand stores hold all
client state. One hook (`useSSE.ts`) handles every server interaction.
Components are small and read-only-by-default — actions go through
`useSSE` exports.

All paths under `src/`.

## §8.1 Zustand stores

### `stores/session.ts` — `useSessionStore`

```ts
interface SessionStore {
  current: CurrentSession | null;        // active session
  list: SessionSummary[];                 // sidebar
  drift: DriftState | null;               // most recent drift result
  pendingPreview: PendingPreviewState | null; // banner gate
  draftPipelineId: string | null;         // picker selection (M13)
  setCurrent / setList / upsert / setDrift / setPendingPreview / setDraftPipelineId
}

interface CurrentSession {
  id; title; state; pipelineVersion; pipelineId;
}
```

`current.pipelineId` is the canonical identifier the rest of the UI
uses to look up the pipeline config (`tryGetPipeline`).
`draftPipelineId` is the user's picker selection BEFORE the first
message creates the session — once the server emits `meta`,
`current.pipelineId` is set and `draftPipelineId` is cleared.

### `stores/chat.ts` — `useChatStore`

```ts
interface ChatStore {
  messages: ChatMessage[];
  pendingAssistant: string;       // streaming buffer
  streaming: boolean;
  appendUser / appendSystem / setMessages / setPendingAssistant / appendChunk / finalizePending / setStreaming / reset
}
```

`finalizePending` moves `pendingAssistant` into `messages` as one
assistant turn. Called in the `finally` block of every chat-related
hook.

### `stores/document.ts` — `useDocumentStore`

```ts
interface DocumentStore {
  slots: Record<string, ClientSlotState>;
  activeTab: string | null;
  setSlot / appendDelta / clearSlot / setActiveTab / reset
}

interface ClientSlotState {
  payload: SlotPayload;       // mirror of server slot
  finalized: boolean;          // false during streaming, true after canonical `slot` event
}
```

`setSlot` sets `finalized: true`. `appendDelta` (used by `slot_delta`
events) keeps `finalized: false` so the markdown panel renders mid-
stream content without showing it as the canonical version.

`activeTab` is a slot id. Switched via `setActiveTab` from
`syncActiveTabToState` in `useSSE` (chapter §8.2.4) and from user
clicks on the tab strip.

## §8.2 `useSSE.ts` — the only hook

File: `src/hooks/useSSE.ts`. Despite the name, it's a collection of
top-level functions that talk to the server, not a React hook in the
strict sense. Components import them directly.

### §8.2.1 `sendChatMessage({ message, sessionId })`
POST to `/api/chat`. If no `sessionId` and there's a `draftPipelineId`,
forwards it as the `pipelineId` field. After the SSE stream completes,
clears `draftPipelineId`.

### §8.2.2 `validatePhase1(sessionId)` / `approve(sessionId)` / `rollbackToPhase1(sessionId)` / `confirmCascade(sessionId)` / `cancelCascade(sessionId)`
One-line wrappers that POST to the corresponding API route and
consume the SSE response via `consumeSSE`.

`rollbackToPhase1` has special post-stream cleanup: if the lifecycle
actually transitioned to `phase1`, it resets the document store and
re-fetches the session. If the server rejected the rollback (state
unchanged), the cleanup is skipped to avoid the M12.3 flicker bug.

### §8.2.3 `consumeSSE(body, onEvent)` + `dispatch(event)`
SSE parser: reads chunks, splits on `\n\n`, parses `data:` lines as
JSON, calls `onEvent` for each parsed event.

`dispatch(event)` is a switch over `event.type`. Updates the right
store based on the event.

### §8.2.4 `syncActiveTabToState(state, pipelineId)`
Pure function. Looks up the pipeline; computes the slot id for the
current state:
- `review:<stepId>` → that step's first produced slot.
- `complete` → last step's first produced slot.
- Otherwise: no-op.

If the slot is finalized client-side, calls
`useDocumentStore.setActiveTab(slotId)`.

Called from `dispatch` on every `meta` and `state` event, plus from
`loadSession`. This is the M12.2 fix that prevents the post-restore
"tab pinned on wireframe" UX confusion.

### §8.2.5 `loadSession(id)` / `refreshSessionList()`
Read-only fetches. `loadSession` populates the session, chat, and
document stores from `/api/sessions/[id]`; `refreshSessionList`
populates `useSessionStore.list` from `/api/sessions`.

`loadSession` also calls `syncActiveTabToState` and falls back to the
drift anchor for `phase1` / `phase1_complete` / `running` states.

## §8.3 Components

All under `src/components/`. None take props beyond what's strictly
needed. None use React.lazy or Suspense. None use forwardRef or
imperative refs except `ChatPanel`'s scroll container.

### §8.3.1 `AppShell.tsx`
Top-level layout. Three columns:
- Left: `SessionSidebar` (260px)
- Middle: `ChatPanel`
- Right: `DocumentPanel`

Calls `refreshSessionList()` once on mount.

### §8.3.2 `SessionSidebar.tsx`
- "+ New session" button → opens `PipelinePicker`.
- Sessions list — each entry shows title + pipeline label sub-line.
- Refresh button — manual list refresh.
- Renders the picker modal as a child.

When the user picks a pipeline: sets `draftPipelineId`, clears
`current`, resets chat + document stores. The chat panel becomes the
"start typing" state with the picker's initial placeholder.

### §8.3.3 `ChatPanel.tsx`
- Scrollable message list.
- Drift banner / cascade preview banner (rendered above the input).
- Textarea + Send button + Roll back button.
- Resolves the active pipeline via `tryGetPipeline(current?.pipelineId
  ?? draftPipelineId)` — this lets the chat panel show the right
  placeholder + step labels BEFORE the first message creates the
  session.
- `streaming` / `blocked` (drift DRIFT) / `previewPending` disable the
  textarea and Send button.
- Rollback is enabled at any review state OR `complete` (M12.2).

`computePlaceholder` picks the placeholder based on:
- Drift DRIFT: "Change blocked. Roll back to Phase 1 to continue."
- complete: "Pipeline locked. Request a change..."
- No session: pipeline's `ui.initialChatPlaceholder`.
- Review state: step's `reviewPlaceholder`.
- Otherwise: "Ask a question or request an edit..."

### §8.3.4 `DocumentPanel.tsx`
- Header: phase indicator chip strip + version chip + History /
  Export / Done / Approve buttons.
- Tab strip (slots with content, excluding json slots).
- Body: `Markdown` renderer for markdown slots, `WireframeViewer` for
  fileset slots.
- Resolves the active pipeline via `tryGetPipeline(current?.pipelineId)`.
- `visibleSlots` = pipeline.slots filtered to non-json kinds.
- `terminalSlotId` = last step's first produced slot (used to gate the
  Export button alongside `state.kind === "complete"`).
- "Done" button: enabled when `state === "phase1"` AND the interactive
  slot is finalized AND has content.
- "Approve" button: enabled when `state === "review:X"` AND the
  reviewed step's first produced slot is finalized. Label comes from
  `step.approveLabel` (PRD: "Approve → Generate Screens" etc.;
  research-report: "Approve → Draft Sections" etc.).

### §8.3.5 `WireframeViewer.tsx`
PRD-only-by-design. Looks up the first `fileset` slot in the
pipeline; renders a sandboxed iframe pointing at
`/api/wireframe/${sessionId}/index.html?v=${version}`.

`sandbox="allow-scripts"` (no `allow-same-origin`) prevents scripts
inside the iframe from reaching back into the parent's origin.
The iframe is keyed on `${sessionId}:${version}` so a new generation
forces a fresh iframe (no cached state).

If the active pipeline has no fileset slot: renders a "the wireframe
will appear here" placeholder (it's mounted only when the document
panel decides the active tab is a fileset slot, but it gracefully
no-ops otherwise).

### §8.3.6 `PhaseIndicator.tsx`
Chip strip. `Phase 1` chip + a chevron-separated row of step chips
for `gate !== "auto"` steps.

States per chip: `pending` / `active` / `review` / `complete`. Maps
from `(state, step, slots)` via `stepChipState`.

PRD has hand-tuned short labels (`Workflows`, `Screens`, `Wireframe`)
via `PRD_SHORT_LABELS`; other pipelines use `step.label` directly.
Step labels are kept short enough by config convention.

### §8.3.7 `CascadePreviewBanner.tsx`
Side-drawer (well, inline banner above the chat input) with:
- Description of the change
- First impact step + optional item id
- Affected slot labels
- Estimated work
- Where it lands (`describeLifecycle`)
- Confirm / Cancel buttons → call `confirmCascade` / `cancelCascade`

Looks up `slotLabels` and `stepLabels` from the active session's
pipeline (memoized).

### §8.3.8 `DriftBanner.tsx`
Renders when `drift` is set AND `classification !== "COMPATIBLE"` AND
no preview is pending. Shows the drift type + reason.

### §8.3.9 `HistoryPanel.tsx`
Side drawer toggled by the History button in `DocumentPanel`. Fetches
`/api/sessions/[id]` on open and on Refresh click. Renders:
- Rolling change-log summary (if present)
- Reverse-chronological `ChangeLogEntry` rows; each expands to show
  per-slot `DiffSummary` rows.

Pipeline-agnostic — `ChangeLogEntry.diffSummaries` carries the slot
label captured at write time, so the panel doesn't need to resolve
the pipeline.

### §8.3.10 `Markdown.tsx`
Wrapper around `react-markdown` with `remark-gfm`. Renders headings,
lists, tables, code blocks. No HTML allowed (sanitized by default).

### §8.3.11 `PipelinePicker.tsx` (M13)
Modal opened from the sidebar. Shows every `REGISTERED_PIPELINES`
entry with:
- Label
- Pipeline id + step count + first-phase label
- Initial chat placeholder example

Radio-group selection; default to `DEFAULT_PIPELINE_ID`. On Start:
calls `pickPipeline(id)` in the sidebar, which sets
`draftPipelineId` and resets chat + document.

## §8.4 Tab-follows-lifecycle

The active tab is recomputed on every `meta` event, every `state`
event, and on `loadSession`. Logic in `syncActiveTabToState`
(chapter §8.2.4).

The reason: without this, `setSlot` events sequentially set the active
tab to whichever slot was set last. After a restore-from-suspended,
that's wireframeFiles for PRD — but the lifecycle is at
`review:workflow`. The user thinks they got fast-forwarded.

## §8.5 No client-side routing

The app has one URL (`/`). Sessions are switched within the SPA via
`loadSession`. The `next/navigation` APIs are not used.

This is a deliberate constraint (single-user local tool). To add
deep-linking later: introduce `/s/[sessionId]` and have AppShell
trigger `loadSession` on mount based on the route.

## §8.6 Component dependency rule

UI components import from:
- Zustand stores (`@/stores/...`)
- `@/hooks/useSSE`
- `@/lib/pipeline/configs` (registry only — never import a specific
  pipeline directly)
- `@/lib/pipeline` (types only — `describeLifecycle`, `CascadePreview`)
- Other components in `@/components/`

Components do NOT import:
- `@/lib/operations/*` (server-only)
- `@/lib/storage/*` (server-only)
- `@/lib/session-manager/*` (server-only)
- `@/lib/parsers/*`, `@/lib/prompts/*` (server-only)
- A specific pipeline config (`@/lib/pipeline/configs/prd-builder`)

If you find yourself importing a specific pipeline into a UI component:
go through `tryGetPipeline(current?.pipelineId)` instead. The
component should work for any pipeline (or render gracefully when the
pipeline doesn't have the feature, like WireframeViewer).
