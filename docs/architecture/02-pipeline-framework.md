# Chapter 02 — The pipeline framework

Last touched: 2026-05-09 (M13).

The pipeline framework is the heart of the application. It's a
declarative description of how a multi-step LLM artifact flow runs,
plus the engine that executes it. Everything else (storage, UI, API,
session manager) is plumbing built around it.

All paths are under `src/lib/pipeline/`.

## §2.1 The single source of truth — `PipelineConfig`

File: `types.ts` (the `PipelineConfig` interface).

Every pipeline is one `PipelineConfig` object. The config drives:
- Storage shape (which slot ids exist, what kind they are)
- Engine behavior (which step runs when, what depends on what)
- UI rendering (tabs, chip strip, placeholders)
- Cascade scope (first-impact + downstream descendants)
- Drift checking (which slot is the locked anchor)

A pipeline lives at `src/lib/pipeline/configs/<id>.ts`. Currently:
- `prd-builder.ts` — exports `PRD_PIPELINE` (id: `"prd-builder.v1"`)
- `research-report.ts` — exports `RESEARCH_REPORT_PIPELINE` (id: `"research-report.v1"`)

Both are registered in `configs/index.ts` (see §2.7).

### `PipelineConfig` shape (high level)

```ts
interface PipelineConfig {
  id: string;                          // "prd-builder.v1"
  label: string;                       // "PRD Builder"
  phases: readonly PhaseConfig[];      // UI-only grouping
  slots: readonly DocSlot[];           // typed payload buckets
  steps: readonly StepConfig[];        // the DAG
  driftAnchor: DocSlotId;              // locked artifact for drift check
  initialStep: StepId;                 // first step to run after Phase 1
  reviewChat: ReviewChatConfig;        // classifier + drift prompt + slot injection
  changelog?: ChangelogConfig;         // sliding-window settings
  ui?: PipelineUiConfig;               // initial chat placeholder, interactive slot
}
```

## §2.2 Branded identifiers

`StepId`, `PhaseId`, `DocSlotId` are `string & { readonly [Brand]: true }`
nominal types. They prevent compile-time mix-ups (you can't pass a
`StepId` where a `DocSlotId` is expected).

Factory functions: `stepId("workflow")`, `phaseId("design")`,
`docSlotId("workflowMap")`. Inside a pipeline config, declare them as
`const SLOT_X = docSlotId("x");` and use `SLOT_X` everywhere.

## §2.3 Slots — the engine's I/O

```ts
interface DocSlot {
  id: DocSlotId;
  label: string;        // UI label (tab, history)
  kind: "markdown" | "fileset" | "json";
  emptyMessage?: string;
  fileBaseName?: string; // export filename (e.g. "project-contract.md")
}
```

`SlotPayload` is a discriminated union mirroring `kind`:

```ts
type SlotPayload =
  | { kind: "markdown"; content: string; version: number }
  | { kind: "fileset";  files: Record<string, string>; version: number }
  | { kind: "json";     data: unknown; version: number };
```

**Conventions**:
- `markdown` — most artifacts. Contract, workflow map, screen
  inventory, outline, sections, final report.
- `fileset` — multi-file artifacts. PRD's `wireframeFiles` (HTML +
  data.js + index.html). Each file is a UTF-8 string.
- `json` — internal/structured. PRD's `wireframeData` (DummyData
  shape). JSON slots are typically not user-facing tabs.

Slot ids and their payload kinds are declared in `config.slots`. The
engine never invents a slot — every produced slot must be in the
config's `slots` list.

`slots.ts` exports typed accessors: `requireMarkdown`, `requireFileset`,
`requireJson`, `getMarkdownContent`, plus payload constructors
`makeMarkdown`, `makeFileset`, `makeJson`.

## §2.4 Steps — the DAG of LLM work

```ts
interface StepConfig {
  id: StepId;
  phase: PhaseId;             // UI grouping
  label: string;
  scope: string;              // one-line "this step decides X" — surfaced to review-chat classifier
  dependsOn: readonly StepId[];
  produces: readonly DocSlotId[]; // > 1 means the step writes multiple slots
  runner: StepRunner;         // single | fanout | compose
  gate: "review" | "auto" | "terminal";
  iterationGate?: StepGate;   // override for iterate-on-complete (default: same as gate)
  modelRole?: ModelRole;      // "fast" | "reasoning" override
  driftAnchor?: DocSlotId;    // per-step override of pipeline.driftAnchor
  reviewPlaceholder?: string; // chat placeholder when paused at this review
  approveLabel?: string;      // approve-button label (e.g. "Approve → Generate Screens")
}
```

