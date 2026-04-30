/**
 * Pipeline framework public API.
 *
 * In M8 this module is dead code — the existing wired pipeline still runs
 * everything. M9-M13 progressively route the runtime through the engine.
 *
 * See `docs/prompts-refactor.md` for the contract between pipelines,
 * prompts, parsers, and slot ids.
 */

export * from "./types";
export { PipelineEngine, NotImplementedError } from "./engine";
export type {
  CascadePreview,
  StepState,
  StepProgressEvent,
  RunStepArgs,
} from "./engine";
export { sessionToSlots, extractDummyData } from "./adapter";
export {
  describe as describeLifecycle,
  toLegacyPhase,
  assertTransition,
  canTransition,
  LifecycleTransitionError,
} from "./state";
export type { SessionLifecycle } from "./state";
export {
  requireMarkdown,
  requireFileset,
  requireJson,
  getSlot,
  getMarkdownContent,
  makeMarkdown,
  makeFileset,
  makeJson,
  SlotMissingError,
  SlotKindMismatchError,
} from "./slots";
export { runSingle, runFanout, runCompose } from "./runners";
