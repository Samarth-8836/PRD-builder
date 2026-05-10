"use client";

import { create } from "zustand";
import type { CascadePreview } from "@/lib/pipeline";
import type { SessionLifecycle } from "@/lib/pipeline/state";
import type { SessionSummary } from "@/lib/storage";

interface CurrentSession {
  id: string;
  title: string;
  state: SessionLifecycle;
  pipelineVersion: number;
  pipelineId: string;
}

export interface DriftState {
  classification: "COMPATIBLE" | "FLAG" | "DRIFT";
  driftType?: string;
  reason: string;
  scope?: string;
}

export interface PendingPreviewState {
  description: string;
  preview: CascadePreview;
}

interface SessionStore {
  current: CurrentSession | null;
  list: SessionSummary[];
  drift: DriftState | null;
  /** A cascade is awaiting user Confirm/Cancel. While set, the chat
   *  textarea is disabled and the preview banner is rendered. Cleared
   *  when the user confirms (then progress events flow), cancels, or
   *  rolls back. */
  pendingPreview: PendingPreviewState | null;
  /** Pipeline id chosen by the user for the next session creation. Set
   *  when the user clicks "+ New session" and picks a pipeline; consumed
   *  by `sendChatMessage` on the first message and forwarded to the
   *  server's `startSession`. Cleared after the session is created (the
   *  server's `meta` event sets `current.pipelineId` directly). */
  draftPipelineId: string | null;
  setCurrent: (s: CurrentSession | null) => void;
  setList: (s: SessionSummary[]) => void;
  upsert: (s: SessionSummary) => void;
  setDrift: (d: DriftState | null) => void;
  setPendingPreview: (p: PendingPreviewState | null) => void;
  setDraftPipelineId: (id: string | null) => void;
}

export const useSessionStore = create<SessionStore>((set) => ({
  current: null,
  list: [],
  drift: null,
  pendingPreview: null,
  draftPipelineId: null,
  setCurrent: (current) => set({ current }),
  setList: (list) => set({ list }),
  upsert: (s) =>
    set((state) => {
      const existing = state.list.findIndex((x) => x.id === s.id);
      const next = state.list.slice();
      if (existing >= 0) next[existing] = s;
      else next.unshift(s);
      next.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
      return { list: next };
    }),
  setDrift: (drift) => set({ drift }),
  setPendingPreview: (pendingPreview) => set({ pendingPreview }),
  setDraftPipelineId: (draftPipelineId) => set({ draftPipelineId }),
}));
