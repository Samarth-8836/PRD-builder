"use client";

import { useEffect, useRef, useState } from "react";
import { CascadePreviewBanner } from "./CascadePreviewBanner";
import { DriftBanner } from "./DriftBanner";
import { rollbackToPhase1, sendChatMessage } from "@/hooks/useSSE";
import { PRD_PIPELINE } from "@/lib/pipeline/configs/prd-builder";
import type { StepConfig } from "@/lib/pipeline/types";
import { useChatStore } from "@/stores/chat";
import { useSessionStore } from "@/stores/session";

const CONFIG = PRD_PIPELINE;
const STEP_INDEX: ReadonlyMap<string, StepConfig> = new Map(
  CONFIG.steps.map((s) => [String(s.id), s] as const)
);

export function ChatPanel() {
  const messages = useChatStore((s) => s.messages);
  const pendingAssistant = useChatStore((s) => s.pendingAssistant);
  const streaming = useChatStore((s) => s.streaming);
  const current = useSessionStore((s) => s.current);
  const drift = useSessionStore((s) => s.drift);
  const pendingPreview = useSessionStore((s) => s.pendingPreview);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages.length, pendingAssistant.length, streaming, drift]);

  const state = current?.state;
  const blocked = drift?.classification === "DRIFT";
  const previewPending = Boolean(pendingPreview);
  const inAnyReview = state?.kind === "review";
  const isComplete = state?.kind === "complete";
  const canRollback = inAnyReview;

  async function submit() {
    const trimmed = input.trim();
    if (!trimmed || streaming || blocked || previewPending) return;
    setInput("");
    try {
      await sendChatMessage({ message: trimmed, sessionId: current?.id });
    } catch (err) {
      useChatStore.getState().appendSystem(
        `Error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async function handleRollback() {
    if (!current?.id) return;
    try {
      await rollbackToPhase1(current.id);
    } catch (err) {
      useChatStore.getState().appendSystem(
        `Rollback failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  const showPlaceholder = messages.length === 0 && !streaming && !pendingAssistant;
  const showThinking = streaming && !pendingAssistant;
  const placeholder = previewPending
    ? "Confirm or cancel the pending change above to continue."
    : computePlaceholder({
        blocked,
        isComplete,
        state,
        hasSession: Boolean(current),
      });

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4">
        {showPlaceholder ? (
          <div className="text-sm text-neutral-500">
            Type a one-line product idea below to draft a Project Contract.
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {messages.map((m, i) => (
              <li key={i} className={bubbleClass(m.role)}>
                {m.content}
              </li>
            ))}
            {pendingAssistant && (
              <li className={bubbleClass("assistant", true)}>
                {pendingAssistant}
                <span className="ml-1 inline-block h-3 w-1 animate-pulse bg-neutral-500 align-middle" />
              </li>
            )}
            {showThinking && (
              <li className="self-start rounded-lg bg-neutral-800 px-3 py-2 text-sm text-neutral-400">
                <span className="inline-flex gap-1">
                  <Dot delay={0} />
                  <Dot delay={150} />
                  <Dot delay={300} />
                </span>
              </li>
            )}
          </ul>
        )}
      </div>
      {drift && drift.classification !== "COMPATIBLE" && !previewPending && (
        <div className="border-t border-neutral-800">
          <DriftBanner drift={drift} />
        </div>
      )}
      {pendingPreview && (
        <CascadePreviewBanner pending={pendingPreview} />
      )}
      <div className="border-t border-neutral-800 p-3">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={2}
          placeholder={placeholder}
          className="w-full resize-none rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-700 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          disabled={streaming || blocked || isComplete || previewPending}
        />
        <div className="mt-2 flex justify-between gap-2">
          {canRollback && !blocked ? (
            <button
              onClick={() => void handleRollback()}
              disabled={streaming}
              className="rounded-md border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Roll back to Phase 1
            </button>
          ) : (
            <span />
          )}
          <button
            onClick={() => void submit()}
            disabled={streaming || blocked || isComplete || previewPending || !input.trim()}
            className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function computePlaceholder(args: {
  blocked: boolean;
  isComplete: boolean;
  state: import("@/lib/pipeline/state").SessionLifecycle | undefined;
  hasSession: boolean;
}): string {
  if (args.blocked) {
    return "Change blocked. Roll back to Phase 1 to continue editing.";
  }
  if (args.isComplete) {
    return "Session is complete. Roll back to Phase 1 to revise.";
  }
  if (!args.hasSession) {
    return CONFIG.ui?.initialChatPlaceholder ?? "Type a one-line product idea";
  }
  if (args.state?.kind === "review") {
    const step = STEP_INDEX.get(String(args.state.stepId));
    if (step?.reviewPlaceholder) return step.reviewPlaceholder;
  }
  return "Ask a question or request an edit...";
}

function bubbleClass(role: "user" | "assistant" | "system", streaming = false): string {
  const base = "max-w-[90%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm";
  if (role === "user") return `${base} self-end bg-blue-600/90 text-white`;
  if (role === "system")
    return `${base} self-center bg-amber-900/50 text-amber-200 text-xs`;
  return `${base} self-start ${streaming ? "bg-neutral-800/80" : "bg-neutral-800"} text-neutral-100`;
}

function Dot({ delay }: { delay: number }) {
  return (
    <span
      className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-neutral-500"
      style={{ animationDelay: `${delay}ms` }}
    />
  );
}
