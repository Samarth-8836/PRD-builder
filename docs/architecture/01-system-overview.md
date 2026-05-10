# Chapter 01 — System overview

Last touched: 2026-05-09 (M13).

## §1.1 What PRD-Builder is

PRD-Builder is a chat-driven product-definition tool. The user starts
from one sentence ("I want to build a simple todo app") and ends with a
clickable HTML wireframe plus the structured artifacts that produced
it. It runs locally (single-user, no auth), backed by file storage in
`data/sessions/`.

After the M8-M13 refactor, the application is a **declarative pipeline
framework** that hosts arbitrary domain pipelines. PRD-builder is the
original (and most polished) pipeline; research-report is the second
pipeline, shipped in M13 as the genericity proof.

## §1.2 User-facing flow (PRD pipeline)

1. User clicks "+ New session" → Pipeline picker → picks PRD Builder.
2. User types a one-line product idea in chat.
3. **Phase 1 — Project Contract.** The LLM drafts a contract (Goal
   Statement, Personas, Entity Map, Boundaries) and streams it into
   the document panel. The user iterates via chat (question/edit
   classifier) until satisfied, then clicks **Done**.
4. Validation runs against a five-point checklist. PASS transitions
   to Phase 2; FAIL surfaces issues + suggestions.
5. **Phase 2 — Workflow Map** is generated automatically. User reviews
   in chat (question / change-with-cascade-preview). On approve, the
   pipeline advances.
6. **Phase 2 — Screen Inventory.** Same review-and-approve.
7. **Phase 2 — Wireframe.** Sample data + per-screen HTML generated.
   User reviews the rendered iframe. On approve, the session locks
   (state: `complete`).
8. After lock, the user can iterate (request a new change → preview →
   confirm → cascade re-runs from the first-impact step → walk back
   through approves to re-lock at v2).
9. At any review or `complete`, the user can roll back to Phase 1 to
   change the contract. If the contract comes back unchanged, the
   suspended Phase 2 work is restored.

Research-report follows the same skeleton with different artifacts —
brief → outline → section drafts → final report — and a much simpler
Phase 1 (the user's first message becomes the brief verbatim; validate
auto-passes).

## §1.3 The big-picture model

```
              ┌────────────────────────────┐
   user ─────►│         ChatPanel          │
              └─────────────┬──────────────┘
                            │ HTTP/SSE
              ┌─────────────▼──────────────┐
              │    /api/* route handlers   │
              └─────────────┬──────────────┘
                            │
              ┌─────────────▼──────────────┐
              │       SessionManager       │
              │  (per-pipeline dispatch)   │
              └────┬────────────────────┬──┘
                   │ PRD                │ generic
        ┌──────────▼─────────┐ ┌────────▼─────────┐
        │ Hand-tuned PRD     │ │ runStepStage     │
        │ stage runners +    │ │ runGenericCascade│
        │ phase2-cascade     │ │                  │
        └──────────┬─────────┘ └────────┬─────────┘
                   │                    │
                   └─────────┬──────────┘
                             │ engine.runStep
              ┌──────────────▼──────────────┐
              │      PipelineEngine         │
              │  (config-driven, generic)   │
              └──────────────┬──────────────┘
                             │ runner.kind = single | fanout | compose
              ┌──────────────▼──────────────┐
              │  Runners (single/fanout/    │
              │  compose) → execute() →     │
              │  streamCompletion → Provider│
              └──────────────┬──────────────┘
                             │ persists via
              ┌──────────────▼──────────────┐
              │      IStorage (slots)       │
              └─────────────────────────────┘
```

The engine is the pivot. Above it: the manager + stage runners
translate domain intent ("approve workflow", "iterate on complete")
into engine calls. Below it: runners do generic LLM work driven by the
pipeline config.

## §1.4 Tech stack

- **Next.js 15** (App Router) on Node runtime. All API routes are
  `runtime: "nodejs"` because they use file-system storage and Node
  streams.
- **React 19** + **TypeScript** (strict).
- **Zustand** for client state (no Redux).
- **Server-Sent Events (SSE)** for server → client streaming. Plain
  `fetch` POST + a custom SSE parser in `useSSE.ts` consumes the
  stream. No SSE library.
- **OpenRouter** or **Groq** as LLM providers. One free-tier model by
  default (`inclusionai/ling-2.6-1t:free` / `openai/gpt-oss-120b`).
  Optional per-role split (fast vs reasoning) via env vars.
- **Tailwind CSS** for styling (config in `tailwind.config.ts`).
- **Vitest / Node test runner** for the pipeline engine unit tests
  (`npm run test:pipeline`).
- **No database.** Sessions are JSON files at
  `data/sessions/<sessionId>.json`. Atomic writes via tempfile +
  rename.

## §1.5 Repository layout