### Gates

- `review` — pause for user approval after the step's slots are
  written. Lifecycle becomes `review:<stepId>`.
- `auto` — advance to the next runnable step immediately. Used for
  internal steps the user shouldn't review (PRD's `wireframeData`).
- `terminal` — pipeline ends; lifecycle becomes `complete`.

`iterationGate` lets a step be `auto` during normal flow and `review`
during iterate-on-complete (or vice versa). Currently no pipeline uses
this override — every step's iteration gate is the same as its normal
gate.

### Runners

Three runner kinds; one step has exactly one runner.

#### `SingleRunner` (`runner.kind === "single"`)
```ts
interface SingleRunner {
  kind: "single";
  prompt: PromptSlug;
  buildUserMessage: (ctx: StepContext) => string;
  parser: (text: string) => ParseResult<unknown>;
  format?: (parsed: unknown, ctx: StepContext) => Record<string, SlotPayload>;
  stream?: boolean;          // emit slot_delta tokens
  maxAttempts?: number;
}
```

If `format` is omitted: string output → markdown payload, anything else
→ JSON payload, both keyed under `__default__` and remapped to
`produces[0]`.

#### `FanoutRunner` (`runner.kind === "fanout"`)
Runs the same prompt over an iterable derived from upstream outputs,
with bounded concurrency, then reduces.
```ts
interface FanoutRunner {
  kind: "fanout";
  prompt: PromptSlug;
  items: (ctx: StepContext) => readonly unknown[];
  itemId: (item, index) => string;
  buildUserMessage: (ctx, item, index) => string;
  parser: (text: string) => ParseResult<unknown>;
  concurrency?: number;      // default 1 (free-tier safety)
  reduce: (items, results, ctx) => Record<string, SlotPayload>;
  maxAttempts?: number;
}
```

When the engine is invoked with `onlyItemId` set, the fanout regenerates
only that item; the rest reuse `priorResults`.

#### `ComposeRunner` (`runner.kind === "compose"`)
Sequential substeps. Each substep is either a single or a fanout. The
final `reduce` builds the slot payloads from the accumulated substep
results.
```ts
interface ComposeRunner {
  kind: "compose";
  substeps: readonly ComposeSubstep[];
  reduce: (subResults, ctx) => Record<string, SlotPayload>;
}
```

`ComposeSingleSubstep.skipIf(subResults, ctx) → boolean` lets a
substep no-op based on prior substeps or cascade target. Used by
PRD's wireframe to skip the shell rebuild when only one screen is
being regenerated.

### `StepContext`

What every runner sees:
```ts
interface StepContext {
  sessionId: string;
  inputs: Readonly<Record<string, SlotPayload>>;     // upstream slots
  feedback?: string;                                  // user's change description
  target?: string;                                    // fanout sub-target id
  priorResults?: Record<string, unknown>;             // for fanout single-item regen
  subResults?: Record<string, unknown>;               // compose accumulator
  priorOutputs?: Readonly<Record<string, SlotPayload>>; // cache of pre-rewind payloads
  changeHistory?: ChangeHistoryWindow;                // recent changes + summary
}
```

`priorOutputs` and `changeHistory` are how user customizations and
intent survive cascade rewinds (see chapter 10 §10.2 and §10.5).

## §2.5 Lifecycle states

File: `state.ts`.

```ts
type SessionLifecycle =
  | { kind: "phase1" }
  | { kind: "phase1_complete" }
  | { kind: "running"; stepId: StepId }
  | { kind: "review";  stepId: StepId }
  | { kind: "complete" };
```

Pre-M11 the codebase had a 9-member `Phase` string union with a
hand-rolled `TRANSITIONS` map. That's gone. Valid transitions are
derived from the config (gate, dependsOn).

Helpers:
- `describeLifecycle(state)` → human label for the chip strip footer
  ("Reviewing Workflow Map", "Pipeline locked", etc.).

## §2.6 Engine — `PipelineEngine`

File: `engine.ts`.

