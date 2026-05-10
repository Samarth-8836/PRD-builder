/**
 * Pipeline registry — maps pipeline ids (stable strings stored on
 * `Session.pipelineId`) to their `PipelineConfig`. The session manager,
 * stage runners, and UI all look up the active pipeline through
 * `getPipeline(session.pipelineId)` rather than importing `PRD_PIPELINE`
 * directly. This is the M13 genericity hinge: adding a new pipeline is
 * "register it here", nothing else changes structurally.
 */

import type { PipelineConfig } from "@/lib/pipeline/types";
import { PRD_PIPELINE } from "./prd-builder";
import { RESEARCH_REPORT_PIPELINE } from "./research-report";

export const PIPELINES: Record<string, PipelineConfig> = {
  [PRD_PIPELINE.id]: PRD_PIPELINE,
  [RESEARCH_REPORT_PIPELINE.id]: RESEARCH_REPORT_PIPELINE,
};

/** Stable list of registered pipelines, in display order. Used by the
 *  picker UI on session creation. */
export const REGISTERED_PIPELINES: readonly PipelineConfig[] = [
  PRD_PIPELINE,
  RESEARCH_REPORT_PIPELINE,
];

export const DEFAULT_PIPELINE_ID = PRD_PIPELINE.id;

export function getPipeline(id: string): PipelineConfig {
  const cfg = PIPELINES[id];
  if (!cfg) {
    throw new Error(
      `Unknown pipelineId "${id}". Registered: ${Object.keys(PIPELINES).join(", ")}`
    );
  }
  return cfg;
}

/** Look up an optional pipeline config without throwing. Returns null
 *  for unknown / missing ids. UI components use this so a session
 *  referencing a retired pipeline still renders something instead of
 *  crashing. */
export function tryGetPipeline(
  id: string | undefined | null
): PipelineConfig | null {
  if (!id) return null;
  return PIPELINES[id] ?? null;
}
