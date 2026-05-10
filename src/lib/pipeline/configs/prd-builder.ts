/**
 * PRD-Builder pipeline expressed as a PipelineConfig. M8 declaration only —
 * the existing wired pipeline still runs everything; this config drives
 * unit tests of the engine's read-only methods (topo, descendants,
 * stepStateFor, previewCascade) and is the migration target for M9-M10.
 *
 * Steps:
 *   workflow         (compose: discovery + detail-fanout)         -> workflowMap
 *   screen           (compose: extract + nav_validate + correct?) -> screenInventory
 *   wireframeData    (single)                                     -> wireframeData
 *   wireframeHtml    (compose: shell + screen-fanout)             -> wireframeFiles
 */

import {
  finalizeScreenList,
  parseContract,
  parseDummyData,
  parseDriftCheck,
  parseHtmlDocument,
  parseNavValidation,
  parsePhase2Conversation,
  parseScreenInventoryDoc,
  parseScreens,
  parseWorkflowDetail,
  parseWorkflowStubs,
  type DummyData,
  type ScreenSpec,
  type WorkflowDetail,
  type WorkflowStub,
  type Phase2Conversation,
} from "@/lib/parsers";
import {
  formatDataJs,
  formatScreenInventory,
  formatScreenList,
  formatWorkflowMap,
  runWireframeSmokeTest,
  type DetailedWorkflow,
} from "@/lib/operations/format-helpers";
import {
  docSlotId,
  phaseId,
  stepId,
  type ChangeHistoryWindow,
  type PipelineConfig,
  type ReviewChatClassification,
  type SlotPayload,
  type StepContext,
  type StepId,
} from "@/lib/pipeline/types";
import {
  getMarkdownContent,
  makeFileset,
  makeJson,
  makeMarkdown,
  requireJson,
  requireMarkdown,
} from "@/lib/pipeline/slots";
import type { ParseResult } from "@/lib/parsers";
import { fail, ok } from "@/lib/parsers/types";

// ---------------------------------------------------------------------------
// Slot ids
// ---------------------------------------------------------------------------

const SLOT_PROJECT_CONTRACT = docSlotId("projectContract");
const SLOT_WORKFLOW_MAP = docSlotId("workflowMap");
const SLOT_SCREEN_INVENTORY = docSlotId("screenInventory");
const SLOT_WIREFRAME_DATA = docSlotId("wireframeData");
const SLOT_WIREFRAME_FILES = docSlotId("wireframeFiles");

// ---------------------------------------------------------------------------
// Step ids
// ---------------------------------------------------------------------------

const STEP_WORKFLOW: StepId = stepId("workflow");
const STEP_SCREEN: StepId = stepId("screen");
const STEP_WIREFRAME_DATA: StepId = stepId("wireframeData");
const STEP_WIREFRAME_HTML: StepId = stepId("wireframeHtml");

// Exported so the engine, tests, and review-chat prompt can reference them.
export const PRD_STEP_IDS = {
  workflow: STEP_WORKFLOW,
  screen: STEP_SCREEN,
  wireframeData: STEP_WIREFRAME_DATA,
  wireframeHtml: STEP_WIREFRAME_HTML,
} as const;

// ---------------------------------------------------------------------------
// Inline helpers (mirror op-2-1b and op-2-3c private utilities so the
// runner code paths in M9+ don't need to reach into op files).
// ---------------------------------------------------------------------------

function trimContractForDetail(contract: string): string {
  const parsed = parseContract(contract);
  if (!parsed.ok) return contract.trim();
  return `## Personas
${parsed.value.personas}

## Entity Map
${parsed.value.entityMap}`;
}

/** Render the change-history block for a step prompt. Returns "" when
 *  there's nothing to include (initial run). The summary (if present) is
 *  rendered first so older context comes before recent verbatim entries. */
