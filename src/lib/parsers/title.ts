import { fail, ok, type ParseResult } from "./types";

export function parseTitle(input: string): ParseResult<string> {
  const firstLine = (input ?? "").split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  if (!firstLine) return fail("Title was empty");

  const cleaned = firstLine
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.!?,;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return fail("Title was empty after cleanup");
  if (cleaned.length > 80) return fail(`Title too long (${cleaned.length} chars)`);

  const wordCount = cleaned.split(/\s+/).length;
  if (wordCount < 1 || wordCount > 8) {
    return fail(`Title should be 1-8 words, got ${wordCount}`);
  }

  return ok(cleaned);
}
