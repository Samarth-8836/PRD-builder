import { fail, ok, type ParseResult } from "./types";

// ---------------------------------------------------------------------------
// Workflow stubs (output of phase2.workflow_discovery)
// ---------------------------------------------------------------------------

export interface WorkflowStub {
  name: string;
  description: string;
}

const STUB_LINE_RE = /^\s*-\s*\*\*\s*([^*]+?)\s*\*\*\s*[—\-]\s*(.+?)\s*$/;

export function parseWorkflowStubs(input: string): ParseResult<WorkflowStub[]> {
  const text = stripCodeFences(input).trim();
  if (!text) return fail("Workflow discovery response was empty");

  const stubs: WorkflowStub[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(STUB_LINE_RE);
    if (!m) continue;
    const name = m[1]!.trim();
    const description = m[2]!.trim();
    if (name && description) stubs.push({ name, description });
  }

  if (stubs.length < 3) {
    return fail(
      `Expected at least 3 workflow bullets in the form "- **Name** — description"; found ${stubs.length}`
    );
  }
  if (stubs.length > 20) {
    return fail(`Too many workflows (${stubs.length}); cap is 20`);
  }
  return ok(stubs);
}

// ---------------------------------------------------------------------------
// Workflow detail (output of phase2.workflow_detail, one per workflow)
// ---------------------------------------------------------------------------

export interface WorkflowDetail {
  preConditions: string;
  steps: string;
  exitCriteria: string;
  edgeCases: string;
  raw: string;
}

const DETAIL_SECTIONS = [
  "Pre-conditions",
  "Steps",
  "Exit criteria",
  "Edge cases",
] as const;

export function parseWorkflowDetail(input: string): ParseResult<WorkflowDetail> {
  const text = stripCodeFences(input).trim();
  if (!text) return fail("Workflow detail response was empty");

  const positions: number[] = [];
  for (const heading of DETAIL_SECTIONS) {
    const start = positions.length === 0 ? 0 : positions[positions.length - 1]!;
    const idx = indexOfBoldHeading(text, heading, start);
    if (idx === -1) return fail(`Missing section: "**${heading}**"`);
    if (positions.length > 0 && idx <= positions[positions.length - 1]!) {
      return fail(`Section "${heading}" appeared out of order`);
    }
    positions.push(idx);
  }

  const bodies: string[] = [];
  for (let i = 0; i < DETAIL_SECTIONS.length; i++) {
    const start = positions[i]!;
    const end = i + 1 < DETAIL_SECTIONS.length ? positions[i + 1]! : text.length;
    const heading = DETAIL_SECTIONS[i]!;
    // Skip past the **Heading** marker on the first line.
    const firstNl = text.indexOf("\n", start);
    const bodyStart = firstNl === -1 ? end : firstNl + 1;
    const body = text.slice(bodyStart, end).trim();
    if (!body) return fail(`Section "${heading}" had no body`);
    bodies.push(body);
  }

  return ok({
    preConditions: bodies[0]!,
    steps: bodies[1]!,
    exitCriteria: bodies[2]!,
    edgeCases: bodies[3]!,
    raw: text,
  });
}

// ---------------------------------------------------------------------------
// Screens (output of phase2.screen_extract / screen_correct)
// ---------------------------------------------------------------------------

export interface ScreenSpec {
  id: string;
  purpose: string;
  shows: string;
  nav: string[];
}

const SCREEN_HEAD_RE = /^\s*-\s*\*\*\s*([a-z0-9-]+)\s*\*\*\s*[—\-]\s*(.+?)\s*$/i;
const SHOWS_RE = /^\s*shows\s*:\s*(.+?)\s*$/i;
const NAV_RE = /^\s*nav\s*:\s*(.+?)\s*$/i;
const ID_RE = /^[a-z][a-z0-9-]*$/;

export function parseScreens(input: string): ParseResult<ScreenSpec[]> {
  const text = stripCodeFences(input).trim();
  if (!text) return fail("Screen list response was empty");

  const lines = text.split(/\r?\n/);
  const screens: ScreenSpec[] = [];
  let current: ScreenSpec | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const head = line.match(SCREEN_HEAD_RE);
    if (head) {
      if (current) screens.push(current);
      const id = head[1]!.toLowerCase();
      if (!ID_RE.test(id)) {
        return fail(`Invalid screen id "${id}" (must be lowercase kebab-case)`);
      }
      current = { id, purpose: head[2]!.trim(), shows: "", nav: [] };
      continue;
    }
    if (!current) continue; // ignore stray lines before first screen
    const shows = line.match(SHOWS_RE);
    if (shows) {
      current.shows = shows[1]!.trim();
      continue;
    }
    const nav = line.match(NAV_RE);
    if (nav) {
      current.nav = parseNavList(nav[1]!);
      continue;
    }
  }
  if (current) screens.push(current);

  if (screens.length < 2) {
    return fail(
      `Expected at least 2 screens in the form "- **screen-id** — purpose"; found ${screens.length}`
    );
  }

  // Each screen must have a `Shows:` line. Nav target existence is NOT
  // validated here — that's nav_validate's job in the screen stage. The
  // screen-stage finalizer (`finalizeScreenList`) drops any dangling nav
  // references after screen_correct has run. Validating at parse time
  // would gate the screen stage out of its own correction loop.
  for (const s of screens) {
    if (!s.shows) return fail(`Screen "${s.id}" missing the "Shows:" line`);
  }

  return ok(screens);
}

