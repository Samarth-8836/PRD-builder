# PRD-Builder

Chat-driven product-definition tool. Turns one sentence into a clickable HTML wireframe, via four artifacts: Project Contract → Workflow Map → Screen Inventory → Wireframe.

See `build-product.md` for the original spec.

## Setup

```bash
npm install
cp .env.local.example .env.local
# fill in OPENROUTER_API_KEY or GROQ_API_KEY in .env.local
npm run dev
```

Open http://localhost:3000.

## Switching providers

Edit `.env.local`:

```
LLM_PROVIDER=groq    # or "openrouter"
```

No code change. No restart needed for env reload in Next dev.

---

## Architecture (M8+ refactor in progress)

The repo is mid-refactor from a hand-wired four-document pipeline into a generic, **declarative pipeline framework**. The `M7` branch is the last stable release of the original architecture; the `M8-pipeline-config` branch and successors host the refactor. `main` will be fast-forwarded only after the M13 milestone lands.

The motivation: today the four documents and the three Phase-2 stages are hard-coded across 6+ files. Adding a step or renaming a domain term means a multi-file refactor. The new framework makes a step a **registry entry + prompt** — no engine, storage, or UI changes required.

### What's pluggable

A `PipelineConfig` (see `src/lib/pipeline/configs/prd-builder.ts`) declares everything:

- **Phases** — UI groupings.
- **Slots** — typed artifact containers (`markdown` | `fileset` | `json`).
- **Steps** — units of work, each with a `runner` (single | fanout | compose), a `dependsOn` graph, a `produces` slot list, and a `gate` (review | auto | terminal).
- **Review chat** — the classifier prompt + parser that decides when a user message in a review state is a question vs. a change request, and identifies the **first-impact step**.
- **Drift anchor** — the slot whose content is treated as the locked baseline for COMPATIBLE/FLAG/DRIFT classification.

When a user requests a change, the engine identifies the first-impact step (the earliest step in topological order whose output the change affects), invalidates that step plus all its transitive dependents, and re-runs them in topo order. The 3×3 cascade matrix from the old code becomes a one-liner: "cascade from this step."

### Prompts as the domain layer

Domain vocabulary ("Project Contract", "persona", "entity", "workflow", "screen") lives in prompts, not in code. Renames are prompt edits documented in **[docs/prompts-refactor.md](docs/prompts-refactor.md)**. The framework guarantees that no engine, storage, or UI code needs to change for a rename. If something does, that's a leak — file an issue.

### Iteration on completed pipelines

After a pipeline reaches the `complete` state, the user can keep iterating. Each iteration:
1. Identifies the first-impact step from the change description.
2. Shows a **change-estimation preview** — first-impact step + downstream slots + estimated work — before doing anything.
3. On confirmation, cascades the change.
4. Bumps `pipelineVersion` and appends a `ChangeLogEntry` (with a 1-2 sentence diff summary per affected slot) to `session.changeLog`.

A **History panel** in the UI shows the full evolution.

### Milestones

- **M7 (stable)** — original hand-wired pipeline.
- **M8 (this branch)** — pipeline module skeleton, types, engine read-only methods, PRD pipeline expressed as config, unit tests. Runtime behavior unchanged.
- **M9** — engine drives the wireframe step.
- **M10** — engine drives all three stages; old hand-wired stage files deleted; `firstImpactStepId` replaces `ChangeScope`.
- **M11** — slot-keyed storage (breaking change); `Phase` union replaced with `SessionLifecycle`. UI rewired to render from config.
- **M12** — change-estimation preview gate; iteration on `complete`; inter-version changelog with diff summaries.
- **M13** — second pipeline (research-report) hosted on the same engine; pipeline picker; per-step LLM model overrides.

See `C:\Users\samarth\.claude\plans\enumerated-exploring-moonbeam.md` for the full plan.

## Smoke test

With the dev server running:

```
GET http://localhost:3000/api/test-llm?q=say%20hello
```

Streams a completion from the configured provider as Server-Sent Events. If you see text chunks come back, the LLM wire works.

## Tests

```
npm run test:pipeline    # engine unit tests (Node 22, --experimental-strip-types)
npm run typecheck        # full TS typecheck
```

The pipeline tests use a self-contained fixture config (`src/lib/pipeline/__tests__/fixture.ts`) so they don't pull in path-aliased imports. The PRD config itself is validated via `npm run typecheck`.
