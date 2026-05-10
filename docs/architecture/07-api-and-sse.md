# Chapter 07 — API routes and SSE wire format

Last touched: 2026-05-09 (M13).

The server is a thin layer of Next.js App Router route handlers. Each
handler validates input, calls a `SessionManager` method, and
streams the response via SSE (or returns JSON for read-only endpoints).

All routes are `runtime: "nodejs"` (file-system storage requires Node
APIs) and `dynamic: "force-dynamic"` (sessions change per request).

## §7.1 Route catalog

### §7.1.1 `POST /api/chat` — first message + chat
File: `src/app/api/chat/route.ts`.

Body: `{ message: string, sessionId?: string, pipelineId?: string }`.

- If `sessionId` is absent: `manager.startSession({ firstMessage:
  message, pipelineId, sse, signal })`.
- Else: `manager.handleMessage({ sessionId, message, sse, signal })`.

`pipelineId` is only honored on first-message creation; for existing
sessions, the session's stored pipelineId is authoritative.

Response: SSE stream (see §7.2).

### §7.1.2 `POST /api/phase/complete` — Phase 1 validate
File: `src/app/api/phase/complete/route.ts`.

Body: `{ sessionId: string }`.

Calls `manager.completePhase1({ sessionId, sse, signal })`.

Response: SSE stream — emits `validation_result`, then `state` if
PASS, then either restores Phase 2 or runs the first stage.

### §7.1.3 `POST /api/approve` — advance from review
Body: `{ sessionId: string }`.

Calls `manager.approve(...)`. SSE stream.

### §7.1.4 `POST /api/rollback` — back to Phase 1
Body: `{ sessionId: string }`.

Calls `manager.rollbackToPhase1(...)`. SSE stream.

Server accepts rollback from `review:*` OR `complete`. Anything else
throws `WrongPhaseError`.

### §7.1.5 `POST /api/cascade/confirm` — confirm/cancel pending preview
Body: `{ sessionId: string, action: "confirm" | "cancel" }`.

- `confirm`: calls `manager.confirmCascade(...)`. SSE stream.
- `cancel`: calls `manager.cancelCascade(...)`. Returns `204 No Content`.

### §7.1.6 `GET /api/sessions` — list
Returns `{ sessions: SessionSummary[] }` (id, title, updatedAt, state,
pipelineId).

### §7.1.7 `GET /api/sessions/[id]` — full session
Returns `{ session: Session }`. Used by `loadSession` (sidebar click)
and `HistoryPanel` (refresh).

### §7.1.8 `GET /api/export/[sessionId]` — ZIP bundle
Resolves the session's pipeline. Iterates `pipeline.slots`. For each
populated slot:
- `markdown`: emit as `<fileBaseName ?? `${slotId}.md`>`.
- `fileset`: emit each file under `<folder>/<filename>` (folder taken
  from `fileBaseName.split("/")[0]` or defaults to the slot id).
- `json`: skipped (intermediate).

ZIP is built by `src/lib/zip/` (a tiny custom encoder — no external
dep).

Filename: `<slug(title)>-<shortId(sessionId)>[-v<n>].zip`. Version
suffix only when `pipelineVersion > 1`.

Refuses to export if the drift anchor is missing.

### §7.1.9 `GET /api/wireframe/[sessionId]/[...path]` — fileset serve
PRD-only-by-design. Looks up the session's pipeline, finds the first
`fileset`-kind slot. If absent: 404 "Pipeline X has no fileset
artifact to serve". If present: looks up `slot.files[path.join("/")]`
and returns it with the right Content-Type.

Path traversal defense: rejects paths containing `..` or starting
with `/`. The iframe runs `sandbox="allow-scripts"` (no
`allow-same-origin`) so cross-origin restrictions are inherent.

### §7.1.10 `POST /api/test-llm` — health check
Manual sanity endpoint that fires one LLM call. Used during
deployment to verify env var setup.

## §7.2 SSE wire format

File: `src/lib/streaming/types.ts` (the `StreamEvent` union).
File: `src/lib/streaming/writer.ts` (the `SSEWriter` + `makeSSEResponse`
helper).

Every event is encoded as one `data: <json>\n\n` block.

### Event types

```ts
type StreamEvent =
  | { type: "meta"; sessionId; title; state; pipelineVersion; pipelineId }
  | { type: "chunk"; text }
  | { type: "assistant_message"; content }
  | { type: "slot_delta"; slotId; text }
  | { type: "slot"; slotId; payload }
  | { type: "slot_cleared"; slotId }
  | { type: "state"; state }
  | { type: "progress"; op; status: "started" | "completed" | "failed"; note? }
  | { type: "validation_result"; status: "PASS" | "FAIL"; issues; suggestions }
  | { type: "drift"; classification; driftType?; reason; scope? }
  | { type: "cascade_preview"; description; summary; preview }
  | { type: "error"; message; code? }
  | { type: "complete" };
```