/**
 * Code-only finalizer for a screen list. Drops nav entries that point at
 * undefined screen ids. Called after screen_extract (and optionally
 * screen_correct) so the saved Screen Inventory is internally consistent
 * regardless of what the model emitted.
 */
export function finalizeScreenList(screens: ScreenSpec[]): {
  screens: ScreenSpec[];
  droppedNav: { from: string; to: string }[];
} {
  const idSet = new Set(screens.map((s) => s.id));
  const droppedNav: { from: string; to: string }[] = [];
  const cleaned = screens.map((s) => {
    const keep: string[] = [];
    for (const target of s.nav) {
      if (idSet.has(target)) {
        keep.push(target);
      } else {
        droppedNav.push({ from: s.id, to: target });
      }
    }
    return keep.length === s.nav.length ? s : { ...s, nav: keep };
  });
  return { screens: cleaned, droppedNav };
}

function parseNavList(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "-" || trimmed.toLowerCase() === "none") return [];
  return trimmed
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Recovers ScreenSpec[] from the rendered Screen Inventory markdown
 * produced by formatScreenInventory (for handing off into the wireframe
 * stage where the original ScreenSpec[] is no longer in memory).
 *
 * The rendered format is:
 *
 *   # Screen Inventory
 *
 *   ## `home`
 *
 *   **Purpose.** ...
 *
 *   **Shows.** ...
 *
 *   **Nav.** comma, list — or "_(none)_"
 */
const RENDERED_HEADING_RE = /^##\s+`([a-z][a-z0-9-]*)`\s*$/m;
const RENDERED_PURPOSE_RE = /\*\*Purpose\.\*\*\s+(.+?)\s*$/m;
const RENDERED_SHOWS_RE = /\*\*Shows\.\*\*\s+(.+?)\s*$/m;
const RENDERED_NAV_RE = /\*\*Nav\.\*\*\s+(.+?)\s*$/m;

export function parseScreenInventoryDoc(input: string): ParseResult<ScreenSpec[]> {
  if (!input.trim()) return fail("Screen inventory was empty");

  const blocks: string[] = [];
  let remaining = input;
  while (true) {
    const headingIdx = remaining.search(RENDERED_HEADING_RE);
    if (headingIdx === -1) break;
    remaining = remaining.slice(headingIdx);
    const nextIdx = remaining.slice(1).search(/^##\s+`/m);
    if (nextIdx === -1) {
      blocks.push(remaining);
      break;
    }
    blocks.push(remaining.slice(0, nextIdx + 1));
    remaining = remaining.slice(nextIdx + 1);
  }

  const screens: ScreenSpec[] = [];
  for (const block of blocks) {
    const head = block.match(RENDERED_HEADING_RE);
    if (!head) continue;
    const id = head[1]!;
    const purpose = block.match(RENDERED_PURPOSE_RE)?.[1]?.trim() ?? "";
    const shows = block.match(RENDERED_SHOWS_RE)?.[1]?.trim() ?? "";
    const navRaw = block.match(RENDERED_NAV_RE)?.[1]?.trim() ?? "";
    const nav =
      navRaw === "_(none)_" || navRaw === "" || navRaw === "-"
        ? []
        : navRaw
            .split(",")
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
    if (!purpose || !shows) {
      return fail(`Screen "${id}" missing purpose or shows in rendered inventory`);
    }
    screens.push({ id, purpose, shows, nav });
  }

  if (screens.length < 2) {
    return fail(`Expected at least 2 screens in rendered inventory; found ${screens.length}`);
  }

  // Nav-target existence is not validated at read-back time. The
  // screen-stage finalizer drops dangling nav before saving, so a
  // well-formed inventory should not contain any. If somehow one slips
  // through, the wireframe smoke test will surface broken hrefs.
  return ok(screens);
}

// ---------------------------------------------------------------------------
// Nav validation (output of phase2.nav_validate)
// ---------------------------------------------------------------------------

export type NavValidationResult =
  | { status: "ok" }
  | { status: "gaps"; gaps: string[] };

export function parseNavValidation(
  input: string
): ParseResult<NavValidationResult> {
  const text = stripCodeFences(input).trim();
  if (!text) return fail("Nav validation response was empty");

  if (/^\s*no\s+gaps\s*$/i.test(text.split(/\r?\n/)[0]!.trim())) {
    return ok({ status: "ok" });
  }

  const gapsHeader = text.match(/^\s*gaps\s*:\s*$/im);
  if (!gapsHeader) {
    return fail('Expected "NO GAPS" or "GAPS:" header');
  }
  const headerEnd = (gapsHeader.index ?? 0) + gapsHeader[0].length;
  const body = text.slice(headerEnd).trim();
  const gaps = body
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*•]\s+/, "").trim())
    .filter(Boolean);
  if (gaps.length === 0) {
    return fail('GAPS section had no bullets — use "NO GAPS" instead if there are none');
  }
  return ok({ status: "gaps", gaps });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function indexOfBoldHeading(text: string, heading: string, fromIndex: number): number {
  const re = new RegExp(
    `(^|\\n)\\s*\\*\\*\\s*${escapeRegex(heading)}\\s*\\*\\*\\s*(\\n|$)`,
    "g"
  );
  re.lastIndex = fromIndex;
  const match = re.exec(text);
  if (!match) return -1;
  return match.index + (match[1] === "\n" ? 1 : 0);
}

function stripCodeFences(text: string): string {
  const fenceWrap = text.match(/^\s*```[\w-]*\n([\s\S]*?)\n```\s*$/);
  return fenceWrap ? fenceWrap[1]! : text;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
