export type Phase =
  | "phase1"
  | "phase2_design_running"
  | "phase2_design_review"
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

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  phase: Phase;
  documents: SessionDocuments;
  chat: ChatMessage[];
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
}
