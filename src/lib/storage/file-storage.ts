import { promises as fs } from "node:fs";
import path from "node:path";
import {
  type ChatMessage,
  type IStorage,
  type Phase,
  type Phase2Snapshot,
  type Session,
  type SessionDocuments,
  type SessionSummary,
} from "./types";

const SESSION_FILE_VERSION = 1;

interface SessionFile {
  fileVersion: number;
  session: Session;
}

/**
 * One JSON file per session at `<root>/<sessionId>.json`. Atomic writes via
 * temp-file + rename. Reads/writes are not synchronized internally — the
 * Session Manager holds a per-session lock around any write path so the
 * concurrent-write window is closed at the layer above.
 */
export class FileStorage implements IStorage {
  constructor(private readonly root: string) {}

  async createSession(seed: Pick<Session, "id" | "title">): Promise<Session> {
    await fs.mkdir(this.root, { recursive: true });
    const now = new Date().toISOString();
    const session: Session = {
      id: seed.id,
      title: seed.title,
      createdAt: now,
      updatedAt: now,
      phase: "phase1",
      documents: {},
      chat: [],
    };
    await this.writeSession(session);
    return session;
  }

  async getSession(id: string): Promise<Session | null> {
    try {
      const raw = await fs.readFile(this.pathFor(id), "utf8");
      const parsed = JSON.parse(raw) as SessionFile;
      return parsed.session;
    } catch (err: unknown) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  async listSessions(): Promise<SessionSummary[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.root);
    } catch (err: unknown) {
      if (isMissing(err)) return [];
      throw err;
    }

    const sessions: SessionSummary[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const id = entry.slice(0, -".json".length);
      const session = await this.getSession(id);
      if (!session) continue;
      sessions.push({
        id: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
        phase: session.phase,
      });
    }
    sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return sessions;
  }

  async saveSession(session: Session): Promise<void> {
    await this.writeSession({ ...session, updatedAt: new Date().toISOString() });
  }

  async appendChat(id: string, message: ChatMessage): Promise<Session> {
    const session = await this.requireSession(id);
    session.chat.push(message);
    session.updatedAt = new Date().toISOString();
    await this.writeSession(session);
    return session;
  }

  async setTitle(id: string, title: string): Promise<Session> {
    const session = await this.requireSession(id);
    session.title = title;
    session.updatedAt = new Date().toISOString();
    await this.writeSession(session);
    return session;
  }

  async setDocument(
    id: string,
    name: keyof SessionDocuments,
    content: string
  ): Promise<Session> {
    const session = await this.requireSession(id);
    const existing = session.documents[name];
    const next = {
      version: existing ? existing.version + 1 : 1,
      content,
      updatedAt: new Date().toISOString(),
    };
    session.documents[name] = next;
    session.updatedAt = next.updatedAt;
    await this.writeSession(session);
    return session;
  }

  async setPhase(id: string, phase: Phase): Promise<Session> {
    const session = await this.requireSession(id);
    session.phase = phase;
    session.updatedAt = new Date().toISOString();
    await this.writeSession(session);
    return session;
  }

  async setContractSnapshot(id: string, snapshot: string | null): Promise<Session> {
    const session = await this.requireSession(id);
    if (snapshot === null) delete session.contractSnapshot;
    else session.contractSnapshot = snapshot;
    session.updatedAt = new Date().toISOString();
    await this.writeSession(session);
    return session;
  }

  async setPhase2Snapshot(
    id: string,
    snapshot: Phase2Snapshot | null
  ): Promise<Session> {
    const session = await this.requireSession(id);
    if (snapshot === null) delete session.phase2Snapshot;
    else session.phase2Snapshot = snapshot;
    session.updatedAt = new Date().toISOString();
    await this.writeSession(session);
    return session;
  }

  async clearDocument(id: string, name: keyof SessionDocuments): Promise<Session> {
    const session = await this.requireSession(id);
    delete session.documents[name];
    session.updatedAt = new Date().toISOString();
    await this.writeSession(session);
    return session;
  }

  private pathFor(id: string): string {
    return path.join(this.root, `${id}.json`);
  }

  private async requireSession(id: string): Promise<Session> {
    const session = await this.getSession(id);
    if (!session) throw new Error(`Session ${id} not found`);
    return session;
  }

  private async writeSession(session: Session): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    const payload: SessionFile = { fileVersion: SESSION_FILE_VERSION, session };
    const target = this.pathFor(session.id);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
    await fs.rename(tmp, target);
  }
}

function isMissing(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
