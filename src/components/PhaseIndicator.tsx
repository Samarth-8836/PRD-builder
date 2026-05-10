"use client";

import { describeLifecycle } from "@/lib/pipeline";
import type { SessionLifecycle } from "@/lib/pipeline/state";
import type { PipelineConfig, StepConfig } from "@/lib/pipeline/types";
import { useDocumentStore } from "@/stores/document";

type ChipState = "pending" | "active" | "review" | "complete";

interface PhaseIndicatorProps {
  state: SessionLifecycle;
  pipeline: PipelineConfig;
}

/** Hand-tuned short labels for PRD's chip strip. Other pipelines fall
 *  through to step.label (kept short by config convention). */
const PRD_SHORT_LABELS: Record<string, string> = {
  workflow: "Workflows",
  screen: "Screens",
  wireframeHtml: "Wireframe",
};

export function PhaseIndicator({ state, pipeline }: PhaseIndicatorProps) {
  const slots = useDocumentStore((s) => s.slots);

  /** Steps shown in the chip strip. Steps with `gate: "auto"` are internal
   *  pipeline glue (e.g., PRD's wireframeData) and are hidden from the user. */
  const visibleSteps: readonly StepConfig[] = pipeline.steps.filter(
    (s) => s.gate !== "auto"
  );

  const phase1State: ChipState = state.kind === "phase1" ? "active" : "complete";
  const anyStepStarted = visibleSteps.some(
    (step) => stepChipState(state, step, slots, pipeline) !== "pending"
  );

  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-wider">
      <Chip state={phase1State} label="Phase 1" />
      <span className="text-neutral-700">/</span>
      <span
        className={`text-[10px] ${anyStepStarted ? "text-neutral-300" : "text-neutral-600"}`}
      >
        Phase 2:
      </span>
      {visibleSteps.map((step, i) => {
        const chip = stepChipState(state, step, slots, pipeline);
        return (
          <span key={String(step.id)} className="contents">
            <SubChip state={chip} label={shortLabel(step, pipeline)} />
            {i < visibleSteps.length - 1 && (
              <span className="text-neutral-700">›</span>
            )}
          </span>
        );
      })}
      <span className="ml-2 text-neutral-500 normal-case tracking-normal">
        {describeLifecycle(state)}
      </span>
    </div>
  );
}

function shortLabel(step: StepConfig, pipeline: PipelineConfig): string {
  if (pipeline.id === "prd-builder.v1") {
    const id = String(step.id);
    if (PRD_SHORT_LABELS[id]) return PRD_SHORT_LABELS[id];
  }
  return step.label;
}

function stepChipState(
  state: SessionLifecycle,
  step: StepConfig,
  slots: Record<string, { finalized: boolean }>,
  pipeline: PipelineConfig
): ChipState {
  // Running on this exact step (or a hidden auto-step that produces the
  // same phase as this step — e.g., wireframeData running maps to the
  // wireframe phase chip).
  if (state.kind === "running") {
    if (state.stepId === step.id) return "active";
    // If state.stepId is a hidden auto-step in this step's phase, we're
    // effectively running this phase too.
    const runningStep = pipeline.steps.find((s) => s.id === state.stepId);
    if (runningStep && runningStep.gate === "auto" && runningStep.phase === step.phase) {
      return "active";
    }
  }
  if (state.kind === "review" && state.stepId === step.id) return "review";
  if (state.kind === "complete") return "complete";

  // No active state on this step. Check whether all the step's outputs are
  // populated; if so the step is complete.
  const allPopulated = step.produces.every((slotId) =>
    Boolean(slots[String(slotId)]?.finalized)
  );
  return allPopulated ? "complete" : "pending";
}

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
