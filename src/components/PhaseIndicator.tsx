"use client";

import { describePhase } from "@/lib/phase-machine";
import type { Phase } from "@/lib/storage";

interface PhaseIndicatorProps {
  phase: Phase;
}

export function PhaseIndicator({ phase }: PhaseIndicatorProps) {
  const phase1State = phase === "phase1" ? "active" : "complete";

  return (
    <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider">
      <Chip state={phase1State} label="Phase 1" />
      <span className="text-neutral-700">/</span>
      <Chip state={phase === "phase1" ? "pending" : phaseStateForPhase2(phase)} label="Phase 2" />
      <span className="ml-2 text-neutral-500 normal-case tracking-normal">
        {describePhase(phase)}
      </span>
    </div>
  );
}

type ChipState = "pending" | "active" | "complete";

function Chip({ state, label }: { state: ChipState; label: string }) {
  const classes =
    state === "complete"
      ? "border-emerald-700 bg-emerald-900/40 text-emerald-300"
      : state === "active"
        ? "border-blue-700 bg-blue-900/40 text-blue-200"
        : "border-neutral-800 text-neutral-600";

  const marker =
    state === "complete" ? "✓" : state === "active" ? "●" : "○";

  return (
    <span className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 ${classes}`}>
      <span aria-hidden>{marker}</span>
      <span>{label}</span>
    </span>
  );
}

function phaseStateForPhase2(phase: Phase): ChipState {
  if (
    phase === "phase2_design_running" ||
    phase === "phase2_design_review" ||
    phase === "phase2_wireframe_running" ||
    phase === "phase2_wireframe_review"
  ) {
    return "active";
  }
  if (phase === "complete") return "complete";
  return "pending";
}
