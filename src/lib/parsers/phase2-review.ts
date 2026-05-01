import { fail, ok, type ParseResult } from "./types";

// ---------------------------------------------------------------------------
// Phase 2 conversation (M5, refactored M10 — first-impact terminology)
// ---------------------------------------------------------------------------

export interface Phase2Question {
  mode: "question";
  answer: string;
}

export interface Phase2Change {
  mode: "change";
  summary: string;
  /** Step id the change first applies to — the model picks one of the
   *  registered step ids in the active pipeline. The engine invalidates
   *  this step + all transitive descendants and re-runs them in topo
   *  order. */
  firstImpactStepId: string;
  description: string;
  /** Optional sub-target inside a fanout step (e.g. one screen id within
   *  the wireframeHtml step's per-screen fanout). Lets the engine
   *  regenerate just that one fanout item. */
  firstImpactItemId?: string;
}

export type Phase2Conversation = Phase2Question | Phase2Change;

const MODE_RE = /^\s*(?:\*\*\s*)?mode\s*(?:\*\*)?\s*:\s*(question|change)\s*\n/i;
const SUMMARY_RE = /^\s*(?:\*\*\s*)?summary\s*(?:\*\*)?\s*:\s*\n/i;
const CHANGE_CONTEXT_OPEN_RE = /\n\s*<change_context>\s*\n?/i;
const CHANGE_CONTEXT_CLOSE_RE = /\n?\s*<\/change_context>\s*$/i;
const FIRST_IMPACT_STEP_RE =
  /(?:^|\n)\s*first_impact_step\s*:\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*$/im;
const FIRST_IMPACT_ITEM_RE =
  /(?:^|\n)\s*first_impact_item\s*:\s*([a-z][a-z0-9-]*)\s*$/im;
const DESCRIPTION_RE = /(?:^|\n)\s*description\s*:\s*(.+?)\s*$/im;

export interface ParsePhase2Options {
  /** Validates first_impact_step against this allow-list of step ids
   *  registered in the active pipeline. When omitted, any non-empty
   *  identifier is accepted. */
  knownStepIds?: readonly string[];
}

export function parsePhase2Conversation(
  input: string,
  options: ParsePhase2Options = {}
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

  const stepMatch = ccBody.match(FIRST_IMPACT_STEP_RE);
  if (!stepMatch) {
    const allow =
      options.knownStepIds && options.knownStepIds.length > 0
        ? `<one of: ${options.knownStepIds.join(", ")}>`
        : "<step-id>";
    return fail(`<change_context> is missing "first_impact_step: ${allow}"`);
  }
  const firstImpactStepId = stepMatch[1]!;
  if (
    options.knownStepIds &&
    options.knownStepIds.length > 0 &&
    !options.knownStepIds.includes(firstImpactStepId)
  ) {
    return fail(
      `Unknown first_impact_step "${firstImpactStepId}"; must be one of ${options.knownStepIds.join(", ")}`
    );
  }

  const descMatch = ccBody.match(DESCRIPTION_RE);
  if (!descMatch) return fail('<change_context> is missing a "description:" line');
  const description = descMatch[1]!.trim();
  if (!description) return fail('<change_context> "description:" was empty');

  const itemMatch = ccBody.match(FIRST_IMPACT_ITEM_RE);
  const firstImpactItemId = itemMatch?.[1]?.toLowerCase();

  return ok({
    mode: "change",
    summary,
    firstImpactStepId,
    description,
    firstImpactItemId,
  });
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
