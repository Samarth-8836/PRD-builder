import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  ChangeLogEntry,
  DiffSummary,
  DocSlotId,
  SlotPayload,
} from "@/lib/pipeline/types";
import type { SessionLifecycle } from "@/lib/pipeline/state";
import {
  type ChatMessage,
  type IStorage,
  type Session,
  type SessionSummary,
  type SuspendedSnapshot,
} from "./types";

const SESSION_FILE_VERSION = 2;

interface SessionFile {
  fileVersion: number;
  session: Session;
}

/**
 * One JSON file per session at `<root>/<sessionId>.json`. Atomic writes via
 * temp-file + rename. Reads/writes are not synchronized internally — the
 * Session Manager holds a per-session lock around any write path so the
 * concurrent-write window is closed at the layer above.
 *
 * M11: file-version bumped to 2 (slot-keyed shape). Pre-M11 files written
 * under fileVersion 1 are not readable; the data/sessions/ tree is a dev
 * artifact and was cleared at the M11 cut.
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
      state: { kind: "phase1" },
      pipelineVersion: 1,
      slots: {},
      chat: [],
    };
    await this.writeSession(session);
    return session;
  }

  async getSession(id: string): Promise<Session | null> {
    try {
      const raw = await fs.readFile(this.pathFor(id), "utf8");
      const parsed = JSON.parse(raw) as SessionFile;
      if (parsed.fileVersion !== SESSION_FILE_VERSION) {
        throw new Error(
          `Session ${id} was written with file version ${parsed.fileVersion}, expected ${SESSION_FILE_VERSION}. M11 changed the storage shape — clear data/sessions/ to start fresh.`
        );
      }
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
        state: session.state,
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

  async setSlot(
    id: string,
    slotId: DocSlotId | string,
    payload: SlotPayload
  ): Promise<Session> {
    const session = await this.requireSession(id);
    const key = String(slotId);
    const existing = session.slots[key];
    const archivedMax = session.slotVersionMax?.[key] ?? 0;
    // Continue from whichever floor is higher: the live slot's version
    // (normal case) or the high-water mark left by a prior clearSlot
    // (cascade-regen case). This prevents version resets on re-creation.
    const floor = Math.max(existing?.version ?? 0, archivedMax);
    const nextVersion = floor + 1;
    session.slots[key] = withVersion(payload, nextVersion);
    if (!session.slotVersionMax) session.slotVersionMax = {};
    session.slotVersionMax[key] = nextVersion;
    // The new payload supersedes any prior cached for regen context.
    if (session.regenContext && key in session.regenContext) {
      delete session.regenContext[key];
      if (Object.keys(session.regenContext).length === 0) {
        delete session.regenContext;
      }
    }
    session.updatedAt = new Date().toISOString();
    await this.writeSession(session);
    return session;
  }

  async clearSlot(
    id: string,
    slotId: DocSlotId | string
  ): Promise<Session> {
    const session = await this.requireSession(id);
    const key = String(slotId);
    const existing = session.slots[key];
    if (existing) {
      // Stash the version so a future setSlot continues from it.
      if (!session.slotVersionMax) session.slotVersionMax = {};
      session.slotVersionMax[key] = Math.max(
        session.slotVersionMax[key] ?? 0,
        existing.version
      );
    }
    delete session.slots[key];
    session.updatedAt = new Date().toISOString();
    await this.writeSession(session);
    return session;
  }

  async markSlotForRegen(
    id: string,
    slotId: DocSlotId | string
  ): Promise<Session> {
    const session = await this.requireSession(id);
    const key = String(slotId);
    const existing = session.slots[key];
    if (!existing) return session;

    if (!session.regenContext) session.regenContext = {};
    session.regenContext[key] = existing;
    if (!session.slotVersionMax) session.slotVersionMax = {};
    session.slotVersionMax[key] = Math.max(
      session.slotVersionMax[key] ?? 0,
      existing.version
    );
    delete session.slots[key];
    session.updatedAt = new Date().toISOString();
    await this.writeSession(session);
    return session;
  }

  async clearRegenContext(id: string): Promise<Session> {
    const session = await this.requireSession(id);
    if (session.regenContext) {
      delete session.regenContext;
      session.updatedAt = new Date().toISOString();
      await this.writeSession(session);
    }
    return session;
  }

  async setChatWindow(
    id: string,
    summary: string,
    chat: ChatMessage[]
  ): Promise<Session> {
    const session = await this.requireSession(id);
    session.chatSummary = summary;
    session.chat = chat;
    session.updatedAt = new Date().toISOString();
    await this.writeSession(session);
    return session;
  }

  async appendChangeLog(
    id: string,
    entry: ChangeLogEntry
  ): Promise<Session> {
    const session = await this.requireSession(id);
    if (!session.changeLog) session.changeLog = [];
    session.changeLog.push(entry);
    session.updatedAt = new Date().toISOString();
    await this.writeSession(session);
    return session;
  }

  async setChangeLogWindow(
    id: string,
    summary: string,
    changeLog: ChangeLogEntry[]
  ): Promise<Session> {
    const session = await this.requireSession(id);
    session.changeLogSummary = summary;
    session.changeLog = changeLog;
    session.updatedAt = new Date().toISOString();
    await this.writeSession(session);
    return session;
  }

  async clearChangeLog(id: string): Promise<Session> {
    const session = await this.requireSession(id);
    if (session.changeLog || session.changeLogSummary) {
      delete session.changeLog;
      delete session.changeLogSummary;
      session.updatedAt = new Date().toISOString();
      await this.writeSession(session);
    }
    return session;
  }

  async appendDiffSummary(
    id: string,
    summary: DiffSummary
  ): Promise<Session> {
    const session = await this.requireSession(id);
    if (!session.changeLog || session.changeLog.length === 0) {
      // No entry to attach to — the slot change happened outside of any
      // confirmed cascade (initial generation, restore, etc.). Drop the
      // diff silently.
      return session;
    }
    const entry = session.changeLog[session.changeLog.length - 1]!;
    if (!entry.diffSummaries) entry.diffSummaries = [];
    const existingIdx = entry.diffSummaries.findIndex(
      (d) => d.slotId === summary.slotId
    );
    if (existingIdx >= 0) {
      entry.diffSummaries[existingIdx] = summary;
    } else {
      entry.diffSummaries.push(summary);
    }
    session.updatedAt = new Date().toISOString();
    await this.writeSession(session);
    return session;
  }

  async setPipelineVersion(id: string, version: number): Promise<Session> {
    const session = await this.requireSession(id);
    session.pipelineVersion = version;
    session.updatedAt = new Date().toISOString();
    await this.writeSession(session);
    return session;
  }

  async bumpPipelineVersion(id: string): Promise<Session> {
    const session = await this.requireSession(id);
    session.pipelineVersion = (session.pipelineVersion ?? 1) + 1;
    session.updatedAt = new Date().toISOString();
    await this.writeSession(session);
    return session;
  }

  async setPendingVersionBump(
    id: string,
    pending: boolean
  ): Promise<Session> {
    const session = await this.requireSession(id);
    if (pending) session.pendingVersionBump = true;
    else delete session.pendingVersionBump;
    session.updatedAt = new Date().toISOString();
    await this.writeSession(session);
    return session;
  }

  async setState(
    id: string,
    state: SessionLifecycle
  ): Promise<Session> {
    const session = await this.requireSession(id);
    session.state = state;
    session.updatedAt = new Date().toISOString();
    await this.writeSession(session);
    return session;
  }

  async setSuspendedSnapshot(
    id: string,
    snapshot: SuspendedSnapshot | null
  ): Promise<Session> {
    const session = await this.requireSession(id);
    if (snapshot === null) delete session.suspended;
    else session.suspended = snapshot;
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

function withVersion(payload: SlotPayload, version: number): SlotPayload {
  switch (payload.kind) {
    case "markdown":
      return { kind: "markdown", content: payload.content, version };
    case "fileset":
      return { kind: "fileset", files: payload.files, version };
    case "json":
      return { kind: "json", data: payload.data, version };
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
