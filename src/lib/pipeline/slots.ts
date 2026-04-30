/**
 * Typed slot accessors. Domain code (operations, formatters, runners) reads
 * slots through these helpers to retain narrow types. Engine and UI accept
 * the wide `SlotPayload` union directly.
 *
 * The accessors throw at runtime when a slot is missing or has the wrong
 * kind — that's the right behavior because callers know what they need.
 */

import type {
  DocSlotId,
  FilesetPayload,
  JsonPayload,
  MarkdownPayload,
  SlotPayload,
} from "./types";

export class SlotMissingError extends Error {
  constructor(slotId: string) {
    super(`Slot "${slotId}" is not set`);
    this.name = "SlotMissingError";
  }
}

export class SlotKindMismatchError extends Error {
  constructor(slotId: string, expected: string, actual: string) {
    super(`Slot "${slotId}" expected kind "${expected}", got "${actual}"`);
    this.name = "SlotKindMismatchError";
  }
}

/** Read a markdown slot's payload. Throws if missing or wrong-kind. */
export function requireMarkdown(
  slots: Readonly<Record<string, SlotPayload>>,
  id: DocSlotId | string
): MarkdownPayload {
  const p = slots[id as string];
  if (!p) throw new SlotMissingError(String(id));
  if (p.kind !== "markdown") {
    throw new SlotKindMismatchError(String(id), "markdown", p.kind);
  }
  return p;
}

export function requireFileset(
  slots: Readonly<Record<string, SlotPayload>>,
  id: DocSlotId | string
): FilesetPayload {
  const p = slots[id as string];
  if (!p) throw new SlotMissingError(String(id));
  if (p.kind !== "fileset") {
    throw new SlotKindMismatchError(String(id), "fileset", p.kind);
  }
  return p;
}

export function requireJson(
  slots: Readonly<Record<string, SlotPayload>>,
  id: DocSlotId | string
): JsonPayload {
  const p = slots[id as string];
  if (!p) throw new SlotMissingError(String(id));
  if (p.kind !== "json") {
    throw new SlotKindMismatchError(String(id), "json", p.kind);
  }
  return p;
}

/** Optional read — returns the payload or undefined. */
export function getSlot(
  slots: Readonly<Record<string, SlotPayload>>,
  id: DocSlotId | string
): SlotPayload | undefined {
  return slots[id as string];
}

/** Convenience: read markdown content as a string, or undefined. */
export function getMarkdownContent(
  slots: Readonly<Record<string, SlotPayload>>,
  id: DocSlotId | string
): string | undefined {
  const p = slots[id as string];
  if (!p || p.kind !== "markdown") return undefined;
  return p.content;
}

/** Build a fresh SlotPayload from a write. The engine bumps version. */
export function makeMarkdown(content: string, version = 0): MarkdownPayload {
  return { kind: "markdown", content, version };
}
export function makeFileset(
  files: Record<string, string>,
  version = 0
): FilesetPayload {
  return { kind: "fileset", files, version };
}
export function makeJson(data: unknown, version = 0): JsonPayload {
  return { kind: "json", data, version };
}
