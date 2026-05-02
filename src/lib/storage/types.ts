/**
 * Session storage shape — M11 cut.
 *
 * The 9-member `Phase` union and the named-document fields (`projectContract`,
 * `workflowMap`, `screenInventory`, `wireframe`) are gone. Sessions now hold:
 *
 *   - `state: SessionLifecycle` — tagged union derived from the pipeline DAG,
 *     not a hand-rolled list of phase strings.
 *   - `slots: Record<DocSlotId, SlotPayload>` — opaque slot map keyed by ids
 *     declared in `PipelineConfig.slots`.
 *
 * Storage interactions go through four generic methods (`setSlot`,
 * `clearSlot`, `setState`, `setSuspendedSnapshot`) — there are no more
 * document-specific or wireframe-specific writers.
 *
 * Pre-M11 session JSONs are not migrated. The `data/sessions` directory is a
 * dev artifact and is cleared at the M11 cut.
 */

import type { SessionLifecycle } from "@/lib/pipeline/state";
import type { DocSlotId, SlotPayload } from "@/lib/pipeline/types";

export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  ts: string;
}

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Lifecycle state. Replaces the legacy `phase` string union. */
  state: SessionLifecycle;
  /** Opaque slot-keyed payload map. Slot ids are declared by the active
   *  pipeline config (`PipelineConfig.slots`). */
  slots: Record<string, SlotPayload>;
  /** Per-slot high-water-mark of versions ever assigned. Survives
   *  `clearSlot`, so a cascade that re-creates a previously-cleared
   *  slot continues from the prior version (no v1 reset). */
  slotVersionMax?: Record<string, number>;
  chat: ChatMessage[];
  /** Snapshot saved when the user rolls back from a Phase 2 review back to
   *  Phase 1. Restored if the user re-validates with an unchanged contract. */
  suspended?: SuspendedSnapshot;
}

/**
 * Frozen Phase 2 work captured on rollback. `slots` carries every non-anchor
 * slot at the time of rollback (the contract is excluded — the user is
 * about to edit it). `anchorAtRollback` carries the contract content so the
 * equivalence check can decide whether to restore or regenerate after the
 * user re-validates.
 */
export interface SuspendedSnapshot {
  /** Slot id -> payload at rollback. Excludes the drift-anchor slot. */
  slots: Record<string, SlotPayload>;
  /** Lifecycle state at the moment of rollback (a `review` state by
   *  construction — rollback is only allowed from review/complete). */
  state: SessionLifecycle;
  /** Drift-anchor slot's content at rollback time. Used by the equivalence
   *  check to decide whether to restore vs. regenerate. */
  anchorAtRollback: string;
  takenAt: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  state: SessionLifecycle;
}

export interface IStorage {
  createSession(seed: Pick<Session, "id" | "title">): Promise<Session>;
  getSession(id: string): Promise<Session | null>;
  listSessions(): Promise<SessionSummary[]>;
  saveSession(session: Session): Promise<void>;
  appendChat(id: string, message: ChatMessage): Promise<Session>;
  setTitle(id: string, title: string): Promise<Session>;
  /** Write a slot payload. The caller passes the payload as-is; storage
   *  bumps the version. Pass null via `clearSlot` to drop a slot. */
  setSlot(
    id: string,
    slotId: DocSlotId | string,
    payload: SlotPayload
  ): Promise<Session>;
  clearSlot(id: string, slotId: DocSlotId | string): Promise<Session>;
  setState(id: string, state: SessionLifecycle): Promise<Session>;
  setSuspendedSnapshot(
    id: string,
    snapshot: SuspendedSnapshot | null
  ): Promise<Session>;
}
