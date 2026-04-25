"use client";

import { Markdown } from "./Markdown";
import { useDocumentStore } from "@/stores/document";
import { useSessionStore } from "@/stores/session";

export function DocumentPanel() {
  const contract = useDocumentStore((s) => s.projectContract);
  const current = useSessionStore((s) => s.current);

  const hasContent = contract.content.length > 0;
  const versionLabel = contract.version > 0 ? `v${contract.version}` : "v0 · drafting";

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
        <div>
          <div className="text-xs uppercase tracking-wider text-neutral-500">
            Document
          </div>
          <div className="text-sm font-semibold text-neutral-200">
            {current ? current.title : "Project Contract"}
          </div>
        </div>
        {hasContent && (
          <div className="rounded border border-neutral-800 px-2 py-0.5 text-[10px] uppercase tracking-wider text-neutral-400">
            {versionLabel}
          </div>
        )}
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
