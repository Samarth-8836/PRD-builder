import type { Phase } from "@/lib/storage";

/**
 * Module 10 — Phase 2 Stage Machine.
 *
 * Tracks valid transitions between Session phases. Each Phase 2 sub-stage
 * is its own Phase value (design_running, design_review, wireframe_running,
 * ...), so the same `phase` field on the Session record carries the full
 * lifecycle. Use `assertTransition` before persisting a new phase to
 * surface invalid transitions early.
 */

const TRANSITIONS: Record<Phase, Phase[]> = {
  phase1: ["phase1_complete"],
  phase1_complete: [
    "phase1", // user edits contract -> validation invalidated -> back to phase1
    "phase2_workflow_running",
  ],
  phase2_workflow_running: [
    "phase2_workflow_review",
    "phase1",
    "phase1_complete",
  ],
  phase2_workflow_review: [
    "phase2_screen_running",
    "phase2_workflow_running",
    "phase1",
  ],
  phase2_screen_running: [
    "phase2_screen_review",
    "phase2_workflow_review",
    "phase2_workflow_running", // cascade rewind
    "phase1",
  ],
  phase2_screen_review: [
    "phase2_wireframe_running",
    "phase2_screen_running",
    "phase2_workflow_running", // cascade: workflow_change rewinds back
    "phase1",
  ],
  phase2_wireframe_running: [
    "phase2_wireframe_review",
    "phase2_screen_review",
    "phase2_workflow_review",
    "phase1",
  ],
  phase2_wireframe_review: [
    "complete",
    "phase2_wireframe_running",
    "phase2_screen_review",
    "phase2_workflow_running", // cascade: workflow_change full rewind
    "phase2_screen_running", // cascade: screen_only rewind
    "phase1",
  ],
  complete: ["phase1"],
};

export function canTransition(from: Phase, to: Phase): boolean {
  if (from === to) return true;
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function describePhase(phase: Phase): string {
  switch (phase) {
    case "phase1":
      return "Phase 1 - Drafting";
    case "phase1_complete":
      return "Phase 1 - Validated";
    case "phase2_workflow_running":
      return "Phase 2 - Designing Workflows";
    case "phase2_workflow_review":
      return "Phase 2 - Workflow Review";
    case "phase2_screen_running":
      return "Phase 2 - Designing Screens";
    case "phase2_screen_review":
      return "Phase 2 - Screen Review";
    case "phase2_wireframe_running":
      return "Phase 2 - Building Wireframe";
    case "phase2_wireframe_review":
      return "Phase 2 - Wireframe Review";
    case "complete":
      return "Complete";
  }
}

export class PhaseTransitionError extends Error {
  readonly code = "INVALID_TRANSITION";
  constructor(public from: Phase, public to: Phase) {
    super(`Invalid phase transition: ${from} -> ${to}`);
  }
}

export function assertTransition(from: Phase, to: Phase): void {
  if (!canTransition(from, to)) throw new PhaseTransitionError(from, to);
}

export function isPhase2Running(phase: Phase): boolean {
  return (
    phase === "phase2_workflow_running" ||
    phase === "phase2_screen_running" ||
    phase === "phase2_wireframe_running"
  );
}

export function isPhase2Review(phase: Phase): boolean {
  return (
    phase === "phase2_workflow_review" ||
    phase === "phase2_screen_review" ||
    phase === "phase2_wireframe_review"
  );
}
