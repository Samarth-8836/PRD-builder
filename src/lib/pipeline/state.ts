/**
 * SessionLifecycle — replaces the hand-rolled `Phase` union from
 * `lib/storage/types`. Tagged-union so TypeScript exhaustively checks the
 * `kind` discriminator. Valid transitions are derived from the
 * PipelineConfig (no static TRANSITIONS map).
 *
 * In M8 this file is dead code; the existing `Phase` union is still the
 * source of truth. Adopted in M11.
 */

import type { PipelineConfig, StepId } from "./types";

export type SessionLifecycle =
  | { kind: "phase1" }
  | { kind: "phase1_complete" }
  | { kind: "running"; stepId: StepId }
  | { kind: "review"; stepId: StepId }
  | { kind: "complete" };

export class LifecycleTransitionError extends Error {
  constructor(from: SessionLifecycle, to: SessionLifecycle, hint?: string) {
    super(
      `Invalid transition: ${describe(from)} -> ${describe(to)}${
        hint ? ` (${hint})` : ""
      }`
    );
    this.name = "LifecycleTransitionError";
  }
}

/** Human-readable description for logs and SSE meta. */
export function describe(state: SessionLifecycle): string {
  switch (state.kind) {
    case "phase1":
      return "Phase 1 - Drafting";
    case "phase1_complete":
      return "Phase 1 - Validated";
    case "running":
      return `Running: ${state.stepId}`;
    case "review":
      return `Review: ${state.stepId}`;
    case "complete":
      return "Complete";
  }
}

/** Validates a transition against the pipeline config. Throws on invalid. */
export function assertTransition(
  from: SessionLifecycle,
  to: SessionLifecycle,
  config: PipelineConfig
): void {
  if (canTransition(from, to, config)) return;
  throw new LifecycleTransitionError(from, to);
}

/** Returns true iff the transition is allowed by the pipeline graph. */
export function canTransition(
  from: SessionLifecycle,
  to: SessionLifecycle,
  config: PipelineConfig
): boolean {
  // Rollback to phase1 is always allowed (the user-facing escape hatch).
  if (to.kind === "phase1") return true;

  switch (from.kind) {
    case "phase1":
      return to.kind === "phase1_complete";
    case "phase1_complete":
      // Re-edit the contract (back to phase1) handled above.
      return (
        to.kind === "running" && to.stepId === config.initialStep
      );
    case "running":
      // running -> review (same step, gate=review)
      // running -> running (next step, gate=auto)
      // running -> complete (gate=terminal)
      // running -> phase1 (failure rollback) handled above
      // running -> phase1_complete (initial-step failure rollback)
      if (to.kind === "phase1_complete") return true;
      if (to.kind === "review" && to.stepId === from.stepId) return true;
      if (to.kind === "running") return isReachableNext(from.stepId, to.stepId, config);
      if (to.kind === "complete") return true;
      return false;
    case "review":
      // review -> running (approve next, or cascade re-running this step or upstream)
      // review -> complete (approve from terminal-ish step)
      // review -> phase1 (rollback) handled above
      if (to.kind === "running") return true; // engine arbitrates which step
      if (to.kind === "complete") return true;
      return false;
    case "complete":
      // complete -> running (iteration after complete)
      // complete -> phase1 (rollback) handled above
      return to.kind === "running";
  }
}

function isReachableNext(
  fromStep: StepId,
  toStep: StepId,
  config: PipelineConfig
): boolean {
  const idx = config.steps.findIndex((s) => s.id === fromStep);
  if (idx === -1) return false;
  // Any step whose deps are satisfied by `fromStep` and earlier-completed
  // steps is a valid "next". For M8 we permit any step the user could
  // reach via topo order — the engine will refine this.
  return config.steps.some((s) => s.id === toStep);
}
