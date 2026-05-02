/**
 * PipelineEngine — generic, config-driven orchestrator. In M8 only the
 * graph-shape methods are implemented (topoOrder, stepsAfter,
 * dependencies, nextRunnableStep, stepStateFor); the runtime methods
 * (runStep, approveCurrentReview, cascadeFromStep, iterateAfterComplete)
 * are stubs that throw NotImplemented and will be filled in M9-M12.
 *
 * The engine is dead code at M8: nothing wires the real session manager to
 * it yet. Unit tests exercise the read-only methods over PRD_PIPELINE.
 */

import type { SessionLifecycle } from "./state";
import type {
  DocSlotId,
  PipelineConfig,
  SlotPayload,
  StepConfig,
  StepContext,
  StepId,
} from "./types";
// Runners are imported lazily inside runStep so the read-only graph
// methods (topo, descendants, previewCascade) don't pull `@/lib/prompts`
// + `@/lib/operations` into modules that just want graph shape (e.g.,
// the unit tests under Node's --experimental-strip-types runner, which
// can't resolve TS path aliases).

export type StepState =
  | "pending"
  | "running"
  | "review"
  | "complete";

export interface CascadePreview {
  firstImpactStepId: StepId;
  firstImpactItemId?: string;
  /** Steps that will be re-run, in topological order. Includes
   *  firstImpactStep + transitive dependents that are currently populated. */
  affectedSteps: readonly StepId[];
  /** Slots whose contents will be cleared/regenerated. */
  affectedSlots: readonly DocSlotId[];
  /** Whether the cascade ends at a review gate (and which step), or auto. */
  endsAt: SessionLifecycle;
  /** Coarse work estimate (e.g., "1 single + 1 fanout(4) + 1 single"). */
  estimatedWork: string;
  /** Whether a fanout sub-target was supplied AND only that one item needs
   *  to regenerate (no descendants beyond the same fanout). */
  isSingleItemRegen: boolean;
}

export class PipelineEngine {
  readonly config: PipelineConfig;
  private readonly stepIndex: ReadonlyMap<StepId, StepConfig>;
  private readonly topo: readonly StepId[];
  private readonly descendants: ReadonlyMap<StepId, readonly StepId[]>;

  constructor(config: PipelineConfig) {
    this.config = config;
    this.stepIndex = new Map(config.steps.map((s) => [s.id, s] as const));
    validateConfig(config, this.stepIndex);
    this.topo = computeTopoOrder(config);
    this.descendants = computeDescendants(config, this.topo);
  }

  /** Topological order of all steps. */
  topoOrder(): readonly StepId[] {
    return this.topo;
  }

  /** All steps that transitively depend on `stepId`, in topo order.
   *  Does not include `stepId` itself. */
  stepsAfter(stepId: StepId): readonly StepId[] {
    return this.descendants.get(stepId) ?? [];
  }

  /** Step ids the given step directly depends on. */
  directDependencies(stepId: StepId): readonly StepId[] {
    return this.requireStep(stepId).dependsOn;
  }

  /** Computes the next step that should run given the current slot state.
   *  Returns the first step in topo order whose `dependsOn` are all
   *  populated and whose `produces` slots are not yet populated. */
  nextRunnableStep(
    slots: Readonly<Record<string, SlotPayload>>
  ): StepId | null {
    for (const id of this.topo) {
      const step = this.requireStep(id);
      const allInputsReady = step.dependsOn.every((dep) =>
        this.requireStep(dep).produces.every((s) => slots[s as string])
      );
      if (!allInputsReady) continue;
      const allOutputsPopulated = step.produces.every(
        (s) => slots[s as string]
      );
      if (!allOutputsPopulated) return id;
    }
    return null;
  }

