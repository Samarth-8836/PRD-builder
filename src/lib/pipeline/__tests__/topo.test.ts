/**
 * Pipeline engine topology tests. Run with:
 *   node --experimental-strip-types --test src/lib/pipeline/__tests__/topo.test.ts
 *
 * Also runs as part of `npm run typecheck` to verify the config typechecks.
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

describe("PipelineEngine: FIXTURE_PIPELINE topology", () => {
  const engine = new PipelineEngine(FIXTURE_PIPELINE);

  it("topo order has all 4 steps", () => {
    const order = engine.topoOrder();
    assert.equal(order.length, 4);
  });

  it("workflow comes before screen", () => {
    const order = engine.topoOrder();
    const wfIdx = order.indexOf(PRD_STEP_IDS.workflow);
    const scIdx = order.indexOf(PRD_STEP_IDS.screen);
    assert.ok(wfIdx >= 0 && scIdx >= 0);
    assert.ok(wfIdx < scIdx, `expected workflow before screen, got ${wfIdx} vs ${scIdx}`);
  });

  it("screen and wireframeData come before wireframeHtml", () => {
    const order = engine.topoOrder();
    const scIdx = order.indexOf(PRD_STEP_IDS.screen);
    const wdIdx = order.indexOf(PRD_STEP_IDS.wireframeData);
    const whIdx = order.indexOf(PRD_STEP_IDS.wireframeHtml);
    assert.ok(scIdx < whIdx);
    assert.ok(wdIdx < whIdx);
  });
});

describe("PipelineEngine: stepsAfter (transitive descendants)", () => {
  const engine = new PipelineEngine(FIXTURE_PIPELINE);

  it("stepsAfter(workflow) = [screen, wireframeData, wireframeHtml]", () => {
    const after = engine.stepsAfter(PRD_STEP_IDS.workflow);
    assert.deepEqual(
      [...after],
      [
        PRD_STEP_IDS.screen,
        PRD_STEP_IDS.wireframeData,
        PRD_STEP_IDS.wireframeHtml,
      ]
    );
  });

  it("stepsAfter(screen) = [wireframeData, wireframeHtml]", () => {
    const after = engine.stepsAfter(PRD_STEP_IDS.screen);
    assert.deepEqual(
      [...after],
      [PRD_STEP_IDS.wireframeData, PRD_STEP_IDS.wireframeHtml]
    );
  });

  it("stepsAfter(wireframeData) = [wireframeHtml]", () => {
    const after = engine.stepsAfter(PRD_STEP_IDS.wireframeData);
    assert.deepEqual([...after], [PRD_STEP_IDS.wireframeHtml]);
  });

  it("stepsAfter(wireframeHtml) = [] (terminal)", () => {
    const after = engine.stepsAfter(PRD_STEP_IDS.wireframeHtml);
    assert.deepEqual([...after], []);
  });
});

describe("PipelineEngine: nextRunnableStep", () => {
  const engine = new PipelineEngine(FIXTURE_PIPELINE);

  it("with only contract -> workflow is next", () => {
    const slots: Record<string, SlotPayload> = {
      [PRD_SLOT_IDS.projectContract]: makeMarkdown("# contract"),
    };
    assert.equal(engine.nextRunnableStep(slots), PRD_STEP_IDS.workflow);
  });

  it("with contract + workflowMap -> screen is next", () => {
    const slots: Record<string, SlotPayload> = {
      [PRD_SLOT_IDS.projectContract]: makeMarkdown("# contract"),
      [PRD_SLOT_IDS.workflowMap]: makeMarkdown("# workflow map"),
    };
    assert.equal(engine.nextRunnableStep(slots), PRD_STEP_IDS.screen);
  });

  it("with contract + workflow + screen -> wireframeData is next", () => {
    const slots: Record<string, SlotPayload> = {
      [PRD_SLOT_IDS.projectContract]: makeMarkdown("# contract"),
      [PRD_SLOT_IDS.workflowMap]: makeMarkdown("# workflow map"),
      [PRD_SLOT_IDS.screenInventory]: makeMarkdown("# screen inventory"),
    };
    assert.equal(engine.nextRunnableStep(slots), PRD_STEP_IDS.wireframeData);
  });

  it("with all upstream populated -> wireframeHtml is next", () => {
    const slots: Record<string, SlotPayload> = {
      [PRD_SLOT_IDS.projectContract]: makeMarkdown("# contract"),
      [PRD_SLOT_IDS.workflowMap]: makeMarkdown("# workflow map"),
      [PRD_SLOT_IDS.screenInventory]: makeMarkdown("# screen inventory"),
      [PRD_SLOT_IDS.wireframeData]: makeJson({ tasks: [] }),
    };
    assert.equal(engine.nextRunnableStep(slots), PRD_STEP_IDS.wireframeHtml);
  });

  it("with everything populated -> null", () => {
    const slots: Record<string, SlotPayload> = {
      [PRD_SLOT_IDS.projectContract]: makeMarkdown("# contract"),
      [PRD_SLOT_IDS.workflowMap]: makeMarkdown("# workflow map"),
      [PRD_SLOT_IDS.screenInventory]: makeMarkdown("# screen inventory"),
      [PRD_SLOT_IDS.wireframeData]: makeJson({ tasks: [] }),
      [PRD_SLOT_IDS.wireframeFiles]: makeFileset({ "index.html": "<html></html>" }),
    };
    assert.equal(engine.nextRunnableStep(slots), null);
  });
});

describe("PipelineEngine: rejects invalid configs", () => {
  it("rejects unknown step in dependsOn", () => {
    assert.throws(
      () =>
        new PipelineEngine({
          ...FIXTURE_PIPELINE,
          steps: [
            {
              ...FIXTURE_PIPELINE.steps[0]!,
              dependsOn: ["ghost-step" as never],
            },
          ],
        }),
      /unknown dependency/
    );
  });

  it("rejects step that produces an unknown slot", () => {
    assert.throws(
      () =>
        new PipelineEngine({
          ...FIXTURE_PIPELINE,
          steps: FIXTURE_PIPELINE.steps.map((s, i) =>
            i === 0
              ? { ...s, produces: [PRD_SLOT_IDS.projectContract, "ghost-slot" as never] }
              : s
          ),
        }),
      /unknown slot/
    );
  });
});
