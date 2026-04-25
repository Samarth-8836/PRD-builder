"use client";

import { useEffect, useRef, useState } from "react";
import { sendChatMessage } from "@/hooks/useSSE";
import { useChatStore } from "@/stores/chat";
import { useSessionStore } from "@/stores/session";

export function ChatPanel() {
  const messages = useChatStore((s) => s.messages);
  const streaming = useChatStore((s) => s.streaming);
  const current = useSessionStore((s) => s.current);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages.length, streaming]);

  async function submit() {
    const trimmed = input.trim();
    if (!trimmed || streaming) return;
    setInput("");
    try {
      await sendChatMessage({ message: trimmed, sessionId: current?.id });
    } catch (err) {
      useChatStore.getState().append({
        role: "system",
        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        ts: new Date().toISOString(),
      });
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4">
        {messages.length === 0 && !streaming ? (
          <div className="text-sm text-neutral-500">
            Type a one-line product idea below to draft a Project Contract.
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {messages.map((m, i) => (
              <li
                key={i}
                className={`max-w-[90%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                  m.role === "user"
                    ? "self-end bg-blue-600/90 text-white"
                    : m.role === "assistant"
                      ? "self-start bg-neutral-800 text-neutral-100"
                      : "self-center bg-amber-900/50 text-amber-200 text-xs"
                }`}
              >
                {m.content}
              </li>
            ))}
            {streaming && (
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
      <div className="border-t border-neutral-800 p-3">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={2}
          placeholder="e.g. I want to build a simple todo app"
          className="w-full resize-none rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-700 focus:outline-none"
          disabled={streaming}
        />
        <div className="mt-2 flex justify-end">
          <button
            onClick={() => void submit()}
            disabled={streaming || !input.trim()}
            className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function Dot({ delay }: { delay: number }) {
  return (
    <span
      className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-neutral-500"
      style={{ animationDelay: `${delay}ms` }}
    />
  );
}
