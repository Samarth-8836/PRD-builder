/**
 * Rolling-summary prompts. Both prompts have the same shape: take a prior
 * summary (possibly empty) and a batch of items that have aged out of the
 * verbatim window, fold them into a new compact summary that preserves
 * decisions / requested changes / persistent constraints. Pleasantries
 * and noise are dropped.
 *
 * The compressed output is plain prose — no headers, no bullet lists for
 * atomic facts. The next caller folds in more content using this output as
 * the new `<prior_summary>`.
 */

const COMMON_RULES = `
RULES:
- Output prose only — short, dense paragraphs. No headers, no bullets, no quoted speech.
- Preserve every concrete decision, agreement, requested change, scope boundary, and accepted/rejected idea.
- Drop greetings, acknowledgements ("ok", "thanks"), retries, and content that has been superseded by later decisions.
- Reference items by stable name where possible (workflow names, screen ids, entity names) so future readers can map back.
- Output 1-3 short paragraphs. NEVER output more than ~150 words. The summary travels in every future LLM call.
- If the prior summary is "(none)", begin fresh. Otherwise, treat the prior summary as authoritative for what came earlier and only ADD what the new batch contributes.
- Output the summary text directly. No code fences, no preamble like "Here is the summary:", no trailing commentary.`;

// ---------------------------------------------------------------------------
// 1. Chat window summarization
// ---------------------------------------------------------------------------

export const SUMMARIZE_CHAT_WINDOW_SYSTEM = `You are maintaining a rolling summary of a chat between a user and an AI assistant who is helping the user define a software product (Project Contract -> Workflow Map -> Screens -> Wireframe).

You will be given:
- <prior_summary>...</prior_summary> — the existing summary of older turns (may be "(none)" on the first compression).
- <messages_to_fold>...</messages_to_fold> — chat messages older than the verbatim window. Each line begins with [user] or [assistant]. Fold these into a new summary that supersedes the prior one.
${COMMON_RULES}`;

export const SUMMARIZE_CHAT_WINDOW_CORRECTIVE_HINT = (reason: string) =>
  `Your previous response was rejected. Reason: ${reason}

Output the summary text directly — no code fences, no preamble, no trailing commentary. 1-3 short paragraphs, max ~150 words.`;

// ---------------------------------------------------------------------------
// 2. ChangeLog window summarization
// ---------------------------------------------------------------------------

export const SUMMARIZE_CHANGELOG_WINDOW_SYSTEM = `You are maintaining a rolling summary of a software product's Phase-2 change log. Each entry is a confirmed user-driven change (e.g., "Added a share-with-friend workflow", "Renamed the Settings screen to Preferences"). The summary is read by the design steps so they can preserve user customizations across regenerations.

You will be given:
- <prior_summary>...</prior_summary> — the existing summary of older entries (may be "(none)" on the first compression).
- <entries_to_fold>...</entries_to_fold> — change-log entries older than the verbatim window. Each line is one entry with its description. Fold these into a new summary that supersedes the prior one.
${COMMON_RULES}
ADDITIONAL RULES:
- Lead with what was ADDED to the design (workflows, screens, entities), then any RENAMES, then any REMOVALS.
- It is OK and expected to write "the user added X, then later renamed it to Y" — collapse evolution chains.`;

export const SUMMARIZE_CHANGELOG_WINDOW_CORRECTIVE_HINT = (reason: string) =>
  `Your previous response was rejected. Reason: ${reason}

Output the summary text directly — no code fences, no preamble, no trailing commentary. 1-3 short paragraphs, max ~150 words.`;

// ---------------------------------------------------------------------------
// 3. Per-slot diff summary (M12.3)
// ---------------------------------------------------------------------------

export const SUMMARIZE_DIFF_SUMMARY_SYSTEM = `You are summarizing what changed between two versions of one artifact in a software product design pipeline (Project Contract / Workflow Map / Screen Inventory / Sample Data / Wireframe).

You will be given:
- <slot_label>...</slot_label> — what kind of artifact this is (e.g. "Workflow Map").
- <before>...</before> — the version before the change (may be "(none)" if the artifact didn't exist yet).
- <after>...</after> — the version after the change.

OUTPUT — 1-2 short sentences describing CONCRETE differences, written in plain past tense ("Added X", "Renamed Y to Z", "Removed W", "Replaced A with B"). Reference specific names / ids where possible. Do NOT enumerate unchanged content. Do NOT include preambles like "Here is the summary:". Do NOT use code fences.

If the only change is incidental (whitespace, ordering of identical items), output exactly: "No material change."`;

export const SUMMARIZE_DIFF_SUMMARY_CORRECTIVE_HINT = (reason: string) =>
  `Your previous response was rejected. Reason: ${reason}

Output 1-2 short sentences in plain past tense describing concrete differences. No preamble, no code fences.`;
