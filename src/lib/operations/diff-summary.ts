/**
 * Per-slot diff summary generator (M12.3).
 *
 * Runs after a slot is regenerated during a confirmed cascade. Produces
 * a 1-2 sentence summary of what changed between the before and after
 * payload, then persists it onto the most recent ChangeLogEntry via
 * `IStorage.appendDiffSummary`. Designed to be called fire-and-forget
 * from cascade impact handlers and stage runners.
 *
 * Soft-fails on any LLM / storage error: a missing diff summary is
 * acceptable (the HistoryPanel renders "(summary pending)"). The fallback
 * never blocks user-visible flows.
 */

import { execute } from "@/lib/operations/executor";
import { ok, type ParseResult } from "@/lib/parsers/types";
import { getPrompt } from "@/lib/prompts";
import { getStorage } from "@/lib/storage";
import type { DiffSummary, SlotPayload } from "@/lib/pipeline/types";

const SUMMARIZER_MAX_ATTEMPTS = 2;
/** Hard cap on how much before/after content we feed the summarizer.
 *  Most slots are well under this; a fanout fileset can blow past it,
 *  so we truncate with an ellipsis to keep token cost bounded. */
const MAX_PAYLOAD_CHARS = 6000;

function parseDiffSummary(text: string): ParseResult<string> {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "Empty summary output" };
  const stripped = trimmed
    .replace(/^```[a-zA-Z]*\n?/, "")
    .replace(/\n?```$/, "")
    .trim();
  return ok(stripped);
}

function payloadToText(payload: SlotPayload | undefined): string {
  if (!payload) return "(none)";
  switch (payload.kind) {
    case "markdown":
      return truncate(payload.content);
    case "json":
      return truncate(JSON.stringify(payload.data, null, 2));
    case "fileset": {
      const fileNames = Object.keys(payload.files).sort();
      const head = `Files (${fileNames.length}): ${fileNames.join(", ")}`;
      const sample = fileNames
        .slice(0, 3)
        .map(
          (n) =>
            `\n--- ${n} ---\n${truncate(payload.files[n] ?? "", MAX_PAYLOAD_CHARS / 4)}`
        )
        .join("\n");
      return truncate(`${head}\n${sample}`);
    }
  }
}

function truncate(s: string, max = MAX_PAYLOAD_CHARS): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n[...truncated ${s.length - max} chars]`;
}

interface RunInput {
  sessionId: string;
  slotId: string;
  slotLabel: string;
  before: SlotPayload | undefined;
  after: SlotPayload;
}

/** Run the LLM call, persist the resulting summary onto the session's
 *  most-recent ChangeLogEntry. Soft-fails. */
export async function runDiffSummary(input: RunInput): Promise<void> {
  // If before === after by content (e.g., setSlot called with no actual
  // change), skip. Cheap structural check.
  if (input.before && payloadEqual(input.before, input.after)) return;

  const prompt = getPrompt("summarize.diff_summary");
  const userMsg = `<slot_label>${input.slotLabel}</slot_label>

<before>
${payloadToText(input.before)}
</before>

<after>
${payloadToText(input.after)}
</after>`;

  let summaryText: string;
  try {
    const { value } = await execute<string>({
      system: prompt.system,
      messages: [{ role: "user", content: userMsg }],
      correctiveHint: prompt.correctiveHint,
      parser: parseDiffSummary,
      maxAttempts: SUMMARIZER_MAX_ATTEMPTS,
      role: "fast",
    });
    summaryText = value;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `diff-summary failed for session=${input.sessionId} slot=${input.slotId}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return;
  }

  const summary: DiffSummary = {
    slotId: input.slotId,
    slotLabel: input.slotLabel,
    summary: summaryText,
    ts: new Date().toISOString(),
  };
  try {
    await getStorage().appendDiffSummary(input.sessionId, summary);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `appendDiffSummary failed for session=${input.sessionId} slot=${input.slotId}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

/** Fire-and-forget wrapper: runs the diff summary on a microtask, never
 *  rejects the caller. */
export function fireDiffSummary(input: RunInput): void {
  // Decouple from the caller's call stack and SSE lifecycle.
  setImmediate(() => {
    void runDiffSummary(input);
  });
}

function payloadEqual(a: SlotPayload, b: SlotPayload): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "markdown" && b.kind === "markdown") {
    return a.content === b.content;
  }
  if (a.kind === "json" && b.kind === "json") {
    return JSON.stringify(a.data) === JSON.stringify(b.data);
  }
  if (a.kind === "fileset" && b.kind === "fileset") {
    const aKeys = Object.keys(a.files).sort();
    const bKeys = Object.keys(b.files).sort();
    if (aKeys.length !== bKeys.length) return false;
    for (let i = 0; i < aKeys.length; i++) {
      if (aKeys[i] !== bKeys[i]) return false;
      if (a.files[aKeys[i]!] !== b.files[bKeys[i]!]) return false;
    }
    return true;
  }
  return false;
}
