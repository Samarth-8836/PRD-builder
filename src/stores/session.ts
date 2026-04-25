"use client";

import { create } from "zustand";
import type { Phase, SessionSummary } from "@/lib/storage";

interface CurrentSession {
  id: string;
  title: string;
  phase: Phase;
}

interface SessionStore {
  current: CurrentSession | null;
  list: SessionSummary[];
  setCurrent: (s: CurrentSession | null) => void;
  setList: (s: SessionSummary[]) => void;
  upsert: (s: SessionSummary) => void;
}

export const useSessionStore = create<SessionStore>((set) => ({
  current: null,
  list: [],
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
}));
