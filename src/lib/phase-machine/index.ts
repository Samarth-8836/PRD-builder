import type { Phase } from "@/lib/storage";

/**
 * Module 10 — Phase 2 Stage Machine (M3 minimal version).
 *
 * Tracks valid transitions between Session phases. M3 only needs the
 * boundary between phase1 and phase1_complete; the Phase 2 stages (design,
 * wireframe) get filled in starting in M4 alongside the stage runners.
 */

const TRANSITIONS: Record<Phase, Phase[]> = {
  phase1: ["phase1_complete"],
  phase1_complete: [
    "phase1", // user edits contract -> validation invalidated -> back to phase1
    "phase2_design_running", // M4 will use this
  ],
  phase2_design_running: ["phase2_design_review", "phase1"],
  phase2_design_review: [
    "phase2_wireframe_running",
    "phase2_design_running",
    "phase1",
  ],
  phase2_wireframe_running: ["phase2_wireframe_review", "phase1"],
  phase2_wireframe_review: [
    "complete",
    "phase2_wireframe_running",
    "phase2_design_review",
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
    case "phase2_design_running":
      return "Phase 2 - Designing";
    case "phase2_design_review":
      return "Phase 2 - Design Review";
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