The engine owns:
- Topo order of steps (Kahn's algorithm).
- Descendants map (transitive children per step).
- Step lookup by id.
- `runStep` — the only runtime entry point. Pure compute, returns
  `Record<DocSlotId, SlotPayload>`. The caller persists.
- `previewCascade` — pure read-only computation of impact set
  (affected steps, affected slots, estimated work, where the cascade
  ends).
- `nextRunnableStep` — find the first step in topo order whose deps
  are populated and whose outputs are not.
- `stepStateFor` — UI-state classifier (`pending` / `running` /
  `review` / `complete`) used by `PhaseIndicator`.

### `runStep` flow

1. Resolve the step config from `args.stepId`.
2. Build `StepContext` from `inputs`/`feedback`/`target`/etc.
3. Dynamic import of `./runners/index.ts` (lazy so the read-only
   methods don't pull `prompts/operations` into Node test loaders).
4. Dispatch on `runner.kind` to `runSingle` / `runFanout` / `runCompose`.
5. Forward `step.modelRole` to the runner.
6. Return `remapToProducedSlots(step, raw)`. This expands `__default__`
   to the first produces slot id and validates every produces slot is
   set.

### `previewCascade` flow

Given `firstImpactStepId` (and optional `firstImpactItemId`):
- Compute `affectedSteps = [firstImpactStepId, ...stepsAfter(firstImpactStepId).filter(populated)]`.
  "Populated" means the step's `produces` includes at least one slot
  currently in `slots`.
- Compute `affectedSlots` from each affected step's `produces` ∩
  populated slots.
- `endsAt` is derived from the last affected step's `gate`.
- `isSingleItemRegen` is true iff the start step is a fanout AND the
  item id is set AND no descendants are populated. Drives the UI hint
  and the cascade dispatcher's choice.

### Engine validation (constructor)

`validateConfig` enforces:
- `initialStep` exists.
- Every `dependsOn` references a real step.
- Every `produces` slot exists in `config.slots`.
- `driftAnchor` is a real slot.
- Every step's `phase` exists.
- No cycles in step dependencies.

Violations throw at engine construction (i.e., at app boot for
registered pipelines). Tests in `__tests__/topo.test.ts` cover every
case.

## §2.7 Pipeline registry

File: `configs/index.ts`.

```ts
export const PIPELINES: Record<string, PipelineConfig> = {
  [PRD_PIPELINE.id]: PRD_PIPELINE,
  [RESEARCH_REPORT_PIPELINE.id]: RESEARCH_REPORT_PIPELINE,
};

export const REGISTERED_PIPELINES: readonly PipelineConfig[] = [
  PRD_PIPELINE,
  RESEARCH_REPORT_PIPELINE,
];

export const DEFAULT_PIPELINE_ID = PRD_PIPELINE.id;

export function getPipeline(id: string): PipelineConfig;       // throws on unknown
export function tryGetPipeline(id: string | null | undefined): PipelineConfig | null;
```

`Session.pipelineId` is set at create-time and never updated. Lookups
are O(1) via the map. The registry is also the source of truth for the
pipeline picker UI (`REGISTERED_PIPELINES`).

## §2.8 Engine instances

`engineFor(pipelineId)` in `manager.ts` caches one `PipelineEngine`
per pipeline id (constructed lazily on first use). Engines are
stateless after construction; reusing them is purely a perf concern
(avoids re-running topo / descendant computation).

`generic-stage.ts` and `generic-cascade.ts` construct their own engine
inside the function rather than caching — they're called per-cascade
and the cost is amortized.

## §2.9 What lives in `src/lib/pipeline/` vs not

Inside `src/lib/pipeline/`:
- `types.ts` — config + payload + context types
- `state.ts` — `SessionLifecycle` + `describeLifecycle`
- `slots.ts` — typed accessors
- `engine.ts` — `PipelineEngine` + `previewCascade`
- `runners/{single,fanout,compose}.ts` + `index.ts`
- `configs/{index,prd-builder,research-report}.ts`
- `__tests__/{topo,state,preview,fixture}.test.ts`

NOT inside (lives elsewhere):
- The orchestration that calls `engine.runStep` — that's
  `session-manager/`.
- The LLM execution + retry — that's `operations/executor.ts`.
- The prompts themselves — `prompts/`.
- The parsers — `parsers/`.
- Storage — `storage/`.

The framework is intentionally a thin description-and-execution layer.
Domain logic (what makes PRD different from research-report) lives in
the pipeline configs + the prompts + the parsers, not in the framework
itself.
