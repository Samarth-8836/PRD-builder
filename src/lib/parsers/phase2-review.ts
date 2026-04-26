import { fail, ok, type ParseResult } from "./types";

// ---------------------------------------------------------------------------
// Phase 2 conversation (M5)
// ---------------------------------------------------------------------------

export type ChangeScope = "workflow_change" | "screen_only" | "data_only";

export interface Phase2Question {
  mode: "question";
  answer: string;
}

export interface Phase2Change {
  mode: "change";
  summary: string;
  scope: ChangeScope;
  description: string;
  /** Optional screen id (lowercase kebab-case) the change targets — used
   *  by the wireframe-stage cascade to regenerate just one screen's HTML
   *  for `scope: screen_only`. */
  target?: string;
}

export type Phase2Conversation = Phase2Question | Phase2Change;

const MODE_RE = /^\s*(?:\*\*\s*)?mode\s*(?:\*\*)?\s*:\s*(question|change)\s*\n/i;
const SUMMARY_RE = /^\s*(?:\*\*\s*)?summary\s*(?:\*\*)?\s*:\s*\n/i;
const CHANGE_CONTEXT_OPEN_RE = /\n\s*<change_context>\s*\n?/i;
const CHANGE_CONTEXT_CLOSE_RE = /\n?\s*<\/change_context>\s*$/i;
const SCOPE_RE = /(?:^|\n)\s*scope\s*:\s*(workflow_change|screen_only|data_only)\s*$/im;
const TARGET_RE = /(?:^|\n)\s*target\s*:\s*([a-z][a-z0-9-]*)\s*$/im;
const DESCRIPTION_RE = /(?:^|\n)\s*description\s*:\s*(.+?)\s*$/im;
const VALID_SCOPES: ChangeScope[] = ["workflow_change", "screen_only", "data_only"];

export function parsePhase2Conversation(
  input: string
): ParseResult<Phase2Conversation> {
  const stripped = stripCodeFences(input).trim();
  if (!stripped) return fail("Model response was empty");

  const modeMatch = stripped.match(MODE_RE);
  if (!modeMatch) {
    return fail('Could not find "MODE: question" or "MODE: change" header at the start');
  }
  const mode = modeMatch[1]!.toLowerCase();
  const body = stripped.slice(modeMatch[0].length).trim();

  if (mode === "question") {
    if (!body) return fail("QUESTION mode body was empty");
    if (/<change_context>/i.test(body)) {
      return fail(
        "QUESTION mode response contained a <change_context> block. If you meant a change, use MODE: change."
      );
    }
    return ok({ mode: "question", answer: body });
  }

  // mode === "change"
  const sumMatch = body.match(SUMMARY_RE);
  if (!sumMatch) {
    return fail('CHANGE mode requires a "SUMMARY:" header before the <change_context> block');
  }
  const afterSummary = body.slice(sumMatch[0].length);

  const ccMatch = afterSummary.match(CHANGE_CONTEXT_OPEN_RE);
  if (!ccMatch || ccMatch.index === undefined) {
    return fail(
      'CHANGE mode requires a <change_context>...</change_context> block after the SUMMARY'
    );
  }

  const summary = afterSummary.slice(0, ccMatch.index).trim();
  if (!summary) return fail("SUMMARY was empty");

  const ccTail = afterSummary.slice(ccMatch.index + ccMatch[0].length);
  const closeMatch = ccTail.match(CHANGE_CONTEXT_CLOSE_RE);
  const ccBody = (closeMatch ? ccTail.slice(0, closeMatch.index) : ccTail).trim();

  const scopeMatch = ccBody.match(SCOPE_RE);
  if (!scopeMatch) {
    return fail(
      `<change_context> is missing "scope: <one of ${VALID_SCOPES.join("|")}>"`
    );
  }
  const scope = scopeMatch[1]!.toLowerCase() as ChangeScope;
  if (!VALID_SCOPES.includes(scope)) {
    return fail(
      `Invalid scope "${scope}"; must be one of ${VALID_SCOPES.join(", ")}`
    );
  }

  const descMatch = ccBody.match(DESCRIPTION_RE);
  if (!descMatch) return fail('<change_context> is missing a "description:" line');
  const description = descMatch[1]!.trim();
  if (!description) return fail('<change_context> "description:" was empty');

  const targetMatch = ccBody.match(TARGET_RE);
  const target = targetMatch?.[1]?.toLowerCase();

  return ok({ mode: "change", summary, scope, description, target });
}

// ---------------------------------------------------------------------------
// Drift check (M5)
// ---------------------------------------------------------------------------

export type DriftClassification = "COMPATIBLE" | "FLAG" | "DRIFT";

export type DriftType =
  | "SCOPE_EXPANSION"
  | "NEW_PERSONA"
  | "NEW_ENTITY"
  | "BOUNDARY_VIOLATION"
  | "GOAL_EXPANSION";

export interface DriftResult {
  classification: DriftClassification;
  type?: DriftType;
  reason: string;
}

const DRIFT_CLASSIFICATION_RE =
  /^\s*(?:\*\*\s*)?classification\s*(?:\*\*)?\s*:\s*(compatible|flag|drift)\s*\n/i;
const DRIFT_TYPE_RE =
  /(?:^|\n)\s*(?:\*\*\s*)?type\s*(?:\*\*)?\s*:\s*(scope_expansion|new_persona|new_entity|boundary_violation|goal_expansion)\s*(?:\n|$)/i;
const DRIFT_REASON_RE = /(?:^|\n)\s*(?:\*\*\s*)?reason\s*(?:\*\*)?\s*:\s*(.+?)\s*$/is;

export function parseDriftCheck(input: string): ParseResult<DriftResult> {
  const stripped = stripCodeFences(input).trim();
  if (!stripped) return fail("Drift check response was empty");

  const cm = stripped.match(DRIFT_CLASSIFICATION_RE);
  if (!cm) {
    return fail(
      'Could not find "CLASSIFICATION: COMPATIBLE | FLAG | DRIFT" header at the start'
    );
  }
  const classification = cm[1]!.toUpperCase() as DriftClassification;

  const reasonMatch = stripped.match(DRIFT_REASON_RE);
  if (!reasonMatch) return fail('Drift response is missing a "REASON:" line');
  const reason = reasonMatch[1]!.trim().split(/\r?\n/)[0]!.trim();
  if (!reason) return fail("REASON was empty");

  if (classification === "COMPATIBLE") {
    return ok({ classification, reason });
  }

  const typeMatch = stripped.match(DRIFT_TYPE_RE);
  if (!typeMatch) {
    return fail(
      `${classification} response is missing a "TYPE:" line (one of SCOPE_EXPANSION, NEW_PERSONA, NEW_ENTITY, BOUNDARY_VIOLATION, GOAL_EXPANSION)`
    );
  }
  const type = typeMatch[1]!.toUpperCase() as DriftType;
  return ok({ classification, type, reason });
}

function stripCodeFences(text: string): string {
  const fenceWrap = text.match(/^\s*```[\w-]*\n([\s\S]*?)\n```\s*$/);
  return fenceWrap ? fenceWrap[1]! : text;
}
