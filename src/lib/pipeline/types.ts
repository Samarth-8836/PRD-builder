/**
 * Module 14 — Pipeline framework: declarative description of a multi-step
 * artifact pipeline. The engine, UI, storage shape, and cascade rules all
 * derive from a `PipelineConfig`.
 *
 * In M8 this module is dead code (the existing wired pipeline still runs
 * everything). Subsequent milestones (M9-M13) progressively route the
 * runtime through the engine and delete the hand-wired stage files.
 */

import type { ParseResult } from "@/lib/parsers";
import type { PromptSlug } from "@/lib/prompts";
import type { ModelRole } from "@/lib/llm/config";

// ---------------------------------------------------------------------------
// Identifiers — branded strings for compile-time discipline without making
// the engine generic over union types.
// ---------------------------------------------------------------------------

declare const StepIdBrand: unique symbol;
declare const PhaseIdBrand: unique symbol;
declare const DocSlotIdBrand: unique symbol;

export type StepId = string & { readonly [StepIdBrand]: true };
export type PhaseId = string & { readonly [PhaseIdBrand]: true };
export type DocSlotId = string & { readonly [DocSlotIdBrand]: true };

export const stepId = (s: string): StepId => s as StepId;
export const phaseId = (s: string): PhaseId => s as PhaseId;
export const docSlotId = (s: string): DocSlotId => s as DocSlotId;

// ---------------------------------------------------------------------------
// Slot payloads — what lives in a slot. Discriminated so non-markdown
// artifacts have a proper home.
// ---------------------------------------------------------------------------

export type ArtifactKind = "markdown" | "fileset" | "json";

export interface MarkdownPayload {
  kind: "markdown";
  content: string;
  version: number;
}

export interface FilesetPayload {
  kind: "fileset";
  files: Record<string, string>;
  version: number;
}

export interface JsonPayload {
  kind: "json";
  data: unknown;
  version: number;
}

export type SlotPayload = MarkdownPayload | FilesetPayload | JsonPayload;

export interface DocSlot {
  id: DocSlotId;
  label: string;
  kind: ArtifactKind;
  /** UI hint when the slot is empty. */
  emptyMessage?: string;
  /** Used by the export bundler. e.g. "Project Contract.md" */
  fileBaseName?: string;
}

// ---------------------------------------------------------------------------
// Step configuration
// ---------------------------------------------------------------------------

/** What every runner sees. The engine populates this from session + storage. */
export interface StepContext {
  sessionId: string;
  /** Slot id -> read-only payload of upstream slots this step depends on
   *  (transitive — every slot reachable through `dependsOn`). */
  inputs: Readonly<Record<string, SlotPayload>>;
  /** Optional review feedback / change description from the user. */
  feedback?: string;
  /** Optional sub-target id (e.g. one fanout item like a screen id) when a
   *  cascade narrows the scope to a single item. */
  target?: string;
  /** Optional prior fanout item results keyed by itemId. When `target` is
   *  set, fanout runners and fanout substeps reuse these for non-target
   *  items rather than re-running them. */
  priorResults?: Record<string, unknown>;
  /** Sub-result accumulator for compose runners. Substep id -> parsed value. */
  subResults?: Record<string, unknown>;
}

/** A SingleRunner produces one parsed value from one prompt. */
export interface SingleRunner {
  kind: "single";
  prompt: PromptSlug;
  buildUserMessage: (ctx: StepContext) => string;
  parser: (text: string) => ParseResult<unknown>;
  /** Optional code-only formatter that turns the parsed value into the slot
   *  payloads. Defaults: markdown if string output, json otherwise. Most
   *  steps with non-trivial formatting set this explicitly. */
  format?: (parsed: unknown, ctx: StepContext) => Record<string, SlotPayload>;
  /** If true, stream tokens to the chat panel as `slot_delta` events. */
  stream?: boolean;
  /** Override the executor's default attempts. */
  maxAttempts?: number;
}

