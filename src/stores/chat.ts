"use client";

import { create } from "zustand";
import type { ChatMessage } from "@/lib/storage";

interface ChatStore {
  messages: ChatMessage[];
  /** In-progress assistant message — accumulates streamed chunks and gets
   *  replaced by the canonical content sent at the end. Promoted into
   *  `messages` on stream completion. */
  pendingAssistant: string;
  streaming: boolean;
  reset: () => void;
  setMessages: (m: ChatMessage[]) => void;
  appendUser: (content: string) => void;
  appendSystem: (content: string) => void;
  appendChunk: (text: string) => void;
  setPendingAssistant: (text: string) => void;
  finalizePending: () => void;
  setStreaming: (b: boolean) => void;
}

export const useChatStore = create<ChatStore>((set) => ({
  messages: [],
  pendingAssistant: "",
  streaming: false,
  reset: () => set({ messages: [], pendingAssistant: "", streaming: false }),
  setMessages: (messages) => set({ messages, pendingAssistant: "" }),
  appendUser: (content) =>
    set((state) => ({
      messages: [
        ...state.messages,
        { role: "user", content, ts: new Date().toISOString() },
      ],
    })),
  appendSystem: (content) =>
    set((state) => ({
      messages: [
        ...state.messages,
        { role: "system", content, ts: new Date().toISOString() },
      ],
    })),
  appendChunk: (text) =>
    set((state) => ({ pendingAssistant: state.pendingAssistant + text })),
  setPendingAssistant: (text) => set({ pendingAssistant: text }),
  finalizePending: () =>
    set((state) => {
      if (!state.pendingAssistant) return {};
      return {
        messages: [
          ...state.messages,
          {
            role: "assistant",
            content: state.pendingAssistant,
            ts: new Date().toISOString(),
          },
        ],
        pendingAssistant: "",
      };
    }),
  setStreaming: (streaming) => set({ streaming }),
}));
