/**
 * Sliding-window summarization for chat history and the Phase-2 change log.
 *
 * Goal: keep at most VERBATIM_KEEP recent items + one rolling summary of
 * everything older. The verbatim window stays useful for the LLM (full
 * fidelity); the rolling summary preserves the rest of the session's
 * context across long horizons without unbounded prompt growth.
 *
 * Compression triggers when the verbatim portion grows past
 * COMPRESS_THRESHOLD. We then take the OLDEST `length - VERBATIM_KEEP`
 * items, fold them into the existing rolling summary via a small LLM
 * call, and persist the trimmed list + new summary. Subsequent compressions
 * extend the same summary.
 *
 * Soft-fail on summarization error: if the LLM call fails, return the
 * uncompressed session unchanged. The session keeps growing, but no LLM
 * path that consumes it is broken — they'll just see a larger window.
 * The next compression attempt may succeed.
 */

import { execute } from "@/lib/operations/executor";
import { ok, type ParseResult } from "@/lib/parsers/types";
import { getPrompt } from "@/lib/prompts";
import { getStorage, type ChatMessage, type Session } from "@/lib/storage";
import type { ChangeLogEntry } from "@/lib/pipeline/types";

const VERBATIM_KEEP = 100;
const COMPRESS_THRESHOLD = 110;

const SUMMARIZER_MAX_ATTEMPTS = 2;

/** Trivial parser: any non-empty trimmed text is a valid summary. */
function parseSummary(text: string): ParseResult<string> {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, error: "Empty summary output" };
  }
  // Light cleanup: drop wrapping code fences if the model added them.
  const stripped = trimmed
    .replace(/^```[a-zA-Z]*\n?/, "")
    .replace(/\n?```$/, "")
    .trim();
  return ok(stripped);
}

// ---------------------------------------------------------------------------
// Chat window
// ---------------------------------------------------------------------------

/** Ensure `session.chat.length <= VERBATIM_KEEP` (or the full session if
 *  summarization fails). Returns the up-to-date session. */
export async function ensureChatCompressed(
  sessionId: string
): Promise<Session> {
  const storage = getStorage();
  const session = await storage.getSession(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  if (session.chat.length <= COMPRESS_THRESHOLD) return session;

  const foldCount = session.chat.length - VERBATIM_KEEP;
  const toFold = session.chat.slice(0, foldCount);
  const remaining = session.chat.slice(foldCount);

  let newSummary: string;
  try {
    newSummary = await summarizeChatWindow(
      session.chatSummary,
      toFold
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `chat-window summarization failed for session ${sessionId}: ${
        err instanceof Error ? err.message : String(err)
      }. Proceeding with uncompressed history.`
    );
    return session;
  }
  return storage.setChatWindow(sessionId, newSummary, remaining);
}

async function summarizeChatWindow(
  priorSummary: string | undefined,
  messagesToFold: readonly ChatMessage[]
): Promise<string> {
  const prompt = getPrompt("summarize.chat_window");
  const lines = messagesToFold
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => `[${m.role}] ${m.content.trim()}`)
    .join("\n\n");
  const userMsg = `<prior_summary>
${priorSummary && priorSummary.trim().length > 0 ? priorSummary.trim() : "(none)"}
</prior_summary>

<messages_to_fold>
${lines}
</messages_to_fold>`;

  const { value } = await execute<string>({
    system: prompt.system,
    messages: [{ role: "user", content: userMsg }],
    correctiveHint: prompt.correctiveHint,
    parser: parseSummary,
    maxAttempts: SUMMARIZER_MAX_ATTEMPTS,
    role: "fast",
  });
  return value;
}

// ---------------------------------------------------------------------------
// ChangeLog window
// ---------------------------------------------------------------------------

export async function ensureChangeLogCompressed(
  sessionId: string
): Promise<Session> {
  const storage = getStorage();
  const session = await storage.getSession(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  const changeLog = session.changeLog ?? [];
  if (changeLog.length <= COMPRESS_THRESHOLD) return session;

  const foldCount = changeLog.length - VERBATIM_KEEP;
  const toFold = changeLog.slice(0, foldCount);
  const remaining = changeLog.slice(foldCount);

  let newSummary: string;
  try {
    newSummary = await summarizeChangeLogWindow(
      session.changeLogSummary,
      toFold
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `change-log-window summarization failed for session ${sessionId}: ${
        err instanceof Error ? err.message : String(err)
      }. Proceeding with uncompressed change log.`
    );
    return session;
  }
  return storage.setChangeLogWindow(sessionId, newSummary, remaining);
}

async function summarizeChangeLogWindow(
  priorSummary: string | undefined,
  entriesToFold: readonly ChangeLogEntry[]
): Promise<string> {
  const prompt = getPrompt("summarize.changelog_window");
  const lines = entriesToFold
    .map(
      (e) =>
        `- [${e.ts}] (first impact: ${e.firstImpactStepId}${
          e.firstImpactItemId ? `:${e.firstImpactItemId}` : ""
        }) ${e.description}`
    )
    .join("\n");
  const userMsg = `<prior_summary>
${priorSummary && priorSummary.trim().length > 0 ? priorSummary.trim() : "(none)"}
</prior_summary>

<entries_to_fold>
${lines}
</entries_to_fold>`;

  const { value } = await execute<string>({
    system: prompt.system,
    messages: [{ role: "user", content: userMsg }],
    correctiveHint: prompt.correctiveHint,
    parser: parseSummary,
    maxAttempts: SUMMARIZER_MAX_ATTEMPTS,
    role: "fast",
  });
  return value;
}

// ---------------------------------------------------------------------------
// Helpers — derive what callers need without re-reading storage.
// ---------------------------------------------------------------------------

/** Build the compressed chat view callers can pass to LLMs: the rolling
 *  summary (if any) followed by every verbatim message. The session must
 *  already be compressed (call `ensureChatCompressed` first). */
export function chatWindowFor(session: Session): {
  summary?: string;
  messages: readonly ChatMessage[];
} {
  const summary =
    session.chatSummary && session.chatSummary.trim().length > 0
      ? session.chatSummary.trim()
      : undefined;
  return { summary, messages: session.chat };
}

/** Build the compressed change-log view for step builders. The session
 *  must already be compressed (call `ensureChangeLogCompressed` first). */
export function changeLogWindowFor(session: Session): {
  summary?: string;
  entries: readonly ChangeLogEntry[];
} {
  const summary =
    session.changeLogSummary && session.changeLogSummary.trim().length > 0
      ? session.changeLogSummary.trim()
      : undefined;
  return { summary, entries: session.changeLog ?? [] };
}
