"use client";

import { Markdown } from "./Markdown";
import { PhaseIndicator } from "./PhaseIndicator";
import { validatePhase1 } from "@/hooks/useSSE";
import { useChatStore } from "@/stores/chat";
import { useDocumentStore } from "@/stores/document";
import { useSessionStore } from "@/stores/session";

export function DocumentPanel() {
  const contract = useDocumentStore((s) => s.projectContract);
  const current = useSessionStore((s) => s.current);
  const streaming = useChatStore((s) => s.streaming);

  const hasContent = contract.content.length > 0;
  const versionLabel = contract.version > 0 ? `v${contract.version}` : "v0 - drafting";
  const showDoneButton = hasContent && current?.phase === "phase1" && contract.finalized;
  const validated = current?.phase === "phase1_complete";

  async function handleDone() {
    if (!current) return;
    try {
      await validatePhase1(current.id);
    } catch (err) {
      useChatStore.getState().appendSystem(
        `Error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-neutral-800 px-4 py-3">
        {current && (
          <div className="mb-2">
            <PhaseIndicator phase={current.phase} />
          </div>
        )}
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-xs uppercase tracking-wider text-neutral-500">
              Document
            </div>
            <div className="truncate text-sm font-semibold text-neutral-200">
              {current ? current.title : "Project Contract"}
            </div>
          </div>
          {hasContent && (
            <div className="flex items-center gap-2">
              <div className="rounded border border-neutral-800 px-2 py-0.5 text-[10px] uppercase tracking-wider text-neutral-400">
                {versionLabel}
              </div>
              {showDoneButton && (
                <button
                  onClick={() => void handleDone()}
                  disabled={streaming}
                  className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
                >
                  Done - Validate &amp; Complete Phase 1
                </button>
              )}
              {validated && (
                <div className="rounded-md border border-emerald-700 bg-emerald-900/40 px-3 py-1 text-xs font-medium text-emerald-300">
                  ✓ Phase 1 validated
                </div>
              )}
            </div>
          )}
        </div>
      </header>
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {hasContent ? (
          <Markdown>{contract.content}</Markdown>
        ) : (
          <div className="text-sm text-neutral-600">
            The Project Contract will appear here once you describe your idea in chat.
          </div>
        )}
      </div>
    </div>
  );
}
