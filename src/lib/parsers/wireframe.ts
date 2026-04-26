import { fail, ok, type ParseResult } from "./types";

/**
 * Phase 2 Stage 2 (Wireframe) parsers.
 *   - parseDummyData:    JSON object describing realistic sample content per entity
 *   - parseHtmlDocument: full HTML document (used for both the shell and per-screen output)
 */

// ---------------------------------------------------------------------------
// Dummy data — JSON object keyed by entity name (or "_meta")
// ---------------------------------------------------------------------------

export type DummyData = Record<string, unknown>;

export function parseDummyData(input: string): ParseResult<DummyData> {
  const text = stripCodeFences(input).trim();
  if (!text) return fail("Dummy data response was empty");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(`Dummy data was not valid JSON: ${msg}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail("Dummy data must be a JSON object at the top level");
  }
  const obj = parsed as DummyData;
  const keys = Object.keys(obj);
  if (keys.length === 0) {
    return fail("Dummy data object had no keys");
  }
  return ok(obj);
}

// ---------------------------------------------------------------------------
// HTML document — used for both index.html (shell) and per-screen pages
// ---------------------------------------------------------------------------

export function parseHtmlDocument(input: string): ParseResult<string> {
  const text = stripCodeFences(input).trim();
  if (!text) return fail("HTML response was empty");

  const lower = text.toLowerCase();
  // Either a doctype or an <html ...> opening tag must appear in the first ~256 chars.
  const head = lower.slice(0, 256);
  const hasDoctype = head.includes("<!doctype html");
  const hasHtml = lower.includes("<html");
  if (!hasDoctype && !hasHtml) {
    return fail("HTML response is missing <!doctype html> and <html> tag");
  }
  if (!lower.includes("<body")) {
    return fail("HTML response is missing a <body> tag");
  }
  if (!lower.includes("</html>")) {
    return fail("HTML response is missing the closing </html> tag");
  }
  return ok(text);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripCodeFences(text: string): string {
  const fenceWrap = text.match(/^\s*```[\w-]*\n([\s\S]*?)\n```\s*$/);
  return fenceWrap ? fenceWrap[1]! : text;
}
