"use client";

import { create } from "zustand";
import type { DocumentName, MarkdownDocumentName } from "@/lib/streaming";

interface DocumentState {
  content: string;
  version: number;
  finalized: boolean;
}

interface WireframeState {
  ready: boolean;
  version: number;
  files: string[];
}

interface DocumentStore {
  projectContract: DocumentState;
  workflowMap: DocumentState;
  screenInventory: DocumentState;
  wireframe: WireframeState;
  activeTab: DocumentName;
  reset: () => void;
  appendDelta: (name: MarkdownDocumentName, text: string) => void;
  setDocument: (name: MarkdownDocumentName, content: string, version: number) => void;
  setWireframe: (version: number, files: string[]) => void;
  clearWireframe: () => void;
  setActiveTab: (name: DocumentName) => void;
}

const empty = (): DocumentState => ({ content: "", version: 0, finalized: false });
const emptyWireframe = (): WireframeState => ({ ready: false, version: 0, files: [] });

export const useDocumentStore = create<DocumentStore>((set) => ({
  projectContract: empty(),
  workflowMap: empty(),
  screenInventory: empty(),
  wireframe: emptyWireframe(),
  activeTab: "projectContract",
  reset: () =>
    set({
      projectContract: empty(),
      workflowMap: empty(),
      screenInventory: empty(),
      wireframe: emptyWireframe(),
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
  setWireframe: (version, files) =>
    set(() => ({
      wireframe: { ready: true, version, files },
      // Auto-switch to the wireframe tab when it first becomes ready.
      activeTab: "wireframe",
    })),
  clearWireframe: () =>
    set((state) => ({
      wireframe: emptyWireframe(),
      // If the user was viewing the wireframe tab, snap back to the
      // contract tab so the panel doesn't sit on an empty viewer.
      activeTab: state.activeTab === "wireframe" ? "projectContract" : state.activeTab,
    })),
  setActiveTab: (activeTab) => set({ activeTab }),
}));