```
PRD-Builder/
├── src/
│   ├── app/                          # Next.js App Router
│   │   ├── api/                      # Server route handlers
│   │   │   ├── approve/
│   │   │   ├── cascade/confirm/
│   │   │   ├── chat/
│   │   │   ├── export/[sessionId]/
│   │   │   ├── phase/complete/
│   │   │   ├── rollback/
│   │   │   ├── sessions/             # list + [id]
│   │   │   ├── test-llm/
│   │   │   └── wireframe/[sessionId]/[...path]/
│   │   ├── globals.css
│   │   ├── layout.tsx
│   │   └── page.tsx
│   ├── components/                   # React components
│   ├── hooks/                        # useSSE.ts (the only hook)
│   ├── lib/
│   │   ├── context/                  # Prompt context builder + window summarization
│   │   ├── dag/                      # Bounded-concurrency DAG executor
│   │   ├── llm/                      # Provider abstraction + config + streamCompletion
│   │   ├── operations/               # op-1-* / op-2-* + executor + diff-summary
│   │   ├── parsers/                  # Markdown parsers per pipeline + research-report
│   │   ├── pipeline/                 # The framework (engine, types, runners, configs)
│   │   │   ├── configs/              # PRD pipeline + research-report pipeline + registry
│   │   │   ├── runners/              # single, fanout, compose runners
│   │   │   ├── __tests__/            # Engine unit tests + fixture
│   │   │   ├── engine.ts
│   │   │   ├── slots.ts
│   │   │   ├── state.ts
│   │   │   └── types.ts
│   │   ├── prompts/                  # System prompts + few-shot per domain
│   │   ├── session-manager/          # Top-level coordinator + stage runners + cascades
│   │   ├── storage/                  # IStorage + FileStorage
│   │   ├── streaming/                # SSE writer + StreamEvent union
│   │   └── zip/                      # ZIP builder for export
│   └── stores/                       # Zustand stores (session, chat, document)
├── data/
│   └── sessions/                     # Session JSON files (gitignored)
├── docs/
│   ├── architecture/                 # This manual
│   ├── m{N}-manual-tests.md          # Per-milestone smoke test guides
│   └── prompts-refactor.md           # Domain vocabulary inventory
├── public/
└── ... (Next.js config, package.json, etc.)
```

## §1.6 Naming conventions (anchors for grep)

- **Modules** (logical groupings inside the codebase):
  - "Module 7" = Context Builder (`src/lib/context/builder.ts`)
  - "Module 14" = Pipeline framework (`src/lib/pipeline/`)
  - References in code comments use these informal numbers.
- **Operation files**: `op-<phase>-<n>[<letter>]-<slug>.ts`
  - Phase 1: `op-1-0-first-message`, `op-1-0b-title`,
    `op-1-1-conversation`, `op-1-2-validate`
  - Phase 2: `op-2-1a-workflow-discovery` … `op-2-3c-screen-html`,
    `op-2-9-conversation`, `op-2-10-drift-check`
- **Prompt slugs**: `<phase>.<step_or_substep>` (e.g.
  `phase1.first_message`, `phase2.workflow_discovery`,
  `research_report.outline`, `summarize.diff_summary`)
- **Branded ids** are aliased via factory functions:
  - `stepId("workflow")` returns a `StepId`
  - `phaseId("design")` returns a `PhaseId`
  - `docSlotId("workflowMap")` returns a `DocSlotId`

## §1.7 What's in each git history milestone

The codebase grew through 13 named milestones (M1-M13). M8-M13 are the
pipeline-framework refactor:

- **M1-M7** — original hand-wired PRD pipeline (4 documents,
  named-document storage, 3×3 cascade matrix). Stable reference at
  branch tip `M7`.
- **M8** — `pipeline-config-and-engine`: dead-code declaration of
  `PipelineConfig` + `PipelineEngine`.
- **M9** — `engine-runs-wireframe-step`: route the wireframe stage
  through the engine.
- **M10** — `engine-runs-all-steps`: all three stages routed; old
  hand-wired files deleted.
- **M11** — `slot-storage-and-lifecycle`: hard storage cut.
  `Session.slots` replaces named documents. `SessionLifecycle`
  replaces the `Phase` union.
- **M12.1** — `cascade-preview-gate`: preview + confirm before any
  cascade runs.
- **M12.1.5** — `changelog-and-summarized-context`: append-only
  changelog surfaced as `<change_history>` to step prompts; sliding-
  window summarization for chat + changelog.
- **M12.2** — `iterate-on-complete`: chat unblocked at `complete`;
  `pipelineVersion` tracking.
- **M12.3** — `history-panel-and-diff-summaries`: per-slot diff
  summaries via fire-and-forget LLM calls; HistoryPanel UI.
- **M13** — `multi-pipeline-and-domain-prompts`: pipeline registry,
  research-report pipeline, picker UI, `modelRole` plumbing.

`main` stays at `5de06dd` (M7) until M13 ships and is confirmed.

## §1.8 What is intentionally NOT here

- **No multi-tenancy / auth.** Single-user dev tool.
- **No database.** File JSON only.
- **No queueing / background workers.** Everything runs in-request.
  The `setImmediate`-scheduled diff summary calls are the closest
  thing to async work.
- **No analytics, no telemetry.**
- **No internationalization.** Strings are inline English.
- **No accessibility audit.** Keyboard navigation works; screen-reader
  labels are minimal.
- **No HTTPS enforcement** (local dev). API routes accept plain HTTP.
