# Chapter 03 — Storage and state

Last touched: 2026-05-09 (M13).

All paths under `src/lib/storage/`.

## §3.1 The `Session` shape

File: `types.ts`.

```ts
interface Session {
  id: string;
  title: string;
  createdAt: string;       // ISO
  updatedAt: string;       // ISO
  pipelineId: string;      // (M13) keys into the pipeline registry
  state: SessionLifecycle; // tagged union, see chapter 02 §2.5
  pipelineVersion: number; // bumped per iteration-on-complete
  pendingVersionBump?: boolean;
  slots: Record<string, SlotPayload>;
  slotVersionMax?: Record<string, number>;
  regenContext?: Record<string, SlotPayload>;
  chat: ChatMessage[];
  chatSummary?: string;
  changeLog?: ChangeLogEntry[];
  changeLogSummary?: string;
  suspended?: SuspendedSnapshot;
}
```

Every field has a specific reason to exist; the table below maps each
to the chapter that explains its lifecycle.

| Field | Owner / chapter |
|---|---|
| `id`, `title`, `createdAt`, `updatedAt` | Session basics — created here |
| `pipelineId` | Chapter 02 §2.7, Chapter 11 |
| `state` | Chapter 02 §2.5, Chapter 06 |
| `pipelineVersion` / `pendingVersionBump` | Chapter 10 §10.7 |
| `slots` | Chapter 02 §2.3 |
| `slotVersionMax` | §3.5 below |
| `regenContext` | Chapter 10 §10.2 |
| `chat` / `chatSummary` | Chapter 10 §10.6 |
| `changeLog` / `changeLogSummary` | Chapter 10 §10.5 |
| `suspended` | Chapter 06 §6.6 |

## §3.2 `SessionSummary`

The lightweight projection used by the sidebar list:
```ts
interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  state: SessionLifecycle;
  pipelineId: string;
}
```

`SessionSidebar.tsx` renders the title plus the pipeline label as a
sub-line.

## §3.3 `IStorage` interface

The storage abstraction has 17 methods. They cluster by purpose:

### Identity / lookup
- `createSession(seed)` — seed includes optional `pipelineId`.
  Defaults to `"prd-builder.v1"`.
- `getSession(id)`
- `listSessions()` → `SessionSummary[]`
- `saveSession(session)` — opaque overwrite (rarely used directly)

### Slot writes
- `setSlot(id, slotId, payload)` — bumps version (see §3.5).
- `clearSlot(id, slotId)` — drops the slot, stashes its version.
- `markSlotForRegen(id, slotId)` — moves the live payload into
  `regenContext[slotId]`, then clears the live slot. Used by cascade
  rewinds so step prompts can see the prior version.
- `clearRegenContext(id)` — drop the entire regen cache (rollback to
  phase1).

### Chat
- `appendChat(id, message)` — append-only.
- `setChatWindow(id, summary, chat)` — replace with trimmed window +
  rolling summary.

### ChangeLog
- `appendChangeLog(id, entry)` — append-only.
- `setChangeLogWindow(id, summary, changeLog)` — replace with trimmed
  window + rolling summary.
- `clearChangeLog(id)` — drop both.
- `appendDiffSummary(id, summary)` — attach to the most-recent
  ChangeLogEntry; overwrites existing summary for the same slotId
  (last regen wins). No-op if changeLog is empty.

### Lifecycle
- `setState(id, state)`
- `setSuspendedSnapshot(id, snapshot | null)`
- `setPipelineVersion(id, n)`
- `bumpPipelineVersion(id)` — `pipelineVersion = (pipelineVersion ?? 1) + 1`
- `setPendingVersionBump(id, pending)`

### Miscellaneous
- `setTitle(id, title)`

## §3.4 `FileStorage` implementation

File: `file-storage.ts`.

- One JSON file per session at `<root>/<sessionId>.json`. Root is
  `data/sessions/` by default.
- Atomic writes via `<target>.<pid>.<ts>.tmp` + `fs.rename`. Same-FS
  rename is atomic on POSIX and (modern) Windows NTFS.
- File version prefix: `{ fileVersion: 2, session: ... }`. M11 bumped
  to fileVersion 2 (slot-keyed shape). M13 did NOT bump — it added an
  optional field with a default-on-read.
- `getSession` defaults `pipelineId` to `"prd-builder.v1"` for any
  session JSON missing the field. This lets pre-M13 dev sessions load
  without migration.
