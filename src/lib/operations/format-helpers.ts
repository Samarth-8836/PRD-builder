import type {
  DummyData,
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

/**
 * Builds the data.js file the wireframe loads via `<script src="data.js">`.
 * Uses a JSON literal assigned to window.DATA — script-only, no parsing
 * gymnastics, plays nicely with sandboxed iframes (allow-scripts only).
 */
export function formatDataJs(data: DummyData): string {
  // JSON.stringify is safe for browsers (`</script>` doesn't appear in
  // values produced by the model unless they're literal HTML strings —
  // even then we escape the closing tag to be defensive).
  const json = JSON.stringify(data, null, 2).replace(/<\/script/gi, "<\\/script");
  return `// Generated wireframe data — populated from the Project Contract's Entity Map.\nwindow.DATA = ${json};\n`;
}

/**
 * Code-only smoke test for the wireframe artifact:
 *   - Every screen id in the inventory has a corresponding HTML file.
 *   - Every <a href="…html"> in the shell + screens points at a file
 *     that exists in the artifact.
 *   - index.html and data.js are both present.
 *
 * Returns a list of issue descriptions; empty array means OK.
 */
export function runWireframeSmokeTest(
  screens: ScreenSpec[],
  files: Record<string, string>
): string[] {
  const issues: string[] = [];
  const fileNames = new Set(Object.keys(files));

  if (!fileNames.has("index.html")) issues.push("index.html is missing");
  if (!fileNames.has("data.js")) issues.push("data.js is missing");

  for (const screen of screens) {
    const expected = `${screen.id}.html`;
    if (!fileNames.has(expected)) {
      issues.push(`Missing HTML file for screen "${screen.id}" (expected ${expected})`);
    }
  }

  // Find <a href="something.html"> references and check they resolve.
  // Crude regex; good enough for a wireframe sanity check.
  const HREF_RE = /href\s*=\s*["']([^"']+\.html)["']/gi;
  for (const [name, content] of Object.entries(files)) {
    if (!name.endsWith(".html")) continue;
    let m: RegExpExecArray | null;
    while ((m = HREF_RE.exec(content)) !== null) {
      const target = m[1]!.split("#")[0]!.split("?")[0]!;
      if (!fileNames.has(target)) {
        issues.push(`Broken link in ${name}: href="${m[1]}" — ${target} doesn't exist`);
      }
    }
  }

  return issues;
}