function renderChangeHistory(history?: ChangeHistoryWindow): string {
  if (!history) return "";
  const hasSummary =
    history.summary !== undefined && history.summary.trim().length > 0;
  const hasEntries = history.entries.length > 0;
  if (!hasSummary && !hasEntries) return "";

  const lines: string[] = [];
  if (hasSummary) {
    lines.push(`Summary of older changes: ${history.summary!.trim()}`);
    if (hasEntries) lines.push("");
  }
  if (hasEntries) {
    lines.push("Recent changes:");
    for (const e of history.entries) {
      lines.push(
        `- ${e.description.trim()} (first impact: ${e.firstImpactStepId}${
          e.firstImpactItemId ? `:${e.firstImpactItemId}` : ""
        })`
      );
    }
  }
  return `\n\n<change_history>\n${lines.join("\n")}\n</change_history>`;
}

function formatDataShape(data: DummyData): string {
  const lines: string[] = ["{"];
  const keys = Object.keys(data);
  keys.forEach((k, i) => {
    const v = data[k];
    if (Array.isArray(v) && v.length > 0) {
      const sample = JSON.stringify(v[0], null, 2);
      lines.push(
        `  "${k}": [ /* ${v.length} items, e.g. */ ${sample}${
          i < keys.length - 1 ? "," : ""
        }`
      );
      lines.push(`  ]`);
    } else {
      const valStr = JSON.stringify(v, null, 2);
      lines.push(`  "${k}": ${valStr}${i < keys.length - 1 ? "," : ""}`);
    }
  });
  lines.push("}");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Review chat classification — passthrough over parsePhase2Conversation
// with the registered step ids supplied as the validation allow-list.
// ---------------------------------------------------------------------------

const KNOWN_STEP_IDS = [
  STEP_WORKFLOW,
  STEP_SCREEN,
  STEP_WIREFRAME_DATA,
  STEP_WIREFRAME_HTML,
] as const;

function classifyReviewChat(
  text: string
): ParseResult<ReviewChatClassification> {
  const inner = parsePhase2Conversation(text, {
    knownStepIds: KNOWN_STEP_IDS as readonly string[],
  });
  if (!inner.ok) return fail(inner.error);
  const v: Phase2Conversation = inner.value;
  if (v.mode === "question") {
    return ok({ mode: "question", answer: v.answer });
  }
  return ok({
    mode: "change",
    summary: v.summary,
    description: v.description,
    firstImpactStepId: v.firstImpactStepId as StepId,
    firstImpactItemId: v.firstImpactItemId,
  });
}

// ---------------------------------------------------------------------------
// PipelineConfig
// ---------------------------------------------------------------------------

export const PRD_PIPELINE: PipelineConfig = {
  id: "prd-builder.v1",
  label: "PRD Builder",
  phases: [
    { id: phaseId("phase1"), label: "Phase 1 - Contract", order: 0 },
    { id: phaseId("design"), label: "Phase 2 - Design", order: 1 },
    { id: phaseId("wireframe"), label: "Phase 2 - Wireframe", order: 2 },
  ],
  slots: [
    {
      id: SLOT_PROJECT_CONTRACT,
      label: "Project Contract",
      kind: "markdown",
      fileBaseName: "project-contract.md",
      emptyMessage:
        "The Project Contract will appear here once you describe your idea in chat.",
    },
    {
      id: SLOT_WORKFLOW_MAP,
      label: "Workflow Map",
      kind: "markdown",
      fileBaseName: "workflow-map.md",
      emptyMessage:
        "The Workflow Map will appear here after Phase 1 is validated.",
    },
    {
      id: SLOT_SCREEN_INVENTORY,
      label: "Screen Inventory",
      kind: "markdown",
      fileBaseName: "screen-inventory.md",
      emptyMessage:
        "The Screen Inventory will appear here after the workflows are approved.",
    },
    {
      id: SLOT_WIREFRAME_DATA,
      label: "Sample Data",
      kind: "json",
      fileBaseName: "wireframe/data.js",
      emptyMessage: "Sample data is generated as part of the wireframe stage.",
    },
    {
      id: SLOT_WIREFRAME_FILES,
      label: "Wireframe",
      kind: "fileset",
      emptyMessage:
        "The Wireframe will appear here after the screens are approved.",
    },
  ],
  driftAnchor: SLOT_PROJECT_CONTRACT,
  initialStep: STEP_WORKFLOW,
  ui: {
    initialChatPlaceholder: "e.g. I want to build a simple todo app",
    interactiveSlot: SLOT_PROJECT_CONTRACT,
  },
  reviewChat: {
    prompt: "phase2.conversation",
    parser: classifyReviewChat,
    driftPrompt: "phase2.drift_check",
    driftParser: parseDriftCheck,
    buildSystemContext: (slots) => {
      const contract =
        getMarkdownContent(slots, SLOT_PROJECT_CONTRACT) ?? "";
      const workflowMap =
        getMarkdownContent(slots, SLOT_WORKFLOW_MAP) ?? "";
      const screenInventory =
        getMarkdownContent(slots, SLOT_SCREEN_INVENTORY) ?? "";

      let block = `\n\n<project_contract>
${contract.trim()}
</project_contract>

<workflow_map>
${workflowMap.trim()}
</workflow_map>

<screen_inventory>
${screenInventory.trim()}
</screen_inventory>`;

      const wireframe = slots[SLOT_WIREFRAME_FILES];
      if (wireframe && wireframe.kind === "fileset") {
        const screenIds = Object.keys(wireframe.files)
          .filter((f) => f.endsWith(".html") && f !== "index.html")
          .map((f) => f.replace(/\.html$/, ""));
        block += `\n\n<wireframe_state>
A clickable wireframe has been generated (version ${wireframe.version}). Screen ids with rendered HTML files: ${screenIds.join(", ")}.
</wireframe_state>`;
      }
      return block;
    },
  },
  steps: [
    // -------------------------------------------------------------------
    // Step: workflow (compose: discovery + detail fanout)
    // -------------------------------------------------------------------
    {
      id: STEP_WORKFLOW,
      phase: phaseId("design"),
      label: "Workflow Map",
      scope:
        "Decisions about what user-facing flows the product supports (e.g., add a new workflow, rename a flow, change a flow's purpose).",
      dependsOn: [],
      produces: [SLOT_WORKFLOW_MAP],
      gate: "review",
      reviewPlaceholder: "Ask about the workflows or request a change...",
      approveLabel: "Approve → Generate Screens",
      runner: {
        kind: "compose",
        substeps: [
          {
            id: "discovery",
            kind: "single",
            prompt: "phase2.workflow_discovery",
            buildUserMessage: (ctx) => {
              const contract = requireMarkdown(
                ctx.inputs,
                SLOT_PROJECT_CONTRACT
              ).content;
              let block = `<contract>\n${contract.trim()}\n</contract>`;
              const priorWorkflowMap = ctx.priorOutputs?.[SLOT_WORKFLOW_MAP];
              if (priorWorkflowMap?.kind === "markdown") {
                block += `\n\n<existing_workflows>\n${priorWorkflowMap.content.trim()}\n</existing_workflows>`;
              }
              block += renderChangeHistory(ctx.changeHistory);
              if (ctx.feedback) {
                block += `\n\n<user_feedback>\n${ctx.feedback.trim()}\n</user_feedback>`;
              }
              return block;
            },
            parser: parseWorkflowStubs,
          },
          {
            id: "detail",
            kind: "fanout",
            prompt: "phase2.workflow_detail",
            items: (_ctx, sub) => sub.discovery as WorkflowStub[],
            itemId: (item, idx) => `detail:${idx}:${(item as WorkflowStub).name}`,
            buildUserMessage: (ctx, _sub, item) => {
              const contract = requireMarkdown(
                ctx.inputs,
                SLOT_PROJECT_CONTRACT
              ).content;
              const stub = item as WorkflowStub;
              return `<contract>
${trimContractForDetail(contract)}
</contract>

<workflow>
**${stub.name}** — ${stub.description}
</workflow>`;
            },
            parser: parseWorkflowDetail,
            concurrency: 1,
            reduce: (_items, results) => results,
          },
        ],
        reduce: (sub) => {
          const stubs = sub.discovery as WorkflowStub[];
          const details = sub.detail as WorkflowDetail[];
          const detailed: DetailedWorkflow[] = stubs.map((stub, i) => ({
            ...stub,
            detail: details[i]!,
          }));
          return {
            [SLOT_WORKFLOW_MAP]: makeMarkdown(formatWorkflowMap(detailed)),
          };
        },
      },
    },
    // -------------------------------------------------------------------
    // Step: screen (compose: extract + validate + correct?)
    // -------------------------------------------------------------------
    {
      id: STEP_SCREEN,
      phase: phaseId("design"),
      label: "Screen Inventory",
      scope:
        "Decisions about which screens exist, what each screen shows, and how screens link to one another (e.g., add a screen, change a screen's purpose, fix a navigation gap).",
      dependsOn: [STEP_WORKFLOW],
      produces: [SLOT_SCREEN_INVENTORY],
      gate: "review",
      reviewPlaceholder: "Ask about the screens or request a change...",
      approveLabel: "Approve → Generate Wireframe",
      runner: {
        kind: "compose",
        substeps: [
          {
            id: "extract",
            kind: "single",
            prompt: "phase2.screen_extract",
            buildUserMessage: (ctx) => {
              const contract = requireMarkdown(
                ctx.inputs,
                SLOT_PROJECT_CONTRACT
              ).content;
              const workflowMap = requireMarkdown(
                ctx.inputs,
                SLOT_WORKFLOW_MAP
              ).content;
              let block = `<contract>
${contract.trim()}
</contract>

<workflow_map>
${workflowMap.trim()}
</workflow_map>`;
              const priorScreens = ctx.priorOutputs?.[SLOT_SCREEN_INVENTORY];
              if (priorScreens?.kind === "markdown") {
                block += `\n\n<existing_screens>\n${priorScreens.content.trim()}\n</existing_screens>`;
              }
              block += renderChangeHistory(ctx.changeHistory);
              if (ctx.feedback) {
                block += `\n\n<user_feedback>\n${ctx.feedback.trim()}\n</user_feedback>`;
              }
              return block;
            },
            parser: parseScreens,
          },
          {
            id: "validate",
            kind: "single",
            prompt: "phase2.nav_validate",
            buildUserMessage: (ctx, sub) => {
              const workflowMap = requireMarkdown(
                ctx.inputs,
                SLOT_WORKFLOW_MAP
              ).content;
              const screens = sub.extract as ScreenSpec[];
              return `<workflow_map>
${workflowMap.trim()}
</workflow_map>

<screens>
${formatScreenList(screens)}
</screens>`;
            },
            parser: parseNavValidation,
          },
          {
            id: "correct",
            kind: "single",
            prompt: "phase2.screen_correct",
            buildUserMessage: (ctx, sub) => {
              const workflowMap = requireMarkdown(
                ctx.inputs,
                SLOT_WORKFLOW_MAP
              ).content;
              const screens = sub.extract as ScreenSpec[];
              const validation = sub.validate as
                | { status: "ok" }
                | { status: "gaps"; gaps: string[] };
              const gaps =
                validation.status === "gaps" ? validation.gaps : [];
              return `<screens>
${formatScreenList(screens)}
</screens>

<workflow_map>
${workflowMap.trim()}
</workflow_map>

<gaps>
${gaps.map((g) => `- ${g}`).join("\n")}
</gaps>`;
            },
            parser: parseScreens,
            skipIf: (sub) => {
              const v = sub.validate as { status: "ok" | "gaps" } | undefined;
              return !v || v.status === "ok";
            },
          },
        ],
        reduce: (sub) => {
          const raw = (sub.correct ?? sub.extract) as ScreenSpec[];
          // Drop any dangling nav targets that nav_validate / screen_correct
          // didn't fix. Defends the saved Screen Inventory against
          // intra-list inconsistencies the wireframe stage would otherwise
          // surface as broken hrefs in the smoke test.
          const { screens } = finalizeScreenList(raw);
          return {
            [SLOT_SCREEN_INVENTORY]: makeMarkdown(formatScreenInventory(screens)),
          };
        },
      },
    },
    // -------------------------------------------------------------------
    // Step: wireframeData (single, gate=auto)
    // -------------------------------------------------------------------
    {
      id: STEP_WIREFRAME_DATA,
      phase: phaseId("wireframe"),
      label: "Sample Data",
      scope:
        "Decisions about the realistic sample content that populates the wireframe (e.g., make task names shorter, change the example product list).",
      dependsOn: [STEP_SCREEN],
      produces: [SLOT_WIREFRAME_DATA],
      gate: "auto",
      runner: {
        kind: "single",
        prompt: "phase2.dummy_data",
        buildUserMessage: (ctx) => {
          const contract = requireMarkdown(
            ctx.inputs,
            SLOT_PROJECT_CONTRACT
          ).content;
          const screenInventory = requireMarkdown(
            ctx.inputs,
            SLOT_SCREEN_INVENTORY
          ).content;
          let block = `<contract>
${contract.trim()}
</contract>

<screen_inventory>
${screenInventory.trim()}
</screen_inventory>`;
          const priorData = ctx.priorOutputs?.[SLOT_WIREFRAME_DATA];
          if (priorData?.kind === "json") {
            block += `\n\n<existing_sample_data>\n${JSON.stringify(priorData.data, null, 2)}\n</existing_sample_data>`;
          }
          block += renderChangeHistory(ctx.changeHistory);
          if (ctx.feedback) {
            block += `\n\n<user_feedback>\n${ctx.feedback.trim()}\n</user_feedback>`;
          }
          return block;
        },
        parser: parseDummyData,
        format: (parsed) => ({
          [SLOT_WIREFRAME_DATA]: makeJson(parsed as DummyData),
        }),
      },
    },
    // -------------------------------------------------------------------
    // Step: wireframeHtml (compose: shell + per-screen fanout)
    // -------------------------------------------------------------------
    {
      id: STEP_WIREFRAME_HTML,
      phase: phaseId("wireframe"),
      label: "Wireframe HTML",
      scope:
        "Decisions about the rendered HTML — visual layout, copy on a single screen, structural fixes for one or more screens.",
      dependsOn: [STEP_SCREEN, STEP_WIREFRAME_DATA],
      produces: [SLOT_WIREFRAME_FILES],
      gate: "review",
      reviewPlaceholder:
        "Ask about the wireframe, request a content tweak, or change a screen...",
      approveLabel: "Approve → Mark Complete",
      runner: {
        kind: "compose",
        substeps: [
          {
            id: "shell",
            kind: "single",
            prompt: "phase2.wireframe_shell",
            buildUserMessage: (ctx) => {
              const contract = requireMarkdown(
                ctx.inputs,
                SLOT_PROJECT_CONTRACT
              ).content;
              const inventory =
                getMarkdownContent(ctx.inputs, SLOT_SCREEN_INVENTORY) ?? "";
              const parsed = parseScreenInventoryDoc(inventory);
              if (!parsed.ok) {
                throw new Error(
                  `wireframe shell: cannot parse screen inventory: ${parsed.error}`
                );
              }
              const screens = parsed.value;
              const screensBlock = screens
                .map((s) => `- ${s.id} — ${s.purpose}`)
                .join("\n");
              return `<contract>
${contract.trim()}
</contract>

<screens>
${screensBlock}
</screens>`;
            },
            parser: parseHtmlDocument,
            // Single-item regen (cascade with target set) keeps the
            // previously-generated index.html. The reduce function pulls
            // the prior shell out of ctx.inputs[wireframeFiles].
            skipIf: (_sub, ctx) => Boolean(ctx.target),
          },
          {
            id: "screens",
            kind: "fanout",
            prompt: "phase2.screen_html",
            items: (ctx) => {
              const inventory =
                getMarkdownContent(ctx.inputs, SLOT_SCREEN_INVENTORY) ?? "";
              const parsed = parseScreenInventoryDoc(inventory);
              if (!parsed.ok) {
                throw new Error(
                  `wireframe screens: cannot parse screen inventory: ${parsed.error}`
                );
              }
              return parsed.value;
            },
            itemId: (item) => (item as ScreenSpec).id,
            buildUserMessage: (ctx, _sub, item) => {
              const contract = requireMarkdown(
                ctx.inputs,
                SLOT_PROJECT_CONTRACT
              ).content;
              const data = requireJson(
                ctx.inputs,
                SLOT_WIREFRAME_DATA
              ).data as DummyData;
              const inventory =
                getMarkdownContent(ctx.inputs, SLOT_SCREEN_INVENTORY) ?? "";
              const parsed = parseScreenInventoryDoc(inventory);
              if (!parsed.ok) {
                throw new Error(
                  `screen html: cannot parse screen inventory: ${parsed.error}`
                );
              }
              const allScreens = parsed.value;
              const screen = item as ScreenSpec;
              const screensBlock = allScreens
                .map((s) => `- ${s.id} — ${s.purpose}`)
                .join("\n");
              const navTargets =
                screen.nav.length === 0 ? "(none)" : screen.nav.join(", ");
              const screenBlock = `id: ${screen.id}
purpose: ${screen.purpose}
shows: ${screen.shows}
nav: ${navTargets}`;
              const dataShape = formatDataShape(data);
              return `<contract>
${contract.trim()}
</contract>

<screens>
${screensBlock}
</screens>

<screen>
${screenBlock}
</screen>

<data_shape>
${dataShape}
</data_shape>`;
            },
            parser: parseHtmlDocument,
            concurrency: 1,
            reduce: (items, results) => {
              const out: Record<string, string> = {};
              items.forEach((item, idx) => {
                const screen = item as ScreenSpec;
                out[`${screen.id}.html`] = results[idx] as string;
              });
              return out;
            },
          },
        ],
        reduce: (sub, ctx) => {
          // Shell substep may be skipped during single-item regen
          // (cascade with ctx.target set). Reuse the prior index.html
          // from the existing fileset in that case.
          let shell: string;
          if (typeof sub.shell === "string") {
            shell = sub.shell;
          } else {
            const priorFileset = ctx.inputs[SLOT_WIREFRAME_FILES];
            if (!priorFileset || priorFileset.kind !== "fileset") {
              throw new Error(
                "wireframeHtml reduce: shell substep was skipped but no prior fileset available to reuse index.html"
              );
            }
            const priorShell = priorFileset.files["index.html"];
            if (!priorShell) {
              throw new Error(
                "wireframeHtml reduce: prior fileset has no index.html"
              );
            }
            shell = priorShell;
          }

          const screenFiles = sub.screens as Record<string, string>;
          const data = requireJson(
            ctx.inputs,
            SLOT_WIREFRAME_DATA
          ).data as DummyData;
          const inventory =
            getMarkdownContent(ctx.inputs, SLOT_SCREEN_INVENTORY) ?? "";
          const parsed = parseScreenInventoryDoc(inventory);
          if (!parsed.ok) {
            throw new Error(
              `wireframe smoke: cannot parse screen inventory: ${parsed.error}`
            );
          }
          const files: Record<string, string> = {
            "index.html": shell,
            "data.js": formatDataJs(data),
            ...screenFiles,
          };
          const issues = runWireframeSmokeTest(parsed.value, files);
          if (issues.length > 0) {
            throw new Error(`wireframe smoke test: ${issues.join("; ")}`);
          }
          return {
            [SLOT_WIREFRAME_FILES]: makeFileset(files),
          };
        },
      },
    },
  ],
  changelog: {
    autoSummarize: true,
    maxEntries: 200,
    // diffSummaryPrompt is added in M12.
  },
};

// Re-export commonly needed slot/step ids so consumers don't have to
// re-derive the brand types.
export const PRD_SLOT_IDS = {
  projectContract: SLOT_PROJECT_CONTRACT,
  workflowMap: SLOT_WORKFLOW_MAP,
  screenInventory: SLOT_SCREEN_INVENTORY,
  wireframeData: SLOT_WIREFRAME_DATA,
  wireframeFiles: SLOT_WIREFRAME_FILES,
} as const;

// Suppress unused import lint for SlotPayload + StepContext (used only as
// types in the runner body when narrowed via accessors).
type _Unused = SlotPayload | StepContext;
