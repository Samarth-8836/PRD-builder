"use client";

import { create } from "zustand";
import type { ChatMessage } from "@/lib/storage";

interface ChatStore {
  messages: ChatMessage[];
  streaming: boolean;
  reset: () => void;
  setMessages: (m: ChatMessage[]) => void;
  append: (m: ChatMessage) => void;
  setStreaming: (b: boolean) => void;
}

export const useChatStore = create<ChatStore>((set) => ({
  messages: [],
  streaming: false,
  reset: () => set({ messages: [], streaming: false }),
  setMessages: (messages) => set({ messages }),
  append: (m) => set((state) => ({ messages: [...state.messages, m] })),
  setStreaming: (streaming) => set({ streaming }),
}));
