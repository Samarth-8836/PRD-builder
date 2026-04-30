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
  StepId,
} from "./types";

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

  async runStep(_args: unknown): Promise<void> {
    throw new NotImplementedError("runStep is implemented in M9");
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
