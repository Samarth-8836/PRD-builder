import { fail, ok, type ParseResult } from "./types";

export const REQUIRED_SECTIONS = [
  "## Goal Statement",
  "## Personas",
  "## Entity Map",
  "## Boundaries",
] as const;

export interface ParsedContract {
  raw: string;
  goalStatement: string;
  personas: string;
  entityMap: string;
  boundaries: string;
}

/**
 * Validates that a contract markdown string has the four required H2
 * sections in order, and extracts each section body. Tolerant of leading
 * whitespace and trailing whitespace per section. Strict on order.
 */
export function parseContract(input: string): ParseResult<ParsedContract> {
  const text = input.trim();
  if (!text) return fail("Contract was empty");

  const positions: number[] = [];
  for (const heading of REQUIRED_SECTIONS) {
    const start = positions.length === 0 ? 0 : positions[positions.length - 1]!;
    const idx = indexOfHeading(text, heading, start);
    if (idx === -1) {
      return fail(`Missing required section: "${heading}"`);
    }
    if (positions.length > 0 && idx <= positions[positions.length - 1]!) {
      return fail(
        `Section "${heading}" appeared out of order. Expected order: ${REQUIRED_SECTIONS.join(
          " -> "
        )}`
      );
    }
    positions.push(idx);
  }

  const sections: string[] = [];
  for (let i = 0; i < REQUIRED_SECTIONS.length; i++) {
    const startHeading = positions[i]!;
    const endHeading =
      i + 1 < REQUIRED_SECTIONS.length ? positions[i + 1]! : text.length;
    const heading = REQUIRED_SECTIONS[i]!;
    const body = text.slice(startHeading + heading.length, endHeading).trim();
    if (!body) return fail(`Section "${heading}" had no body`);
    sections.push(body);
  }

  return ok({
    raw: text,
    goalStatement: sections[0]!,
    personas: sections[1]!,
    entityMap: sections[2]!,
    boundaries: sections[3]!,
  });
}

function indexOfHeading(text: string, heading: string, fromIndex: number): number {
  // Heading must start a line (preceded by start-of-string or newline).
  const re = new RegExp(`(^|\\n)\\s*${escapeRegex(heading)}\\s*(\\n|$)`, "g");
  re.lastIndex = fromIndex;
  const match = re.exec(text);
  if (!match) return -1;
  // index of the heading itself, not the leading newline
  return match.index + (match[1] === "\n" ? 1 : 0);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
