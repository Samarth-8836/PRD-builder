/**
 * Research-Report pipeline (M13). Genericity proof for the framework: the
 * same engine + UI + storage + cascade machinery hosts a totally different
 * domain.
 *
 * Stages:
 *   outline   (single, gate=review)         -> outline.md
 *   sections  (fanout over outline items)   -> sections (markdown — concat)
 *   edit      (single, gate=terminal)       -> finalReport.md
 *
 * Phase 1: the user's first message is captured as the `brief` slot
 * verbatim (no LLM-driven extraction). A trivial validate step transitions
 * to phase1_complete. Phase 1 conversation is a pass-through Q&A.
 */

import {
  parseDriftCheck,
  parsePhase2Conversation,
  type Phase2Conversation,
} from "@/lib/parsers";
import {
  parseOutline,
  parseSection,
  type OutlineSection,
} from "@/lib/parsers/research-report";
import {
  docSlotId,
  phaseId,
  stepId,
  type ChangeHistoryWindow,
  type PipelineConfig,
  type ReviewChatClassification,
  type StepId,
} from "@/lib/pipeline/types";
import {
  getMarkdownContent,
  makeMarkdown,
  requireMarkdown,
} from "@/lib/pipeline/slots";
import type { ParseResult } from "@/lib/parsers";
import { fail, ok } from "@/lib/parsers/types";

// ---------------------------------------------------------------------------
// Slot ids
// ---------------------------------------------------------------------------

const SLOT_BRIEF = docSlotId("brief");
const SLOT_OUTLINE = docSlotId("outline");
const SLOT_SECTIONS = docSlotId("sections");
const SLOT_FINAL_REPORT = docSlotId("finalReport");

// ---------------------------------------------------------------------------
// Step ids
// ---------------------------------------------------------------------------

const STEP_OUTLINE: StepId = stepId("outline");
const STEP_SECTIONS: StepId = stepId("sections");
const STEP_EDIT: StepId = stepId("edit");

export const RESEARCH_REPORT_STEP_IDS = {
  outline: STEP_OUTLINE,
  sections: STEP_SECTIONS,
  edit: STEP_EDIT,
} as const;

export const RESEARCH_REPORT_SLOT_IDS = {
  brief: SLOT_BRIEF,
  outline: SLOT_OUTLINE,
  sections: SLOT_SECTIONS,
  finalReport: SLOT_FINAL_REPORT,
} as const;

// ---------------------------------------------------------------------------
// Helpers — change-history block (mirrors prd-builder.renderChangeHistory)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Review-chat classifier — passthrough over parsePhase2Conversation
// ---------------------------------------------------------------------------

const KNOWN_STEP_IDS = [STEP_OUTLINE, STEP_SECTIONS, STEP_EDIT] as const;

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

