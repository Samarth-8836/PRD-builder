"use client";

import { create } from "zustand";

interface DocumentState {
  content: string;
  version: number;
  finalized: boolean;
}

interface DocumentStore {
  projectContract: DocumentState;
  reset: () => void;
  appendDelta: (text: string) => void;
  setDocument: (content: string, version: number) => void;
}

const empty = (): DocumentState => ({ content: "", version: 0, finalized: false });

export const useDocumentStore = create<DocumentStore>((set) => ({
  projectContract: empty(),
  reset: () => set({ projectContract: empty() }),
  appendDelta: (text) =>
    set((state) => ({
      projectContract: {
        ...state.projectContract,
        content: state.projectContract.content + text,
      },
    })),
  setDocument: (content, version) =>
    set({ projectContract: { content, version, finalized: true } }),
}));