/** A FanoutRunner runs the same prompt over an iterable, then reduces. */
export interface FanoutRunner {
  kind: "fanout";
  prompt: PromptSlug;
  /** Derive the per-item iterable from upstream outputs. */
  items: (ctx: StepContext) => readonly unknown[];
  /** A stable id for each item, used for sub-target regeneration. */
  itemId: (item: unknown, index: number) => string;
  buildUserMessage: (ctx: StepContext, item: unknown, index: number) => string;
  parser: (text: string) => ParseResult<unknown>;
  /** Bounded concurrency. Defaults to 1 for free-tier safety. */
  concurrency?: number;
  /** Combine N item results into the slot payloads for this step. */
  reduce: (
    items: readonly unknown[],
    results: readonly unknown[],
    ctx: StepContext
  ) => Record<string, SlotPayload>;
  maxAttempts?: number;
}

/** A ComposeRunner runs sequential substeps and reduces to slot payloads. */
export interface ComposeRunner {
  kind: "compose";
  substeps: readonly ComposeSubstep[];
  /** Final reducer assembles slot payloads from substep results. */
  reduce: (
    results: Record<string, unknown>,
    ctx: StepContext
  ) => Record<string, SlotPayload>;
}

export type ComposeSubstep = ComposeSingleSubstep | ComposeFanoutSubstep;

export interface ComposeSingleSubstep {
  id: string;
  kind: "single";
  prompt: PromptSlug;
  buildUserMessage: (
    ctx: StepContext,
    sub: Record<string, unknown>
  ) => string;
  parser: (text: string) => ParseResult<unknown>;
  /** Skip if predicate returns true. Receives both the sub-result map
   *  and the StepContext so substeps can skip based on cascade-target
   *  state (e.g. skip the shell rebuild when only one fanout item is
   *  being regenerated). */
  skipIf?: (sub: Record<string, unknown>, ctx: StepContext) => boolean;
  maxAttempts?: number;
}

export interface ComposeFanoutSubstep {
  id: string;
  kind: "fanout";
  prompt: PromptSlug;
  items: (ctx: StepContext, sub: Record<string, unknown>) => readonly unknown[];
  itemId: (item: unknown, index: number) => string;
  buildUserMessage: (
    ctx: StepContext,
    sub: Record<string, unknown>,
    item: unknown,
    index: number
  ) => string;
  parser: (text: string) => ParseResult<unknown>;
  concurrency?: number;
  reduce: (
    items: readonly unknown[],
    results: readonly unknown[]
  ) => unknown;
  maxAttempts?: number;
}

export type StepRunner = SingleRunner | FanoutRunner | ComposeRunner;

/** Lifecycle gate after a step's outputs are persisted. */
export type StepGate = "review" | "auto" | "terminal";

export interface StepConfig {
  id: StepId;
  phase: PhaseId;
  label: string;
  /** One-line description of the kind of decision this step owns; surfaced
   *  to the review-chat classifier so the model can pick the right
   *  `firstImpactStepId`. */
  scope: string;
  /** Step ids this step depends on. Drives the cascade DAG. */
  dependsOn: readonly StepId[];
  /** Slot ids this step writes. >1 means the step produces multiple
   *  artifacts (e.g. wireframe step writes html files + data). */
  produces: readonly DocSlotId[];
  /** The unit of work. */
  runner: StepRunner;
  /** Lifecycle gate after success: `review` waits for explicit approve,
   *  `auto` advances to the next ready step, `terminal` ends the pipeline. */
  gate: StepGate;
  /** On iteration after `complete`, override the default gate (`auto`).
   *  Default: same as `gate`. */
  iterationGate?: StepGate;
  /** Optional per-step LLM role override. */
  modelRole?: ModelRole;
  /** Optional drift-check anchor override (default: pipeline.driftAnchor). */
  driftAnchor?: DocSlotId;
  /** Placeholder text shown in the chat panel when paused on this step's
   *  review gate. */
  reviewPlaceholder?: string;
  /** Label for the Approve button at this step's review gate. UI-only.
   *  Convention: "Approve → Generate <thing>" or "Approve → Mark Complete". */
  approveLabel?: string;
}

