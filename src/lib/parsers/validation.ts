import { fail, ok, type ParseResult } from "./types";

export type ValidationStatus = "PASS" | "FAIL";

export interface ValidationResult {
  status: ValidationStatus;
  issues: string[];
  suggestions: string[];
}

const STATUS_RE = /^\s*(?:\*\*\s*)?status\s*(?:\*\*)?\s*:\s*(pass|fail)\s*(?:\n|$)/i;
const ISSUES_HEADER_RE = /(?:^|\n)\s*(?:\*\*\s*)?issues\s*(?:\*\*)?\s*:\s*\n/i;
const SUGGESTIONS_HEADER_RE = /(?:^|\n)\s*(?:\*\*\s*)?suggestions\s*(?:\*\*)?\s*:\s*\n/i;

/**
 * Parses the validator's STATUS: PASS or STATUS: FAIL output. PASS may have
 * no body. FAIL must include "Issues:" and "Suggestions:" bullet lists.
 */
export function parseValidationResult(input: string): ParseResult<ValidationResult> {
  const stripped = stripCodeFences(input).trim();
  if (!stripped) return fail("Validator response was empty");

  const m = stripped.match(STATUS_RE);
  if (!m) {
    return fail(
      'Could not find "STATUS: PASS" or "STATUS: FAIL" header at the start of the response'
    );
  }

  const status = m[1]!.toUpperCase() as ValidationStatus;
  const body = stripped.slice(m[0].length).trim();

  if (status === "PASS") {
    return ok({ status, issues: [], suggestions: [] });
  }

  const issuesMatch = body.match(ISSUES_HEADER_RE);
  if (!issuesMatch || issuesMatch.index === undefined) {
    return fail('FAIL response is missing the "Issues:" section');
  }
  const suggestionsMatch = body.match(SUGGESTIONS_HEADER_RE);
  if (!suggestionsMatch || suggestionsMatch.index === undefined) {
    return fail('FAIL response is missing the "Suggestions:" section');
  }
  if (suggestionsMatch.index <= issuesMatch.index) {
    return fail('"Suggestions:" must appear after "Issues:" in a FAIL response');
  }

  const issuesBlock = body
    .slice(issuesMatch.index + issuesMatch[0].length, suggestionsMatch.index)
    .trim();
  const suggestionsBlock = body
    .slice(suggestionsMatch.index + suggestionsMatch[0].length)
    .trim();

  const issues = parseBullets(issuesBlock);
  const suggestions = parseBullets(suggestionsBlock);

  if (issues.length === 0) return fail('FAIL response had no issue bullets');
  if (suggestions.length === 0) return fail('FAIL response had no suggestion bullets');

  return ok({ status, issues, suggestions });
}

function parseBullets(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*•]\s+/, "").trim())
    .filter((line) => line.length > 0);
}

function stripCodeFences(text: string): string {
  const fenceWrap = text.match(/^\s*```[\w-]*\n([\s\S]*?)\n```\s*$/);
  return fenceWrap ? fenceWrap[1]! : text;
}