- Rejects fileVersion ≠ 2 with a clear "M11 changed the storage shape
   — clear data/sessions/" error.

There's no separate transaction / journal layer — the per-session lock
is held by `SessionManager.busy` (see chapter 06 §6.1). Concurrent
writes for a single session ID don't happen by construction.

## §3.5 Slot versioning rules

Each slot payload carries a `version: number`. The version is a
high-water mark of how many times the slot has been written, NOT a
content hash.

**`setSlot`** increments:
```
floor    = max(existing.version ?? 0, slotVersionMax[key] ?? 0)
nextVer  = floor + 1
slot.version = nextVer
slotVersionMax[key] = nextVer
```

**`clearSlot`** stashes the version (so a future setSlot continues
from it instead of resetting to 1):
```
slotVersionMax[key] = max(slotVersionMax[key] ?? 0, existing.version)
delete slots[key]
```

This rule was added in M12.1 (commit `153bb7e`) — pre-M12.1, a
clearSlot followed by a setSlot would reset the version chip to v1,
which felt like the prior version was lost. The fix preserves the
high-water mark.

## §3.6 `SuspendedSnapshot`

```ts
interface SuspendedSnapshot {
  slots: Record<string, SlotPayload>;       // every slot EXCEPT the drift anchor
  state: SessionLifecycle;                  // review:* or complete only
  anchorAtRollback: string;                 // contract content at rollback
  changeLog?: ChangeLogEntry[];
  changeLogSummary?: string;
  pipelineVersion?: number;
  pendingVersionBump?: boolean;
  takenAt: string;
}
```

Captured by `rollbackToPhase1` (chapter 06 §6.7) and consumed by
`completePhase1` after re-validation. The drift anchor (contract /
brief) is excluded from the snapshot because the user is about to edit
it; the post-rollback content is what matters for the equivalence
check (`contractsMatch`).

## §3.7 `ChatMessage` and `ChangeLogEntry`

```ts
interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  ts: string;
}
```

`system` is reserved for client-rendered system notes (validation
results, errors). Server LLM calls use `user`/`assistant` only.

```ts
interface ChangeLogEntry {
  ts: string;
  description: string;        // factual description (for drift / context)
  summary: string;            // one-sentence past tense ("Added X")
  firstImpactStepId: string;
  firstImpactItemId?: string;
  diffSummaries?: DiffSummary[];
}

interface DiffSummary {
  slotId: string;
  slotLabel: string;          // captured at write time so UI rendering doesn't depend on the live config
  summary: string;
  ts: string;
}
```

Appended by `confirmCascade` AFTER the user confirms (never on
question / drift-FLAG / cancel). DiffSummaries are populated post-hoc
by `fireDiffSummary` (chapter 04 §4.6).

## §3.8 What's NOT in storage

- LLM prompt caches — every call hits the provider fresh.
- Session lock state — held in-process in `SessionManager.busy: Set<string>`.
- The pending cascade preview — held in-process in `preview-store.ts`
  (5-minute TTL, never persisted). Crash-survivability of "I confirmed
  the change but the server restarted" is not a goal.
- LLM-provider-side state — providers may keep their own logs/caches;
  PRD-Builder doesn't.

## §3.9 Where storage gets accessed

- `SessionManager` (`session-manager/manager.ts`) — every storage
  write. The manager owns the `getStorage()` import and passes it to
  every helper.
- Stage runners (`workflow-stage.ts`, `screen-stage.ts`,
  `wireframe-stage.ts`, `generic-stage.ts`) — call `setSlot`,
  `setState`. Use `getStorage()` directly.
- Cascade dispatchers (`phase2-cascade.ts`, `generic-cascade.ts`) —
  `markSlotForRegen`, `setSlot`, `clearSlot`.
- Operations (`op-1-*`, `op-2-*`) — `setSlot` for the contract /
  brief slot. Use `getStorage()` directly.
- Context window helpers (`context/window.ts`) — `setChatWindow`,
  `setChangeLogWindow`.
- Diff summary worker (`operations/diff-summary.ts`) —
  `appendDiffSummary`.
- API route handlers — `getStorage().getSession(id)` for read-only
  endpoints (`/api/sessions`, `/api/export`, `/api/wireframe/...`).

`getStorage()` returns a singleton `FileStorage` instance pointed at
the resolved root directory. No per-request storage construction.
