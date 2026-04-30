/**
 * SessionLifecycle transition tests.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { canTransition } from "../state.ts";
import {
  FIXTURE_PIPELINE,
  FIXTURE_STEP_IDS as PRD_STEP_IDS,
} from "./fixture.ts";

describe("SessionLifecycle transitions", () => {
  it("phase1 -> phase1_complete is allowed", () => {
    assert.ok(canTransition({ kind: "phase1" }, { kind: "phase1_complete" }, FIXTURE_PIPELINE));
  });

  it("phase1_complete -> running:initialStep is allowed", () => {
    assert.ok(
      canTransition(
        { kind: "phase1_complete" },
        { kind: "running", stepId: FIXTURE_PIPELINE.initialStep },
        FIXTURE_PIPELINE
      )
    );
  });

  it("phase1_complete -> running:non-initial is rejected", () => {
    assert.ok(
      !canTransition(
        { kind: "phase1_complete" },
        { kind: "running", stepId: PRD_STEP_IDS.wireframeHtml },
        FIXTURE_PIPELINE
      )
    );
  });

  it("running -> review (same step) is allowed", () => {
    assert.ok(
      canTransition(
        { kind: "running", stepId: PRD_STEP_IDS.workflow },
        { kind: "review", stepId: PRD_STEP_IDS.workflow },
        FIXTURE_PIPELINE
      )
    );
  });

  it("running -> review (different step) is rejected", () => {
    assert.ok(
      !canTransition(
        { kind: "running", stepId: PRD_STEP_IDS.workflow },
        { kind: "review", stepId: PRD_STEP_IDS.screen },
        FIXTURE_PIPELINE
      )
    );
  });

  it("running -> running (next step) is allowed", () => {
    assert.ok(
      canTransition(
        { kind: "running", stepId: PRD_STEP_IDS.wireframeData },
        { kind: "running", stepId: PRD_STEP_IDS.wireframeHtml },
        FIXTURE_PIPELINE
      )
    );
  });

  it("review -> running is allowed", () => {
    assert.ok(
      canTransition(
        { kind: "review", stepId: PRD_STEP_IDS.workflow },
        { kind: "running", stepId: PRD_STEP_IDS.screen },
        FIXTURE_PIPELINE
      )
    );
  });

  it("review -> complete is allowed", () => {
    assert.ok(
      canTransition(
        { kind: "review", stepId: PRD_STEP_IDS.wireframeHtml },
        { kind: "complete" },
        FIXTURE_PIPELINE
      )
    );
  });

  it("complete -> running (iteration) is allowed", () => {
    assert.ok(
      canTransition(
        { kind: "complete" },
        { kind: "running", stepId: PRD_STEP_IDS.workflow },
        FIXTURE_PIPELINE
      )
    );
  });

  it("any -> phase1 (rollback) is always allowed", () => {
    assert.ok(canTransition({ kind: "complete" }, { kind: "phase1" }, FIXTURE_PIPELINE));
    assert.ok(
      canTransition(
        { kind: "review", stepId: PRD_STEP_IDS.wireframeHtml },
        { kind: "phase1" },
        FIXTURE_PIPELINE
      )
    );
    assert.ok(
      canTransition(
        { kind: "running", stepId: PRD_STEP_IDS.workflow },
        { kind: "phase1" },
        FIXTURE_PIPELINE
      )
    );
  });
});
