/**
 * A self-contained PipelineConfig fixture for engine tests. Mirrors the
 * shape of PRD_PIPELINE (4 steps, 5 slots) but uses no-op runners so the
 * tests don't pull in prompt/parser modules (which import via TS path
 * aliases and won't resolve under Node's `--experimental-strip-types`).
 *
 * The PRD pipeline itself is exercised via `npm run typecheck` — that's
 * sufficient validation for M8 (the engine isn't called yet at runtime).
 */

import {
  docSlotId,
  phaseId,
  stepId,
  type PipelineConfig,
  type StepId,
} from "../types.ts";
import { fail, ok } from "../../parsers/types.ts";

const SLOT_CONTRACT = docSlotId("projectContract");
const SLOT_WORKFLOW_MAP = docSlotId("workflowMap");
const SLOT_SCREEN_INVENTORY = docSlotId("screenInventory");
const SLOT_WIREFRAME_DATA = docSlotId("wireframeData");
const SLOT_WIREFRAME_FILES = docSlotId("wireframeFiles");

const STEP_WORKFLOW: StepId = stepId("workflow");
const STEP_SCREEN: StepId = stepId("screen");
const STEP_WIREFRAME_DATA: StepId = stepId("wireframeData");
const STEP_WIREFRAME_HTML: StepId = stepId("wireframeHtml");

export const FIXTURE_STEP_IDS = {
  workflow: STEP_WORKFLOW,
  screen: STEP_SCREEN,
  wireframeData: STEP_WIREFRAME_DATA,
  wireframeHtml: STEP_WIREFRAME_HTML,
} as const;

export const FIXTURE_SLOT_IDS = {
  projectContract: SLOT_CONTRACT,
  workflowMap: SLOT_WORKFLOW_MAP,
  screenInventory: SLOT_SCREEN_INVENTORY,
  wireframeData: SLOT_WIREFRAME_DATA,
  wireframeFiles: SLOT_WIREFRAME_FILES,
} as const;

const NOOP_PARSER = (text: string): ReturnType<typeof ok<string>> =>
  text ? ok(text) : fail("empty");

export const FIXTURE_PIPELINE: PipelineConfig = {
  id: "fixture.v1",
  label: "Fixture",
  phases: [
    { id: phaseId("phase1"), label: "Phase 1", order: 0 },
    { id: phaseId("design"), label: "Design", order: 1 },
    { id: phaseId("wireframe"), label: "Wireframe", order: 2 },
  ],
  slots: [
    { id: SLOT_CONTRACT, label: "Project Contract", kind: "markdown" },
    { id: SLOT_WORKFLOW_MAP, label: "Workflow Map", kind: "markdown" },
    { id: SLOT_SCREEN_INVENTORY, label: "Screen Inventory", kind: "markdown" },
    { id: SLOT_WIREFRAME_DATA, label: "Sample Data", kind: "json" },
    { id: SLOT_WIREFRAME_FILES, label: "Wireframe", kind: "fileset" },
  ],
  driftAnchor: SLOT_CONTRACT,
  initialStep: STEP_WORKFLOW,
  reviewChat: {
    prompt: "phase2.conversation",
    parser: () => fail("not used in fixture tests"),
    driftPrompt: "phase2.drift_check",
    driftParser: () => fail("not used in fixture tests"),
  },
  steps: [
    {
      id: STEP_WORKFLOW,
      phase: phaseId("design"),
      label: "Workflow Map",
      scope: "workflows",
      dependsOn: [],
      produces: [SLOT_WORKFLOW_MAP],
      gate: "review",
      runner: {
        kind: "single",
        prompt: "phase2.workflow_discovery",
        buildUserMessage: () => "test",
        parser: NOOP_PARSER,
      },
    },
    {
      id: STEP_SCREEN,
      phase: phaseId("design"),
      label: "Screen Inventory",
      scope: "screens",
      dependsOn: [STEP_WORKFLOW],
      produces: [SLOT_SCREEN_INVENTORY],
      gate: "review",
      runner: {
        kind: "single",
        prompt: "phase2.screen_extract",
        buildUserMessage: () => "test",
        parser: NOOP_PARSER,
      },
    },
    {
      id: STEP_WIREFRAME_DATA,
      phase: phaseId("wireframe"),
      label: "Sample Data",
      scope: "data",
      dependsOn: [STEP_SCREEN],
      produces: [SLOT_WIREFRAME_DATA],
      gate: "auto",
      runner: {
        kind: "single",
        prompt: "phase2.dummy_data",
        buildUserMessage: () => "test",
        parser: NOOP_PARSER,
      },
    },
    {
      id: STEP_WIREFRAME_HTML,
      phase: phaseId("wireframe"),
      label: "Wireframe HTML",
      scope: "html",
      dependsOn: [STEP_SCREEN, STEP_WIREFRAME_DATA],
      produces: [SLOT_WIREFRAME_FILES],
      gate: "review",
      runner: {
        kind: "fanout",
        prompt: "phase2.screen_html",
        items: () => [{ id: "home" }, { id: "settings" }],
        itemId: (item) => (item as { id: string }).id,
        buildUserMessage: () => "test",
        parser: NOOP_PARSER,
        reduce: () => ({}),
      },
    },
  ],
};
