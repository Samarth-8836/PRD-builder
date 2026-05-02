"use client";

import { create } from "zustand";
import type { CascadePreview } from "@/lib/pipeline";
import type { SessionLifecycle } from "@/lib/pipeline/state";
import type { SessionSummary } from "@/lib/storage";

interface CurrentSession {
  id: string;
  title: string;
  state: SessionLifecycle;
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
  setCurrent: (s: CurrentSession | null) => void;
  setList: (s: SessionSummary[]) => void;
  upsert: (s: SessionSummary) => void;
  setDrift: (d: DriftState | null) => void;
  setPendingPreview: (p: PendingPreviewState | null) => void;
}

export const useSessionStore = create<SessionStore>((set) => ({
  current: null,
  list: [],
  drift: null,
  pendingPreview: null,
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
}));
