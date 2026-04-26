"use client";

import { Markdown } from "./Markdown";
import { PhaseIndicator } from "./PhaseIndicator";
import { validatePhase1 } from "@/hooks/useSSE";
import type { DocumentName } from "@/lib/streaming";
import { useChatStore } from "@/stores/chat";
import { useDocumentStore } from "@/stores/document";
import { useSessionStore } from "@/stores/session";

const TAB_LABELS: Record<DocumentName, string> = {
  projectContract: "Project Contract",
  workflowMap: "Workflow Map",
  screenInventory: "Screen Inventory",
};

const TAB_ORDER: DocumentName[] = ["projectContract", "workflowMap", "screenInventory"];

export function DocumentPanel() {
  const docs = useDocumentStore();
  const current = useSessionStore((s) => s.current);
  const streaming = useChatStore((s) => s.streaming);

  const activeDoc = docs[docs.activeTab];
  const hasContract = docs.projectContract.content.length > 0;
  const showDoneButton =
    hasContract && current?.phase === "phase1" && docs.projectContract.finalized;

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
          {showDoneButton && (
            <button
              onClick={() => void handleDone()}
              disabled={streaming}
              className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
            >
              Done - Validate &amp; Complete Phase 1
            </button>
          )}
        </div>
        <DocumentTabs />
      </header>
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {activeDoc.content.length > 0 ? (
          <Markdown>{activeDoc.content}</Markdown>
        ) : (
          <div className="text-sm text-neutral-600">
            {emptyMessageFor(docs.activeTab)}
          </div>
        )}
      </div>
    </div>
  );
}

function DocumentTabs() {
  const docs = useDocumentStore();
  const visibleTabs = TAB_ORDER.filter((name) => docs[name].content.length > 0);
  if (visibleTabs.length <= 1) return null;

  return (
    <div className="mt-3 flex gap-1 border-b border-neutral-800 -mb-3">
      {visibleTabs.map((name) => {
        const isActive = docs.activeTab === name;
        const version = docs[name].version;
        return (
          <button
            key={name}
            onClick={() => docs.setActiveTab(name)}
            className={`px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition ${
              isActive
                ? "border-blue-500 text-neutral-100"
                : "border-transparent text-neutral-500 hover:text-neutral-300"
            }`}
          >
            {TAB_LABELS[name]}
            {version > 0 && (
              <span className="ml-2 text-[10px] uppercase tracking-wider text-neutral-600">
                v{version}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function emptyMessageFor(name: DocumentName): string {
  switch (name) {
    case "projectContract":
      return "The Project Contract will appear here once you describe your idea in chat.";
    case "workflowMap":
      return "The Workflow Map will appear here after Phase 1 is validated.";
    case "screenInventory":
      return "The Screen Inventory will appear here after Phase 1 is validated.";
  }
}
