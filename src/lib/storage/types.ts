export type Phase =
  | "phase1"
  | "phase1_complete"
  | "phase2_workflow_running"
  | "phase2_workflow_review"
  | "phase2_screen_running"
  | "phase2_screen_review"
  | "phase2_wireframe_running"
  | "phase2_wireframe_review"
  | "complete";

export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  ts: string;
}

export interface DocumentRecord {
  version: number;
  content: string;
  updatedAt: string;
}

export interface SessionDocuments {
  projectContract?: DocumentRecord;
  workflowMap?: DocumentRecord;
  screenInventory?: DocumentRecord;
}

/**
 * Stage 2 artifact: the clickable wireframe. Stored as a flat map of
 * filename -> file content (UTF-8 text). The viewer fetches files by name
 * via /api/wireframe/[sessionId]/[filename]. Filenames include
 * `index.html`, `data.js`, and `<screen-id>.html` for each screen.
 */
export interface WireframeArtifact {
  version: number;
  files: Record<string, string>;
  updatedAt: string;
}

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  phase: Phase;
  documents: SessionDocuments;
  chat: ChatMessage[];
  /** Legacy field, retained for storage compatibility. As of M10 the
   *  rollback equivalence check uses `phase2Snapshot.contractAtRollback`
   *  instead of this field — every validate-PASS used to overwrite this
   *  with the current contract, which broke the "did the contract change
   *  during rollback?" test. M11 removes this field as part of the slot
   *  storage cut. */
  contractSnapshot?: string;
  /** Saved on rollback from Phase 2 review back to Phase 1. Holds the
   *  Phase 2 documents at the moment of rollback so they can be restored
   *  if the user re-PASSes with an unchanged contract. */
  phase2Snapshot?: Phase2Snapshot;
  /** Stage 2 (Wireframe) artifact. Set by the wireframe stage runner and
   *  read by the file-serving API. */
  wireframe?: WireframeArtifact;
}

export interface Phase2Snapshot {
  workflowMap?: DocumentRecord;
  screenInventory?: DocumentRecord;
  wireframe?: WireframeArtifact;
  /** Phase the user was in at the moment of rollback (one of
   *  phase2_workflow_review, phase2_screen_review, or
   *  phase2_wireframe_review). The restore returns the session to this
   *  phase if the contract is unchanged. */
  phase: Phase;
  /** Contract content at the moment of rollback. Used by the equivalence
   *  check to decide whether to restore the snapshotted Phase 2 work
   *  (contract identical) or regenerate from scratch (contract edited).
   *  Frozen here so subsequent validate-PASS calls can't clobber it
   *  via `setContractSnapshot`. */
  contractAtRollback: string;
  takenAt: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  phase: Phase;
}

export interface IStorage {
  createSession(seed: Pick<Session, "id" | "title">): Promise<Session>;
  getSession(id: string): Promise<Session | null>;
  listSessions(): Promise<SessionSummary[]>;
  saveSession(session: Session): Promise<void>;
  appendChat(id: string, message: ChatMessage): Promise<Session>;
  setTitle(id: string, title: string): Promise<Session>;
  setDocument(
    id: string,
    name: keyof SessionDocuments,
    content: string
  ): Promise<Session>;
  setPhase(id: string, phase: Phase): Promise<Session>;
  setContractSnapshot(id: string, snapshot: string | null): Promise<Session>;
  setPhase2Snapshot(id: string, snapshot: Phase2Snapshot | null): Promise<Session>;
  /** Removes a document by name. Used during rollback to clear stale
   *  Phase 2 docs after they've been moved into phase2Snapshot. */
  clearDocument(id: string, name: keyof SessionDocuments): Promise<Session>;
  /** Replaces the wireframe artifact entirely. Bumps version. Pass null
   *  via clearWireframe to drop. */
  setWireframe(id: string, files: Record<string, string>): Promise<Session>;
  clearWireframe(id: string): Promise<Session>;
}