  /** UI-state classifier for a step given the lifecycle + slot state. */
  stepStateFor(
    stepId: StepId,
    state: SessionLifecycle,
    slots: Readonly<Record<string, SlotPayload>>
  ): StepState {
    if (state.kind === "running" && state.stepId === stepId) return "running";
    if (state.kind === "review" && state.stepId === stepId) return "review";
    const step = this.requireStep(stepId);
    const allOutputsPopulated = step.produces.every(
      (s) => slots[s as string]
    );
    if (allOutputsPopulated) return "complete";
    return "pending";
  }

  /** Compute the cascade impact set for a first-impact step. Read-only —
   *  does not mutate session state. */
  previewCascade(args: {
    firstImpactStepId: StepId;
    firstImpactItemId?: string;
    slots: Readonly<Record<string, SlotPayload>>;
  }): CascadePreview {
    const { firstImpactStepId, firstImpactItemId, slots } = args;
    this.requireStep(firstImpactStepId); // validates the id

    const downstream = this.stepsAfter(firstImpactStepId);
    const populatedDownstream = downstream.filter((id) => {
      const step = this.requireStep(id);
      return step.produces.some((s) => slots[s as string]);
    });

    const isSingleItemRegen =
      Boolean(firstImpactItemId) &&
      this.requireStep(firstImpactStepId).runner.kind === "fanout" &&
      populatedDownstream.length === 0;

    const affectedSteps: StepId[] = [
      firstImpactStepId,
      ...populatedDownstream,
    ];

    const affectedSlots: DocSlotId[] = [];
    for (const id of affectedSteps) {
      const step = this.requireStep(id);
      for (const slotId of step.produces) {
        if (slots[slotId as string]) affectedSlots.push(slotId);
      }
    }

    const lastStep = affectedSteps[affectedSteps.length - 1]!;
    const lastConfig = this.requireStep(lastStep);
    const endsAt: SessionLifecycle =
      lastConfig.gate === "terminal"
        ? { kind: "complete" }
        : lastConfig.gate === "auto"
          ? { kind: "running", stepId: lastStep }
          : { kind: "review", stepId: lastStep };

    const estimatedWork = affectedSteps
      .map((id) => describeWork(this.requireStep(id), slots))
      .join(" + ");

    return {
      firstImpactStepId,
      firstImpactItemId,
      affectedSteps,
      affectedSlots,
      endsAt,
      estimatedWork,
      isSingleItemRegen,
    };
  }

  // --- Runtime methods (M9+) -------------------------------------------------

  /**
   * Run a step. Pure compute: reads from `inputs` (caller-provided), writes
   * its output as a `Record<DocSlotId, SlotPayload>`. The caller is
   * responsible for persisting the result to storage and emitting any
   * SSE events; the engine is wire-format-agnostic.
   *
   * Progress is reported via `onProgress` (substep/fanout-item granularity).
   * The default `__default__` slot key returned by SingleRunners that don't
   * specify `format` is remapped to the step's `produces[0]`.
   */
  async runStep(args: RunStepArgs): Promise<Record<DocSlotId, SlotPayload>> {
    const step = this.requireStep(args.stepId);
    const ctx: StepContext = {
      sessionId: args.sessionId,
      inputs: args.inputs,
      feedback: args.feedback,
      target: args.target ?? args.onlyItemId,
      priorResults: args.priorResults,
      priorOutputs: args.priorOutputs,
    };

    const { runSingle, runFanout, runCompose } = await import(
      "./runners/index.ts"
    );

    let raw: Record<string, SlotPayload>;
    if (step.runner.kind === "single") {
      raw = await runSingle({
        runner: step.runner,
        ctx,
        signal: args.signal,
        onDelta: args.onDelta,
        onRetry: args.onRetry,
      });
    } else if (step.runner.kind === "fanout") {
      raw = await runFanout({
        runner: step.runner,
        ctx,
        signal: args.signal,
        onProgress: (itemId, status, note) =>
          args.onProgress?.({
            kind: "fanout_item",
            stepId: args.stepId,
            itemId,
            status,
            note,
          }),
        onlyItemId: args.onlyItemId,
        priorResults: args.priorResults,
      });
    } else {
      raw = await runCompose({
        runner: step.runner,
        ctx,
        signal: args.signal,
        onSubstep: (substepId, status, note) =>
          args.onProgress?.({
            kind: "substep",
            stepId: args.stepId,
            substepId,
            status,
            note,
          }),
        onFanoutItem: (substepId, itemId, status, note) =>
          args.onProgress?.({
            kind: "fanout_item",
            stepId: args.stepId,
            substepId,
            itemId,
            status,
            note,
          }),
      });
    }

    return remapToProducedSlots(step, raw);
  }

