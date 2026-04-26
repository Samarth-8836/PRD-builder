"use client";

import { describePhase } from "@/lib/phase-machine";
import type { Phase } from "@/lib/storage";

interface PhaseIndicatorProps {
  phase: Phase;
}

export function PhaseIndicator({ phase }: PhaseIndicatorProps) {
  const phase1State =
    phase === "phase1" ? "active" : "complete";

  const designState = stageStateFor(phase, "design");
  const wireframeState = stageStateFor(phase, "wireframe");
  const phase2Highlighted =
    designState !== "pending" || wireframeState !== "pending";

  return (
    <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider">
      <Chip state={phase1State} label="Phase 1" />
      <span className="text-neutral-700">/</span>
      <span className={`text-[10px] ${phase2Highlighted ? "text-neutral-300" : "text-neutral-600"}`}>
        Phase 2:
      </span>
      <SubChip state={designState} label="Design" />
      <span className="text-neutral-700">›</span>
      <SubChip state={wireframeState} label="Wireframe" />
      <span className="ml-2 text-neutral-500 normal-case tracking-normal">
        {describePhase(phase)}
      </span>
    </div>
  );
}

type ChipState = "pending" | "active" | "review" | "complete";

function Chip({ state, label }: { state: ChipState; label: string }) {
  const classes = chipClassesFor(state);
  const marker = markerFor(state);
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 ${classes}`}>
      <span aria-hidden>{marker}</span>
      <span>{label}</span>
    </span>
  );
}

function SubChip({ state, label }: { state: ChipState; label: string }) {
  const classes = chipClassesFor(state);
  const marker = markerFor(state);
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 ${classes}`}>
      <span aria-hidden className={state === "active" ? "animate-pulse" : ""}>
        {marker}
      </span>
      <span>{label}</span>
    </span>
  );
}

function chipClassesFor(state: ChipState): string {
  switch (state) {
    case "complete":
      return "border-emerald-700 bg-emerald-900/40 text-emerald-300";
    case "active":
      return "border-blue-700 bg-blue-900/40 text-blue-200";
    case "review":
      return "border-amber-700 bg-amber-900/30 text-amber-200";
    default:
      return "border-neutral-800 text-neutral-600";
  }
}

function markerFor(state: ChipState): string {
  switch (state) {
    case "complete":
      return "✓";
    case "active":
      return "●";
    case "review":
      return "●";
    default:
      return "○";
  }
}

function stageStateFor(phase: Phase, stage: "design" | "wireframe"): ChipState {
  if (stage === "design") {
    if (phase === "phase2_design_running") return "active";
    if (phase === "phase2_design_review") return "review";
    if (
      phase === "phase2_wireframe_running" ||
      phase === "phase2_wireframe_review" ||
      phase === "complete"
    ) {
      return "complete";
    }
    return "pending";
  }
  if (phase === "phase2_wireframe_running") return "active";
  if (phase === "phase2_wireframe_review") return "review";
  if (phase === "complete") return "complete";
  return "pending";
}
