/**
 * Cascade preview tests (read-only — does not mutate state).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { PipelineEngine } from "../engine.ts";
import {
  FIXTURE_PIPELINE,
  FIXTURE_STEP_IDS as PRD_STEP_IDS,
  FIXTURE_SLOT_IDS as PRD_SLOT_IDS,
} from "./fixture.ts";
import { makeMarkdown, makeJson, makeFileset } from "../slots.ts";
import type { SlotPayload } from "../types.ts";

const fullSlots: Record<string, SlotPayload> = {
  [PRD_SLOT_IDS.projectContract]: makeMarkdown("# contract"),
  [PRD_SLOT_IDS.workflowMap]: makeMarkdown("# workflow map"),
  [PRD_SLOT_IDS.screenInventory]: makeMarkdown("# screen inventory"),
  [PRD_SLOT_IDS.wireframeData]: makeJson({ tasks: [] }),
  [PRD_SLOT_IDS.wireframeFiles]: makeFileset({
    "index.html": "<html></html>",
    "data.js": "window.DATA = {};",
    "home.html": "<html></html>",
  }),
};

describe("previewCascade with all slots populated (post-complete)", () => {
  const engine = new PipelineEngine(FIXTURE_PIPELINE);

  it("first-impact = workflow -> all 4 steps invalidated", () => {
    const preview = engine.previewCascade({
      firstImpactStepId: PRD_STEP_IDS.workflow,
      slots: fullSlots,
    });
    assert.equal(preview.affectedSteps.length, 4);
    assert.deepEqual([...preview.affectedSteps], [
      PRD_STEP_IDS.workflow,
      PRD_STEP_IDS.screen,
      PRD_STEP_IDS.wireframeData,
      PRD_STEP_IDS.wireframeHtml,
    ]);
    assert.deepEqual([...preview.affectedSlots], [
      PRD_SLOT_IDS.workflowMap,
      PRD_SLOT_IDS.screenInventory,
      PRD_SLOT_IDS.wireframeData,
      PRD_SLOT_IDS.wireframeFiles,
    ]);
    assert.equal(preview.endsAt.kind, "review");
    if (preview.endsAt.kind === "review") {
      assert.equal(preview.endsAt.stepId, PRD_STEP_IDS.wireframeHtml);
    }
    assert.equal(preview.isSingleItemRegen, false);
  });

  it("first-impact = screen -> 3 downstream steps invalidated", () => {
    const preview = engine.previewCascade({
      firstImpactStepId: PRD_STEP_IDS.screen,
      slots: fullSlots,
    });
    assert.deepEqual([...preview.affectedSteps], [
      PRD_STEP_IDS.screen,
      PRD_STEP_IDS.wireframeData,
      PRD_STEP_IDS.wireframeHtml,
    ]);
    // workflowMap is preserved (upstream of screen).
    assert.ok(!preview.affectedSlots.includes(PRD_SLOT_IDS.workflowMap));
  });

  it("first-impact = wireframeData -> only wireframeHtml downstream", () => {
    const preview = engine.previewCascade({
      firstImpactStepId: PRD_STEP_IDS.wireframeData,
      slots: fullSlots,
    });
    assert.deepEqual([...preview.affectedSteps], [
      PRD_STEP_IDS.wireframeData,
      PRD_STEP_IDS.wireframeHtml,
    ]);
    assert.equal(preview.isSingleItemRegen, false);
  });

  it("first-impact = wireframeHtml with item id is single-item regen", () => {
    const preview = engine.previewCascade({
      firstImpactStepId: PRD_STEP_IDS.wireframeHtml,
      firstImpactItemId: "home",
      slots: fullSlots,
    });
    assert.equal(preview.isSingleItemRegen, true);
    assert.equal(preview.affectedSteps.length, 1);
  });
});

describe("previewCascade during review (no wireframe yet)", () => {
  const engine = new PipelineEngine(FIXTURE_PIPELINE);
  const screenReviewSlots: Record<string, SlotPayload> = {
    [PRD_SLOT_IDS.projectContract]: makeMarkdown("# contract"),
    [PRD_SLOT_IDS.workflowMap]: makeMarkdown("# workflow map"),
    [PRD_SLOT_IDS.screenInventory]: makeMarkdown("# screen inventory"),
  };

  it("first-impact = workflow at screen-review -> only screen is downstream-populated", () => {
    const preview = engine.previewCascade({
      firstImpactStepId: PRD_STEP_IDS.workflow,
      slots: screenReviewSlots,
    });
    // workflow + screen are affected; wireframeData/Html are not yet
    // populated, so they don't appear in the affectedSteps set.
    assert.deepEqual([...preview.affectedSteps], [
      PRD_STEP_IDS.workflow,
      PRD_STEP_IDS.screen,
    ]);
  });

  it("first-impact = wireframeData at screen-review -> noop in affected slots (wireframeData not populated)", () => {
    const preview = engine.previewCascade({
      firstImpactStepId: PRD_STEP_IDS.wireframeData,
      slots: screenReviewSlots,
    });
    // wireframeData itself isn't populated, so no slots clear.
    // (The engine's actual cascade will detect this and emit a "not yet
    // run" system note instead of running anything.)
    assert.equal(preview.affectedSlots.length, 0);
  });
});
