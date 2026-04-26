"use client";

import { create } from "zustand";
import type { DocumentName } from "@/lib/streaming";

interface DocumentState {
  content: string;
  version: number;
  finalized: boolean;
}

interface DocumentStore {
  projectContract: DocumentState;
  workflowMap: DocumentState;
  screenInventory: DocumentState;
  activeTab: DocumentName;
  reset: () => void;
  appendDelta: (name: DocumentName, text: string) => void;
  setDocument: (name: DocumentName, content: string, version: number) => void;
  setActiveTab: (name: DocumentName) => void;
}

const empty = (): DocumentState => ({ content: "", version: 0, finalized: false });

export const useDocumentStore = create<DocumentStore>((set) => ({
  projectContract: empty(),
  workflowMap: empty(),
  screenInventory: empty(),
  activeTab: "projectContract",
  reset: () =>
    set({
      projectContract: empty(),
      workflowMap: empty(),
      screenInventory: empty(),
      activeTab: "projectContract",
    }),
  appendDelta: (name, text) =>
    set((state) => ({
      [name]: { ...state[name], content: state[name].content + text },
    })),
  setDocument: (name, content, version) =>
    set((state) => {
      const next: Partial<DocumentStore> = {
        [name]: { content, version, finalized: true },
      };
      // Auto-switch the visible tab the first time a document goes
      // non-empty, so the user sees fresh content as the design stage
      // produces it. Subsequent document events on the same doc don't
      // change the active tab.
      if (!state[name].finalized) next.activeTab = name;
      return next;
    }),
  setActiveTab: (activeTab) => set({ activeTab }),
}));
