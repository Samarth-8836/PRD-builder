"use client";

import { useState } from "react";
import { PipelinePicker } from "./PipelinePicker";
import { loadSession, refreshSessionList } from "@/hooks/useSSE";
import { tryGetPipeline } from "@/lib/pipeline/configs";
import { useChatStore } from "@/stores/chat";
import { useDocumentStore } from "@/stores/document";
import { useSessionStore } from "@/stores/session";

export function SessionSidebar() {
  const list = useSessionStore((s) => s.list);
  const current = useSessionStore((s) => s.current);
  const draftPipelineId = useSessionStore((s) => s.draftPipelineId);
  const [pickerOpen, setPickerOpen] = useState(false);

  function openPicker() {
    setPickerOpen(true);
  }

  function pickPipeline(pipelineId: string) {
    setPickerOpen(false);
    useSessionStore.getState().setCurrent(null);
    useSessionStore.getState().setDraftPipelineId(pipelineId);
    useChatStore.getState().reset();
    useDocumentStore.getState().reset();
  }

  async function handleClick(id: string) {
    if (current?.id === id) return;
    useSessionStore.getState().setDraftPipelineId(null);
    await loadSession(id);
  }

  const draftPipeline = tryGetPipeline(draftPipelineId);

  return (
    <div className="flex h-full flex-col p-3">
      <button
        onClick={openPicker}
        className="mb-3 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-left text-sm text-neutral-200 hover:bg-neutral-800"
      >
        + New session
      </button>
      {draftPipeline && !current && (
        <div className="mb-3 rounded-md border border-blue-800 bg-blue-900/20 px-3 py-2 text-[11px] text-blue-200">
          New session pipeline: <strong>{draftPipeline.label}</strong>. Send your
          first message in chat to start.
        </div>
      )}
      <div className="text-xs uppercase tracking-wider text-neutral-500">Sessions</div>
      <button
        onClick={() => void refreshSessionList()}
        className="mt-1 self-start text-[10px] uppercase tracking-wider text-neutral-600 hover:text-neutral-400"
      >
        Refresh
      </button>
      <div className="mt-2 flex flex-col gap-1">
        {list.length === 0 ? (
          <div className="text-sm text-neutral-600">No sessions yet.</div>
        ) : (
          list.map((s) => {
            const pipeline = tryGetPipeline(s.pipelineId);
            return (
              <button
                key={s.id}
                onClick={() => void handleClick(s.id)}
                className={`truncate rounded px-2 py-1.5 text-left text-sm ${
                  current?.id === s.id
                    ? "bg-neutral-800 text-neutral-100"
                    : "text-neutral-300 hover:bg-neutral-900"
                }`}
                title={`${s.title}${pipeline ? ` · ${pipeline.label}` : ""}`}
              >
                <span className="block truncate">{s.title}</span>
                {pipeline && (
                  <span className="block truncate text-[10px] uppercase tracking-wider text-neutral-500">
                    {pipeline.label}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>
      <PipelinePicker
        open={pickerOpen}
        onCancel={() => setPickerOpen(false)}
        onSelect={pickPipeline}
      />
    </div>
  );
}