export const RESEARCH_REPORT_PIPELINE: PipelineConfig = {
  id: "research-report.v1",
  label: "Research Report",
  phases: [
    { id: phaseId("brief"), label: "Phase 1 - Brief", order: 0 },
    { id: phaseId("draft"), label: "Phase 2 - Draft", order: 1 },
    { id: phaseId("finalize"), label: "Phase 2 - Finalize", order: 2 },
  ],
  slots: [
    {
      id: SLOT_BRIEF,
      label: "Research Brief",
      kind: "markdown",
      fileBaseName: "research-brief.md",
      emptyMessage:
        "The Research Brief will appear here once you describe your research topic.",
    },
    {
      id: SLOT_OUTLINE,
      label: "Outline",
      kind: "markdown",
      fileBaseName: "outline.md",
      emptyMessage:
        "The Outline will appear here after Phase 1 is validated.",
    },
    {
      id: SLOT_SECTIONS,
      label: "Section Drafts",
      kind: "markdown",
      fileBaseName: "section-drafts.md",
      emptyMessage:
        "Section drafts will appear here after the outline is approved.",
    },
    {
      id: SLOT_FINAL_REPORT,
      label: "Final Report",
      kind: "markdown",
      fileBaseName: "final-report.md",
      emptyMessage:
        "The polished final report will appear here after section drafts are approved.",
    },
  ],
  driftAnchor: SLOT_BRIEF,
  initialStep: STEP_OUTLINE,
  ui: {
    initialChatPlaceholder:
      "e.g. The economic impact of remote work on mid-sized US cities (2020-2025)",
    interactiveSlot: SLOT_BRIEF,
  },
  reviewChat: {
    prompt: "research_report.review_chat",
    parser: classifyReviewChat,
    driftPrompt: "research_report.drift_check",
    driftParser: parseDriftCheck,
    buildSystemContext: (slots) => {
      const brief = getMarkdownContent(slots, SLOT_BRIEF) ?? "";
      const outline = getMarkdownContent(slots, SLOT_OUTLINE) ?? "";
      const sections = getMarkdownContent(slots, SLOT_SECTIONS) ?? "";
      const finalReport = getMarkdownContent(slots, SLOT_FINAL_REPORT) ?? "";

      let block = `\n\n<brief>
${brief.trim()}
</brief>`;
      if (outline.trim().length > 0) {
        block += `\n\n<outline>
${outline.trim()}
</outline>`;
      }
      if (sections.trim().length > 0) {
        block += `\n\n<sections>
${sections.trim()}
</sections>`;
      }
      if (finalReport.trim().length > 0) {
        block += `\n\n<final_report>
${finalReport.trim()}
</final_report>`;
      }
      return block;
    },
  },
  steps: [
    // -------------------------------------------------------------------
    // Step: outline (single, gate=review)
    // -------------------------------------------------------------------
    {
      id: STEP_OUTLINE,
      phase: phaseId("draft"),
      label: "Outline",
      scope:
        "Decisions about the structure of the report — which sections to include, what each section covers (e.g., add a methodology section, drop a section, reframe the conclusion).",
      dependsOn: [],
      produces: [SLOT_OUTLINE],
      gate: "review",
      modelRole: "reasoning",
      reviewPlaceholder: "Ask about the outline or request a structural change...",
      approveLabel: "Approve → Draft Sections",
      runner: {
        kind: "single",
        prompt: "research_report.outline",
        buildUserMessage: (ctx) => {
          const brief = requireMarkdown(ctx.inputs, SLOT_BRIEF).content;
          let block = `<brief>\n${brief.trim()}\n</brief>`;
          const priorOutline = ctx.priorOutputs?.[SLOT_OUTLINE];
          if (priorOutline?.kind === "markdown") {
            block += `\n\n<existing_outline>\n${priorOutline.content.trim()}\n</existing_outline>`;
          }
          block += renderChangeHistory(ctx.changeHistory);
          if (ctx.feedback) {
            block += `\n\n<user_feedback>\n${ctx.feedback.trim()}\n</user_feedback>`;
          }
          return block;
        },
        parser: parseOutline,
        format: (parsed) => ({
          [SLOT_OUTLINE]: makeMarkdown(formatOutline(parsed as OutlineSection[])),
        }),
      },
    },
    // -------------------------------------------------------------------
    // Step: sections (fanout over outline items, gate=review)
    // -------------------------------------------------------------------
    {
      id: STEP_SECTIONS,
      phase: phaseId("draft"),
      label: "Section Drafts",
      scope:
        "Decisions about the substance and detail inside one or more sections (e.g., expand the methodology, tighten the literature review, add a case study to a section).",
      dependsOn: [STEP_OUTLINE],
      produces: [SLOT_SECTIONS],
      gate: "review",
      modelRole: "reasoning",
      reviewPlaceholder: "Ask about a section or request a content change...",
      approveLabel: "Approve → Polish Final Report",
      runner: {
        kind: "fanout",
        prompt: "research_report.section_draft",
        items: (ctx) => {
          const outline = requireMarkdown(ctx.inputs, SLOT_OUTLINE).content;
          const parsed = parseOutline(outline);
          if (!parsed.ok) {
            throw new Error(
              `sections fanout: cannot parse outline: ${parsed.error}`
            );
          }
          return parsed.value;
        },
        itemId: (item) => (item as OutlineSection).id,
        buildUserMessage: (ctx, item) => {
          const brief = requireMarkdown(ctx.inputs, SLOT_BRIEF).content;
          const outline = requireMarkdown(ctx.inputs, SLOT_OUTLINE).content;
          const section = item as OutlineSection;
          let block = `<brief>
${brief.trim()}
</brief>

<outline>
${outline.trim()}
</outline>

<section>
id: ${section.id}
title: ${section.title}
purpose: ${section.purpose}
</section>`;
          block += renderChangeHistory(ctx.changeHistory);
          if (ctx.feedback) {
            block += `\n\n<user_feedback>\n${ctx.feedback.trim()}\n</user_feedback>`;
          }
          return block;
        },
        parser: parseSection,
        concurrency: 1,
        reduce: (items, results) => {
          // Concatenate all section bodies into one markdown document.
          const lines: string[] = [];
          items.forEach((it, idx) => {
            const sec = it as OutlineSection;
            const body = (results[idx] as string).trim();
            lines.push(`## ${sec.title}`);
            lines.push("");
            lines.push(body);
            lines.push("");
          });
          return {
            [SLOT_SECTIONS]: makeMarkdown(lines.join("\n").trim() + "\n"),
          };
        },
      },
    },
    // -------------------------------------------------------------------
    // Step: edit (single, gate=terminal)
    // -------------------------------------------------------------------
    {
      id: STEP_EDIT,
      phase: phaseId("finalize"),
      label: "Final Report",
      scope:
        "Decisions about the polish, voice, framing, and overall flow of the final report (e.g., make it more accessible, tighten transitions, strengthen the executive summary).",
      dependsOn: [STEP_SECTIONS],
      produces: [SLOT_FINAL_REPORT],
      gate: "review",
      modelRole: "reasoning",
      reviewPlaceholder:
        "Ask about the final report or request a polish change...",
      approveLabel: "Approve → Mark Complete",
      runner: {
        kind: "single",
        prompt: "research_report.edit",
        buildUserMessage: (ctx) => {
          const brief = requireMarkdown(ctx.inputs, SLOT_BRIEF).content;
          const sections = requireMarkdown(ctx.inputs, SLOT_SECTIONS).content;
          let block = `<brief>
${brief.trim()}
</brief>

<sections>
${sections.trim()}
</sections>`;
          const priorFinal = ctx.priorOutputs?.[SLOT_FINAL_REPORT];
          if (priorFinal?.kind === "markdown") {
            block += `\n\n<existing_final_report>\n${priorFinal.content.trim()}\n</existing_final_report>`;
          }
          block += renderChangeHistory(ctx.changeHistory);
          if (ctx.feedback) {
            block += `\n\n<user_feedback>\n${ctx.feedback.trim()}\n</user_feedback>`;
          }
          return block;
        },
        parser: (text) => ok(text.trim()),
        format: (parsed) => ({
          [SLOT_FINAL_REPORT]: makeMarkdown(parsed as string),
        }),
      },
    },
  ],
  changelog: {
    autoSummarize: true,
    maxEntries: 200,
  },
};

function formatOutline(sections: OutlineSection[]): string {
  const lines: string[] = ["# Outline", ""];
  for (const s of sections) {
    lines.push(`## ${s.id} — ${s.title}`);
    lines.push("");
    lines.push(s.purpose);
    lines.push("");
  }
  return lines.join("\n").trim() + "\n";
}
