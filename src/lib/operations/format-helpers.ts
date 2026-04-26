import type {
  ScreenSpec,
  WorkflowDetail,
  WorkflowStub,
} from "@/lib/parsers";

/**
 * Code-only formatters for the two Phase 2 documents that the spec lists
 * as "formatting" steps. Done deterministically rather than via LLM —
 * pure templating, more reliable, one less LLM round-trip per stage.
 */

export interface DetailedWorkflow extends WorkflowStub {
  detail: WorkflowDetail;
}

export function formatWorkflowMap(workflows: DetailedWorkflow[]): string {
  const sections = workflows.map((w) => {
    return `## ${w.name}

${w.description}

${w.detail.raw.trim()}`;
  });
  return `# Workflow Map

${sections.join("\n\n---\n\n")}\n`;
}

export function formatScreenInventory(screens: ScreenSpec[]): string {
  const sections = screens.map((s) => {
    const navStr = s.nav.length === 0 ? "_(none)_" : s.nav.join(", ");
    return `## \`${s.id}\`

**Purpose.** ${s.purpose}

**Shows.** ${s.shows}

**Nav.** ${navStr}`;
  });
  return `# Screen Inventory

${sections.join("\n\n")}\n`;
}

/**
 * Used inside operation user messages to render a screen list back to the
 * model in the same format it produces (so navigation validation and
 * correction operate on familiar text).
 */
export function formatScreenList(screens: ScreenSpec[]): string {
  return screens
    .map((s) => {
      const nav = s.nav.length === 0 ? "-" : s.nav.join(", ");
      return `- **${s.id}** — ${s.purpose}\n  Shows: ${s.shows}\n  Nav: ${nav}`;
    })
    .join("\n\n");
}
