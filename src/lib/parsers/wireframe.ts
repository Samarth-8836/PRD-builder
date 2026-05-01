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

  // Tolerance: the prompt asks for strict JSON only, but the model
  // sometimes appends explanatory prose after the closing brace. Extract
  // the first balanced JSON object and parse just that. If extraction
  // fails, fall back to parsing the raw text and report the underlying
  // JSON error.
  const candidate = extractFirstJsonObject(text) ?? text;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
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

/**
 * Returns the first balanced `{...}` substring from `text`, respecting
 * string literals and escapes. Returns null if no balanced object is
 * found. Used to tolerate trailing prose after a strict-JSON response.
 */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTML document — used for both index.html (shell) and per-screen pages
// ---------------------------------------------------------------------------

export function parseHtmlDocument(input: string): ParseResult<string> {
  const text = stripCodeFences(input).trim();
  if (!text) return fail("HTML response was empty");

  // Tolerance: trim any leading or trailing prose that surrounds the
  // actual HTML document. Find the first <!doctype or <html and the
  // last </html>, slice between them. Saves the artifact as a clean
  // valid HTML document even when the model adds preamble or commentary.
  const lower = text.toLowerCase();
  let startIdx = lower.indexOf("<!doctype");
  if (startIdx === -1) startIdx = lower.indexOf("<html");
  if (startIdx === -1) {
    return fail("HTML response is missing <!doctype html> and <html> tag");
  }
  const endTag = "</html>";
  const endIdx = lower.lastIndexOf(endTag);
  if (endIdx === -1) {
    return fail("HTML response is missing the closing </html> tag");
  }
  const trimmed = text.slice(startIdx, endIdx + endTag.length);
  const trimmedLower = trimmed.toLowerCase();
  if (!trimmedLower.includes("<body")) {
    return fail("HTML response is missing a <body> tag");
  }
  return ok(trimmed);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripCodeFences(text: string): string {
  const fenceWrap = text.match(/^\s*```[\w-]*\n([\s\S]*?)\n```\s*$/);
  return fenceWrap ? fenceWrap[1]! : text;
}
