# Chapter 04 — Operations and LLM

Last touched: 2026-05-09 (M13).

The operations layer is where domain code meets the LLM. Each operation
file (`op-*.ts`) is a thin async function that builds messages, calls
`execute`, and persists. The pipeline runners are also operations in
spirit (and they call `execute` too) — the file naming distinguishes
"PRD-pipeline-specific operations" (op-*.ts) from "generic step
runners" (`pipeline/runners/*.ts`).

## §4.1 LLM provider abstraction

Files: `src/lib/llm/{config,provider}.ts`.

### `resolveModel(role) → ResolvedModel`

```ts
type ModelRole = "fast" | "reasoning";

interface ResolvedModel {
  provider: "openrouter" | "groq";
  baseUrl: string;
  apiKey: string;
  modelId: string;
}
```

Reads env vars in this priority:
1. Role-specific: `OPENROUTER_FAST_MODEL` /
   `OPENROUTER_REASONING_MODEL` (and GROQ equivalents).
2. Generic fallback: `OPENROUTER_MODEL` / `GROQ_MODEL`.
3. Hard-coded default: `inclusionai/ling-2.6-1t:free` (OpenRouter) or
   `openai/gpt-oss-120b` (Groq).

`LLM_PROVIDER` selects between OpenRouter and Groq (default OpenRouter).

The role parameter was a no-op until M13 — it now actually picks
between fast and reasoning models when env vars are set.

### `streamCompletion({ role, messages, signal }) → AsyncIterable<{ delta }>`

Calls the provider's chat completions endpoint with `stream: true`,
parses the SSE response, yields `{ delta }` per token.

The provider is OpenAI-compatible (both OpenRouter and Groq follow the
OpenAI API shape).

Error handling: provider-side errors (4xx/5xx) throw. Rate-limit
backoff is in `operations/retry.ts` (currently a thin wrapper).

## §4.2 `execute` — the executor

File: `src/lib/operations/executor.ts`.

The single point where every LLM call goes through. Owns:
- Streaming + accumulation
- Parser invocation
- Corrective-retry on parse failure
- `onDelta` / `onRetry` callbacks for UI feedback
- `role` forwarding to `streamCompletion`

```ts
interface ExecuteInput<T> {
  system: string;
  messages: ChatMessage[];        // user/assistant turns including current message
  parser: (text: string) => ParseResult<T>;
  correctiveHint?: (reason: string) => string;
  signal?: AbortSignal;
  role?: ModelRole;
  maxAttempts?: number;           // default 2
  onDelta?: (delta: string, ctx: { accumulated, attempt }) => void;
  onRetry?: (reason: string, attempt: number) => void;
}
```

### Retry behavior

If `parser(accumulated)` returns `ok`, return immediately.
If `fail` AND `attempt < maxAttempts` AND `correctiveHint` is set:
- Append the failed assistant turn + a corrective user message
  (`correctiveHint(reason)`) to the messages array.
- Call streamCompletion again.

This is "fix your output, here's why it was wrong" pattern. Capped at
`maxAttempts` (default 2) to prevent infinite loops.

If still failing after all attempts: throw with the last error.

