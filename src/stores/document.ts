"use client";

import { create } from "zustand";
import type { SlotPayload } from "@/lib/pipeline/types";

export interface ClientSlotState {
  payload: SlotPayload;
  /** True once the canonical (non-streamed) payload has been seen.
   *  Streaming-in-progress slots have `finalized: false`. */
  finalized: boolean;
}

interface DocumentStore {
  /** Slot id -> client-side state. Storage shape and SSE wire shape are
   *  both slot-keyed maps; this mirrors them. */
  slots: Record<string, ClientSlotState>;
  /** Currently visible tab. May be a slot id, or `null` if no slot is
   *  visible yet (initial state). */
  activeTab: string | null;
  reset: () => void;
  /** Append streamed text to the markdown content of a slot. Creates the
   *  slot if missing (treated as starting a fresh stream). */
  appendDelta: (slotId: string, text: string) => void;
  /** Set the canonical payload for a slot. Auto-switches the active tab to
   *  this slot the first time it goes finalized. */
  setSlot: (slotId: string, payload: SlotPayload) => void;
  /** Drop a slot from the client view (cascade rewound past it). */
  clearSlot: (slotId: string) => void;
  setActiveTab: (slotId: string | null) => void;
}

export const useDocumentStore = create<DocumentStore>((set) => ({
  slots: {},
  activeTab: null,
  reset: () => set({ slots: {}, activeTab: null }),
  appendDelta: (slotId, text) =>
    set((state) => {
      const existing = state.slots[slotId];
      const baseContent =
        existing && existing.payload.kind === "markdown"
          ? existing.payload.content
          : "";
      const baseVersion = existing?.payload.version ?? 0;
      return {
        slots: {
          ...state.slots,
          [slotId]: {
            payload: {
              kind: "markdown",
              content: baseContent + text,
              version: baseVersion,
            },
            finalized: false,
          },
        },
      };
    }),
  setSlot: (slotId, payload) =>
    set((state) => {
      const wasFinalized = state.slots[slotId]?.finalized ?? false;
      const nextSlots = {
        ...state.slots,
        [slotId]: { payload, finalized: true },
      };
      // Auto-switch the visible tab the first time a slot goes finalized,
      // so the user sees fresh content as it produces.
      const nextActiveTab = !wasFinalized ? slotId : state.activeTab;
      return { slots: nextSlots, activeTab: nextActiveTab };
    }),
  clearSlot: (slotId) =>
    set((state) => {
      const nextSlots = { ...state.slots };
      delete nextSlots[slotId];
      // If the cleared slot was the active tab, fall back to whichever
      // populated slot remains (any kind), or null.
      const nextActiveTab =
        state.activeTab === slotId
          ? (Object.keys(nextSlots)[0] ?? null)
          : state.activeTab;
      return { slots: nextSlots, activeTab: nextActiveTab };
    }),
  setActiveTab: (activeTab) => set({ activeTab }),
}));