### Per-event semantics

| Event | When emitted | Client effect |
|---|---|---|
| `meta` | Start of every SSE round-trip; on title update; on pipelineVersion bump | Set `current` in session store; sync active tab |
| `chunk` | Streaming token of a chat message | Append to pendingAssistant in chat store |
| `assistant_message` | Canonical chat message after parsing | Replace pendingAssistant |
| `slot_delta` | Streaming token of a markdown slot (op-1-0, op-1-1) | Append to slot's payload.content via document store |
| `slot` | Canonical slot payload after persistence | Set the slot in document store; mark finalized |
| `slot_cleared` | Slot is being rewound (cascade dispatcher) | Drop the slot in document store |
| `state` | Lifecycle transition | Update `current.state`; sync active tab |
| `progress` | Operation lifecycle markers — `op` is a stable string, `status` indicates phase, `note` is optional human text | Append to system messages if status is completed/failed AND note is set |
| `validation_result` | After Phase 1 validate (PASS or FAIL) | Append a system message with formatted issues / "Phase 1 validated" |
| `drift` | After review-chat classifier returns `change` mode | Set drift state in session store; renders DriftBanner if not COMPATIBLE |
| `cascade_preview` | After drift COMPATIBLE | Set pendingPreview in session store; renders CascadePreviewBanner |
| `error` | Caught error in route handler | Append a system message |
| `complete` | Always, in finally block | Clear streaming flag |

### Progress `op` naming

PRD pipeline emits hand-tuned op names (`phase2.workflow_discovery`,
`phase2.workflow_detail`, `phase2.workflow_map`, `phase2.cascade`,
`phase2.iteration`, `phase2.complete`, `phase2.skip`,
`phase2.rollback`, `phase2.restore`, `op-1-0`, `op-1-1`, `op-1-2`).

Generic stage runner emits `<pipelineId>.<stepId>` (e.g.
`research-report.v1.outline`) and `<pipelineId>.<stepId>.<substepId>`
for compose substeps. The chat panel renders these as plain progress
notes (no fancy tickers).

### `cascade_preview.preview` shape

```ts
interface CascadePreview {
  firstImpactStepId: StepId;
  firstImpactItemId?: string;
  affectedSteps: readonly StepId[];
  affectedSlots: readonly DocSlotId[];
  endsAt: SessionLifecycle;
  estimatedWork: string;
  isSingleItemRegen: boolean;
}
```

The banner renders `firstImpactStepId → label`, the affected slots as
labels, the estimated work string, and where it ends (using
`describeLifecycle`).

### Connection lifecycle

`makeSSEResponse(handler)` constructs a `Response` whose body is a
ReadableStream. The handler is invoked with an `SSEWriter`:
```ts
sse.send(event)         // writes `data: <json>\n\n`
sse.error(message, code?) // sends an `error` event
sse.complete()          // sends a `complete` event
sse.isClosed()          // true after the connection closes
```

Aborts (browser navigation, AbortController) propagate via `req.signal`
into operation calls. `streamCompletion` checks the signal between
chunks; runners check it between substeps.

## §7.3 Why SSE and not WebSockets

- One-way (server → client) is enough for this app.
- Plain HTTP — no upgrade handshake, no library required.
- Works through proxies and dev tooling without configuration.
- Easy to replay with `curl -N` for debugging.

The downside: no client → server streaming. Confirm/cancel of cascades
needs separate POSTs. That's acceptable here because human-paced UI
events are infrequent.

## §7.4 Error handling at the route boundary

```ts
return makeSSEResponse(async (sse) => {
  try {
    await manager.startSession({ ... });
  } catch (err: unknown) {
    if (err instanceof SessionBusyError) sse.error(err.message, err.code);
    else if (err instanceof NoContractError) sse.error(err.message, err.code);
    else sse.error(err instanceof Error ? err.message : String(err));
  } finally {
    sse.complete();
  }
});
```

Typed errors carry codes for client-side classification (so the UI can
distinguish "session is busy" from "no contract" from "LLM blew up").
Untyped errors fall through to a plain message.

## §7.5 Why no `/api/sessions/[id] DELETE`

Because the user can delete the JSON file directly. The dev-tool scope
doesn't justify a route. If it ever does: add `DELETE` to the
`[id]/route.ts`, validate the id is valid UUID, call
`fs.unlink(pathFor(id))`. No cascade concerns because there are no
references between sessions.