The `onDelta` callback is gated on `attempt === 1` by every operation —
streaming partial output during a corrective retry would confuse the
UI (which already showed attempt 1's content).

## §4.3 PRD Phase 1 operations

These three are PRD-pipeline-specific (they read/write PRD's
`projectContract` slot directly). The session manager only calls them
when `session.pipelineId === "prd-builder.v1"`.

### `op-1-0-first-message.ts` — `runFirstMessage`
Drafts a Project Contract from a one-line idea. Streams the contract
body progressively to the document panel via `slot_delta` events
(triggered by detecting the `CONTRACT:` marker in the streamed text).

Uses prompt slug `phase1.first_message`. Parser extracts `{ summary,
contract }` from the model's two-section response.

### `op-1-0b-title.ts` — `runTitle`
Generates a 2-4 word session title from the user's idea. Fire-and-
forget from `startSession` — runs in parallel with the contract draft,
emits a meta event when done.

Uses prompt slug `phase1.title`.

### `op-1-1-conversation.ts` — `runConversation`
Handles follow-up Phase 1 messages. The model classifies the user's
intent (`MODE: question` vs `MODE: edit`) and either streams an answer
to chat or streams a new contract to the document panel. The router is
a small state machine in the `onDelta` handler.

Uses prompt slug `phase1.conversation`. Parser extracts `{ mode,
answer | summary, contract }`.

### `op-1-2-validate.ts` — `runValidate`
Validates the contract against a five-point checklist. PASS →
`phase1_complete`; FAIL → returns issues + suggestions for the chat.

Uses prompt slug `phase1.validate`. Parser extracts `{ status, issues,
suggestions }`.

For non-PRD pipelines, the manager bypasses this entirely and emits an
auto-PASS validation_result event (chapter 06 §6.4).

## §4.4 Phase 2 review-chat — `op-2-9-conversation.ts` (now generic)

`runPhase2Conversation` is the review-chat classifier. It emits
`question` (free-form answer) or `change` (with `firstImpactStepId` +
optional `firstImpactItemId`).

Pre-M13 it hardcoded PRD slot ids. Post-M13 it's pipeline-aware:
- Reads `pipeline.reviewChat.prompt` for the system prompt.
- Calls `pipeline.reviewChat.buildSystemContext(slots)` to inject the
  pipeline's populated artifacts as `<tag>...</tag>` blocks into the
  system prompt. PRD injects `<project_contract>` /
  `<workflow_map>` etc.; research-report injects `<brief>` /
  `<outline>` etc. If `buildSystemContext` is omitted, falls back to
  dumping every populated markdown slot in `<{slotId}>...</{slotId}>`
  tags.
- Runs `parsePhase2Conversation(text, { knownStepIds })` with the
  pipeline's registered step ids as the validation allow-list.

The few-shot examples and the prompt itself are still pipeline-
specific (PRD's `phase2.conversation` vs research-report's
`research_report.review_chat`) because the model needs domain examples
to classify correctly.

## §4.5 Drift check — `op-2-10-drift-check.ts`

`runDriftCheck` takes:
- `contract` — the locked drift-anchor content
- `changeDescription` — the model's factual description from the
  review-chat classifier
- `promptSlug` — pipeline-specific drift prompt (defaults to
  `"phase2.drift_check"` so legacy callers that don't pass it still
  work)

Returns `{ classification: "COMPATIBLE" | "FLAG" | "DRIFT", type?, reason }`.

PRD pipeline uses `phase2.drift_check`; research-report uses
`research_report.drift_check`. Each prompt has its own few-shot and
its own concept of what "out of scope" means.

The manager calls drift check BEFORE emitting any `assistant_message`
or appending the change summary to chat. This guarantees that drift-
FLAG / drift-DRIFT / cancelled previews leave no false-positive chat
record.

## §4.6 Diff summary — `operations/diff-summary.ts`

`fireDiffSummary({ sessionId, slotId, slotLabel, before, after })`
schedules a fire-and-forget LLM call via `setImmediate`. The call:
1. Truncates `before` and `after` to ~6KB each (LLM context budget).
2. Builds a minimal prompt (`summarize.diff_summary`) with `<slot_label>`,
   `<before>`, `<after>` blocks. Uses `role: "fast"`.
3. Parses 1-2 sentences.
4. Calls `IStorage.appendDiffSummary` — attaches to the most-recent
   ChangeLogEntry. No-op if there is no entry (initial generation).

Errors are swallowed (logged to `console.warn`) — diff summaries are
"nice to have", not load-bearing. The HistoryPanel renders "(summary
pending)" until the call lands.

## §4.7 Title — `op-1-0b-title.ts`

`runTitle(firstMessage, session, signal) → string`. Plain LLM call
that returns 2-4 words. Used to give a freshly created session a
non-default title before the user names it. Errors are swallowed (the
session keeps the default "Untitled" title).

## §4.8 Format helpers — `operations/format-helpers.ts`

Pure functions used by the PRD pipeline's compose `reduce` callbacks:
- `formatWorkflowMap(detailed)` — assembles the markdown
- `formatScreenInventory(screens)` — assembles the markdown
- `formatScreenList(screens)` — sub-formatter for nav_validate
- `formatDataJs(data)` — emits `data.js` content for the wireframe
- `runWireframeSmokeTest(screens, files)` — sanity check on the
  produced fileset (no broken hrefs, every screen has a file, etc.)

Domain-specific. Don't generalize to research-report; that pipeline
formats its own artifacts inside its config.

## §4.9 Operation invocation map

Who calls what:

| Caller | Operations called |
|---|---|
| `SessionManager.startSession` (PRD) | `runFirstMessage`, `runTitle` |
| `SessionManager.startSession` (other) | `runTitle`, plus `seedInteractiveSlot` (private method, no LLM) |
| `SessionManager.handlePhase1Chat` (PRD) | `runConversation` |
| `SessionManager.handlePhase1Chat` (other) | `seedInteractiveSlot` |
| `SessionManager.completePhase1` (PRD) | `runValidate` |
| `SessionManager.completePhase1` (other) | (no LLM — auto-PASS) |
| `SessionManager.handlePhase2ReviewChat` | `runPhase2Conversation`, `runDriftCheck` |
| Stage runners | engine.runStep → runners → execute |
| Cascade dispatcher | engine.runStep → runners → execute |
| `setSlot` (after) | `fireDiffSummary` (background) |
| `op-2-9-conversation`'s context build | `ensureChatCompressed` (chapter 10 §10.6) |
| Stage runners | `ensureChangeLogCompressed` (chapter 10 §10.5) |

## §4.10 Why operations don't share a base class

Every op is a function. Some take `{ session, sse, signal }`; some
take a more focused input. There's no shared base because:
- Their inputs vary too much (some need streaming events, some don't).
- Their failure modes vary (some throw, some return a result).
- Composition is by direct function call, not by inheritance / pipeline
  middleware.

Adding a new operation = create a new file in `operations/`, export the
function, import wherever needed. Keep it small (~80-200 LOC) and
specific.
