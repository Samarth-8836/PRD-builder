import { parseContract, type ParsedContract } from "./contract";
import { fail, ok, type ParseResult } from "./types";

export interface ParsedFirstMessage {
  summary: string;
  contract: ParsedContract;
}

const SUMMARY_RE = /^\s*(?:\*\*\s*)?summary\s*(?:\*\*)?\s*:\s*\n/i;
const CONTRACT_RE = /\n\s*(?:\*\*\s*)?contract\s*(?:\*\*)?\s*:\s*\n/i;

/**
 * Parses the strict SUMMARY/CONTRACT format from the phase1.first_message
 * prompt. Tolerant of bold-wrapped headers (`**SUMMARY:**`) and stray
 * leading whitespace, strict on the section order and the presence of both
 * blocks.
 */
export function parseFirstMessage(input: string): ParseResult<ParsedFirstMessage> {
  const stripped = stripCodeFences(input).trim();
  if (!stripped) return fail("Model response was empty");

  const sumMatch = stripped.match(SUMMARY_RE);
  if (!sumMatch) {
    return fail(
      'Could not find "SUMMARY:" header at the start of the response'
    );
  }
  const afterSummaryHeader = stripped.slice(sumMatch[0].length);

  const conMatch = afterSummaryHeader.match(CONTRACT_RE);
  if (!conMatch || conMatch.index === undefined) {
    return fail('Could not find "CONTRACT:" header after the SUMMARY block');
  }

  const summary = afterSummaryHeader.slice(0, conMatch.index).trim();
  if (!summary) return fail("SUMMARY section was empty");

  const contractRaw = afterSummaryHeader
    .slice(conMatch.index + conMatch[0].length)
    .trim();
  if (!contractRaw) return fail("CONTRACT section was empty");

  const contract = parseContract(contractRaw);
  if (!contract.ok) return fail(`Contract validation failed: ${contract.error}`);

  return ok({ summary, contract: contract.value });
}

function stripCodeFences(text: string): string {
  const fenceWrap = text.match(/^\s*```[\w-]*\n([\s\S]*?)\n```\s*$/);
  return fenceWrap ? fenceWrap[1]! : text;
}
