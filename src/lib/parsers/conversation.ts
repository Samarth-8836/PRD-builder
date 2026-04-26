import { parseContract, type ParsedContract, REQUIRED_SECTIONS } from "./contract";
import { fail, ok, type ParseResult } from "./types";

export type ConversationMode = "question" | "edit";

export interface ParsedQuestion {
  mode: "question";
  answer: string;
}

export interface ParsedEdit {
  mode: "edit";
  summary: string;
  contract: ParsedContract;
}

export type ParsedConversation = ParsedQuestion | ParsedEdit;

const MODE_RE = /^\s*(?:\*\*\s*)?mode\s*(?:\*\*)?\s*:\s*(question|edit|first_message)\s*\n/i;
const SUMMARY_RE = /^\s*(?:\*\*\s*)?summary\s*(?:\*\*)?\s*:\s*\n/i;
const CONTRACT_RE = /\n\s*(?:\*\*\s*)?contract\s*(?:\*\*)?\s*:\s*\n/i;

/**
 * Parses a Phase 1 conversation response. Strict on the leading
 * `MODE: question|edit` classifier; dispatches the rest to the appropriate
 * sub-parser.
 *
 * Failures here trigger a corrective-hint retry in the executor — invest
 * in clear error messages so the retry has the best shot at succeeding.
 */
export function parseConversationResponse(
  input: string
): ParseResult<ParsedConversation> {
  const stripped = stripCodeFences(input).trim();
  if (!stripped) return fail("Model response was empty");

  const modeMatch = stripped.match(MODE_RE);
  if (!modeMatch) {
    return fail(
      'Could not find "MODE: question" or "MODE: edit" header at the start of the response'
    );
  }

  const mode = modeMatch[1]!.toLowerCase();
  const body = stripped.slice(modeMatch[0].length).trim();

  if (mode === "question") {
    return parseQuestionBody(body);
  }
  if (mode === "edit" || mode === "first_message") {
    return parseEditBody(body);
  }

  return fail(`Unknown MODE value "${mode}". Expected "question" or "edit".`);
}

function parseQuestionBody(body: string): ParseResult<ParsedQuestion> {
  if (!body) return fail("QUESTION mode body was empty");

  // Sanity check: a question must not be a hidden contract. If we see the
  // contract section headers in the body, the model probably mislabelled an
  // edit. Reject so the corrective-hint retry can fix it.
  for (const heading of REQUIRED_SECTIONS) {
    if (containsHeading(body, heading)) {
      return fail(
        `QUESTION mode body contained the section header "${heading}". A question must be plain prose. If you meant to edit the contract, use MODE: edit.`
      );
    }
  }

  return ok({ mode: "question", answer: body });
}

function parseEditBody(body: string): ParseResult<ParsedEdit> {
  if (!body) return fail("EDIT mode body was empty");

  const sumMatch = body.match(SUMMARY_RE);
  if (!sumMatch) {
    return fail('EDIT mode requires a "SUMMARY:" header before the CONTRACT block');
  }
  const afterSummary = body.slice(sumMatch[0].length);

  const conMatch = afterSummary.match(CONTRACT_RE);
  if (!conMatch || conMatch.index === undefined) {
    return fail('EDIT mode requires a "CONTRACT:" header after the SUMMARY block');
  }

  const summary = afterSummary.slice(0, conMatch.index).trim();
  if (!summary) return fail("EDIT mode SUMMARY was empty");

  const contractRaw = afterSummary.slice(conMatch.index + conMatch[0].length).trim();
  if (!contractRaw) return fail("EDIT mode CONTRACT was empty");

  const contract = parseContract(contractRaw);
  if (!contract.ok) return fail(`Contract validation failed: ${contract.error}`);

  return ok({ mode: "edit", summary, contract: contract.value });
}

function stripCodeFences(text: string): string {
  const fenceWrap = text.match(/^\s*```[\w-]*\n([\s\S]*?)\n```\s*$/);
  return fenceWrap ? fenceWrap[1]! : text;
}

function containsHeading(text: string, heading: string): boolean {
  const re = new RegExp(`(^|\\n)\\s*${escapeRegex(heading)}\\s*(\\n|$)`);
  return re.test(text);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