  async approveCurrentReview(_args: unknown): Promise<void> {
    throw new NotImplementedError("approveCurrentReview is implemented in M10");
  }

  async cascadeFromStep(_args: unknown): Promise<void> {
    throw new NotImplementedError("cascadeFromStep is implemented in M10");
  }

  async iterateAfterComplete(_args: unknown): Promise<void> {
    throw new NotImplementedError("iterateAfterComplete is implemented in M12");
  }

  // --- Helpers ----------------------------------------------------------------

  requireStep(id: StepId): StepConfig {
    const s = this.stepIndex.get(id);
    if (!s) throw new Error(`Unknown step id: ${String(id)}`);
    return s;
  }
}

export class NotImplementedError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "NotImplementedError";
  }
}

// ---------------------------------------------------------------------------
// runStep API
// ---------------------------------------------------------------------------

export type StepProgressEvent =
  | {
      kind: "substep";
      stepId: StepId;
      substepId: string;
      status: "started" | "completed" | "skipped" | "failed";
      note?: string;
    }
  | {
      kind: "fanout_item";
      stepId: StepId;
      /** Substep id when the fanout is inside a compose runner. */
      substepId?: string;
      itemId: string;
      status: "started" | "completed" | "failed";
      note?: string;
    };

export interface RunStepArgs {
  stepId: StepId;
  sessionId: string;
  inputs: Readonly<Record<string, SlotPayload>>;
  feedback?: string;
  target?: string;
  signal?: AbortSignal;
  onProgress?: (event: StepProgressEvent) => void;
  onDelta?: (delta: string) => void;
  onRetry?: (reason: string, attempt: number) => void;
  /** Fanout sub-target case: only regenerate the matching item id. The
   *  other items reuse the prior parsed values from `priorResults`. Only
   *  honored when the step's runner is `kind: "fanout"`. */
  onlyItemId?: string;
  priorResults?: Record<string, unknown>;
  /** Slot id -> the prior version of that slot, captured by the cascade
   *  dispatcher before clearing. Forwarded to `StepContext.priorOutputs`
   *  so step builders can preserve user-driven customizations. */
  priorOutputs?: Readonly<Record<string, SlotPayload>>;
}