// ---------------------------------------------------------------------------
// Phase grouping (UI-only)
// ---------------------------------------------------------------------------

export interface PhaseConfig {
  id: PhaseId;
  label: string;
  /** Stable order in the indicator chip strip. Lower = earlier. */
  order: number;
}

// ---------------------------------------------------------------------------
// Review chat (Phase-2-style classifier)
// ---------------------------------------------------------------------------

export interface ReviewChatClassification {
  mode: "question" | "change";
  /** For mode=question. */
  answer?: string;
  /** For mode=change: short user-facing summary of the change. */
  summary?: string;
  /** For mode=change: the change description / model's understanding. */
  description?: string;
  /** For mode=change: the first-impact step id (must match a registered
   *  step in the pipeline). */
  firstImpactStepId?: StepId;
  /** For mode=change: optional sub-target inside a fanout step (e.g. one
   *  screen id). */
  firstImpactItemId?: string;
}

export interface ReviewChatConfig {
  prompt: PromptSlug;
  parser: (text: string) => ParseResult<ReviewChatClassification>;
  driftPrompt: PromptSlug;
  driftParser: (text: string) => ParseResult<{
    classification: "COMPATIBLE" | "FLAG" | "DRIFT";
    type?: string;
    reason: string;
  }>;
}

// ---------------------------------------------------------------------------
// Changelog (M12)
// ---------------------------------------------------------------------------

export interface ChangelogConfig {
  /** If false, skip diff-summary generation (changelog still records the
   *  fact of the change, but no per-slot summary text). Default true. */
  autoSummarize?: boolean;
  /** Soft cap on retained entries. Older entries are dropped. Default 200. */
  maxEntries?: number;
  /** Prompt slug used to summarize a single slot's diff. The prompt is
   *  given the before/after content and is expected to return 1-2 sentences. */
  diffSummaryPrompt?: PromptSlug;
}

// ---------------------------------------------------------------------------
// Top-level config
// ---------------------------------------------------------------------------

export interface PipelineUiConfig {
  /** Placeholder for the chat panel before any work has started (Phase 1). */
  initialChatPlaceholder?: string;
  /** Slot id whose content is edited by the Phase-1 free-form conversation
   *  (today: projectContract). The engine doesn't drive this slot — it's
   *  written by SessionManager.handlePhase1Chat. */
  interactiveSlot?: DocSlotId;
}

export interface PipelineConfig {
  id: string;
  /** Display name shown in the pipeline picker. */
  label: string;
  /** Phase groupings, ordered. */
  phases: readonly PhaseConfig[];
  /** Slot definitions. Order matters for tab/export ordering. */
  slots: readonly DocSlot[];
  /** All steps. Topo order is derived from `dependsOn`. */
  steps: readonly StepConfig[];
  /** Slot whose content is the drift baseline (anchored against compatible
   *  changes). Today: projectContract. */
  driftAnchor: DocSlotId;
  /** The first step that runs after Phase 1 completes. Must exist in `steps`. */
  initialStep: StepId;
  /** Phase-2-style review chat classifier. */
  reviewChat: ReviewChatConfig;
  /** Optional changelog config (M12). */
  changelog?: ChangelogConfig;
  /** Optional UI metadata. */
  ui?: PipelineUiConfig;
}

// ---------------------------------------------------------------------------
// Convenience type guards
// ---------------------------------------------------------------------------

export function isMarkdownPayload(p: SlotPayload): p is MarkdownPayload {
  return p.kind === "markdown";
}
export function isFilesetPayload(p: SlotPayload): p is FilesetPayload {
  return p.kind === "fileset";
}
export function isJsonPayload(p: SlotPayload): p is JsonPayload {
  return p.kind === "json";
}
