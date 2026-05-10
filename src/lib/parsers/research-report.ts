/**
 * Parsers for the Research-Report pipeline (M13).
 *
 * - parseOutline: extracts an ordered list of {id, title, purpose} from a
 *   markdown outline. The outline format is `## <id> — <title>` followed by
 *   one or more lines of free-text purpose, then a blank line / next section.
 * - parseSection: trivial — the LLM produces section body markdown directly,
 *   so we just trim and return.
 */

import { fail, ok, type ParseResult } from "./types";

export interface OutlineSection {
  id: string;
  title: string;
  purpose: string;
}

const SECTION_HEADER_RE = /^##\s+([\w-]+)\s+[—\-:]\s+(.+?)\s*$/;

export function parseOutline(text: string): ParseResult<OutlineSection[]> {
  const lines = text.split(/\r?\n/);
  const out: OutlineSection[] = [];
  let current: OutlineSection | null = null;
  let purposeBuf: string[] = [];

  function flush() {
    if (!current) return;
    current.purpose = purposeBuf.join(" ").replace(/\s+/g, " ").trim();
    if (!current.purpose) {
      // Allow empty-purpose sections — the model sometimes uses a single
      // header line. Default to the title so downstream prompts have
      // something to anchor on.
      current.purpose = current.title;
    }
    out.push(current);
    current = null;
    purposeBuf = [];
  }

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("# ") && !line.startsWith("## ")) {
      // Top-level heading (e.g., "# Outline") — skip
      continue;
    }
    const m = line.match(SECTION_HEADER_RE);
    if (m) {
      flush();
      current = {
        id: m[1]!.trim(),
        title: m[2]!.trim(),
        purpose: "",
      };
      purposeBuf = [];
      continue;
    }
    if (current && line.length > 0) {
      purposeBuf.push(line);
    }
  }
  flush();

  if (out.length === 0) {
    return fail(
      `Outline parse: no sections found. Expected "## <id> — <title>" headers; got ${lines.length} lines.`
    );
  }

  // Reject duplicate ids — the fanout uses the id as a stable item key.
  const seen = new Set<string>();
  for (const s of out) {
    if (seen.has(s.id)) {
      return fail(`Outline parse: duplicate section id "${s.id}"`);
    }
    seen.add(s.id);
  }

  return ok(out);
}

export function parseSection(text: string): ParseResult<string> {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return fail("Section parse: empty body");
  }
  if (trimmed.length < 40) {
    return fail(
      `Section parse: body suspiciously short (${trimmed.length} chars). Expected at least a paragraph.`
    );
  }
  return ok(trimmed);
}