function remapToProducedSlots(
  step: StepConfig,
  raw: Record<string, SlotPayload>
): Record<DocSlotId, SlotPayload> {
  const out: Record<DocSlotId, SlotPayload> = {};
  if (raw.__default__) {
    const firstSlot = step.produces[0];
    if (!firstSlot) {
      throw new Error(
        `Step ${String(step.id)} returned __default__ but produces is empty`
      );
    }
    out[firstSlot] = raw.__default__;
  }
  for (const [key, payload] of Object.entries(raw)) {
    if (key === "__default__") continue;
    out[key as DocSlotId] = payload;
  }
  // Validate every produced slot is set.
  for (const slotId of step.produces) {
    if (!out[slotId]) {
      throw new Error(
        `Step ${String(step.id)} did not produce required slot "${String(slotId)}"`
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function validateConfig(
  config: PipelineConfig,
  stepIndex: ReadonlyMap<StepId, StepConfig>
): void {
  // initialStep must exist
  if (!stepIndex.has(config.initialStep)) {
    throw new Error(
      `Pipeline ${config.id}: initialStep "${String(
        config.initialStep
      )}" is not in steps`
    );
  }
  // every dependsOn must reference a real step
  for (const step of config.steps) {
    for (const dep of step.dependsOn) {
      if (!stepIndex.has(dep)) {
        throw new Error(
          `Step "${String(step.id)}" declares unknown dependency "${String(dep)}"`
        );
      }
    }
    if (step.produces.length === 0) {
      throw new Error(
        `Step "${String(step.id)}" must produce at least one slot`
      );
    }
  }
  // slot ids referenced by `produces` must exist in `config.slots`
  const slotIds = new Set(config.slots.map((s) => s.id as string));
  for (const step of config.steps) {
    for (const slotId of step.produces) {
      if (!slotIds.has(slotId as string)) {
        throw new Error(
          `Step "${String(step.id)}" produces unknown slot "${String(slotId)}"`
        );
      }
    }
  }
  // driftAnchor must be a real slot
  if (!slotIds.has(config.driftAnchor as string)) {
    throw new Error(
      `Pipeline ${config.id}: driftAnchor "${String(
        config.driftAnchor
      )}" is not in slots`
    );
  }
  // phase ids referenced by steps must exist
  const phaseIds = new Set(config.phases.map((p) => p.id as string));
  for (const step of config.steps) {
    if (!phaseIds.has(step.phase as string)) {
      throw new Error(
        `Step "${String(step.id)}" references unknown phase "${String(
          step.phase
        )}"`
      );
    }
  }
}

function computeTopoOrder(config: PipelineConfig): readonly StepId[] {
  const incoming = new Map<StepId, number>();
  const outgoing = new Map<StepId, StepId[]>();
  for (const step of config.steps) {
    incoming.set(step.id, step.dependsOn.length);
    outgoing.set(step.id, []);
  }
  for (const step of config.steps) {
    for (const dep of step.dependsOn) {
      outgoing.get(dep)!.push(step.id);
    }
  }
  // Kahn's algorithm. Tie-break by config order to keep output stable.
  const order: StepId[] = [];
  const ready: StepId[] = [];
  for (const step of config.steps) {
    if ((incoming.get(step.id) ?? 0) === 0) ready.push(step.id);
  }
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const remaining = (incoming.get(next) ?? 0) - 1;
      incoming.set(next, remaining);
      if (remaining === 0) {
        // Insert in original config-order position to keep ties stable.
        const pos = config.steps.findIndex((s) => s.id === next);
        let i = 0;
        while (i < ready.length) {
          const otherPos = config.steps.findIndex((s) => s.id === ready[i]);
          if (pos < otherPos) break;
          i++;
        }
        ready.splice(i, 0, next);
      }
    }
  }
  if (order.length !== config.steps.length) {
    throw new Error(
      `Pipeline ${config.id} has a cycle in step dependencies`
    );
  }
  return order;
}

function computeDescendants(
  config: PipelineConfig,
  topo: readonly StepId[]
): ReadonlyMap<StepId, readonly StepId[]> {
  const directChildren = new Map<StepId, StepId[]>();
  for (const step of config.steps) directChildren.set(step.id, []);
  for (const step of config.steps) {
    for (const dep of step.dependsOn) {
      directChildren.get(dep)!.push(step.id);
    }
  }
  const out = new Map<StepId, StepId[]>();
  // Walk topo in reverse so children's descendants are computed first.
  for (let i = topo.length - 1; i >= 0; i--) {
    const id = topo[i]!;
    const direct = directChildren.get(id) ?? [];
    const all = new Set<StepId>();
    for (const child of direct) {
      all.add(child);
      for (const grand of out.get(child) ?? []) all.add(grand);
    }
    // Preserve topo order of descendants.
    const ordered = topo.filter((s) => all.has(s));
    out.set(id, ordered);
  }
  return out;
}

function describeWork(
  step: StepConfig,
  _slots: Readonly<Record<string, SlotPayload>>
): string {
  const r = step.runner;
  if (r.kind === "single") return `${step.label} (single)`;
  if (r.kind === "fanout") return `${step.label} (fanout)`;
  // compose: count substeps including any fanout substeps
  const subCount = r.substeps.length;
  return `${step.label} (compose×${subCount})`;
}
