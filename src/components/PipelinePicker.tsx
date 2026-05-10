"use client";

import { useState } from "react";
import {
  DEFAULT_PIPELINE_ID,
  REGISTERED_PIPELINES,
} from "@/lib/pipeline/configs";

interface PipelinePickerProps {
  open: boolean;
  onCancel: () => void;
  onSelect: (pipelineId: string) => void;
}

/**
 * Small modal dialog that lets the user pick which pipeline the next
 * session will use. Shown on click of "+ New session" in the sidebar.
 *
 * Shows each registered pipeline with its label + the first phase as a
 * one-line hint. Default selection is the first registered pipeline
 * (PRD), which keeps the legacy single-pipeline UX one click away.
 */
export function PipelinePicker({
  open,
  onCancel,
  onSelect,
}: PipelinePickerProps) {
  const [picked, setPicked] = useState<string>(DEFAULT_PIPELINE_ID);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" role="dialog">
      <div className="absolute inset-0 bg-black/60" onClick={onCancel} aria-hidden />
      <div className="relative z-10 w-full max-w-md rounded-lg border border-neutral-800 bg-neutral-950 p-5 text-neutral-100 shadow-2xl">
        <div className="text-xs uppercase tracking-wider text-neutral-500">
          New session
        </div>
        <div className="mt-1 text-sm font-semibold">Choose a pipeline</div>
        <ul className="mt-4 space-y-2">
          {REGISTERED_PIPELINES.map((p) => {
            const isPicked = picked === p.id;
            const firstPhase = p.phases[0]?.label ?? "";
            return (
              <li key={p.id}>
                <label
                  className={`flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 text-left transition ${
                    isPicked
                      ? "border-blue-600 bg-blue-900/20"
                      : "border-neutral-800 bg-neutral-900/40 hover:bg-neutral-900"
                  }`}
                >
                  <input
                    type="radio"
                    name="pipeline"
                    value={p.id}
                    checked={isPicked}
                    onChange={() => setPicked(p.id)}
                    className="mt-1 accent-blue-500"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-neutral-100">
                      {p.label}
                    </span>
                    <span className="mt-0.5 block text-xs text-neutral-400">
                      {p.id} · {p.steps.length} steps · starts at{" "}
                      <span className="text-neutral-300">{firstPhase}</span>
                    </span>
                    {p.ui?.initialChatPlaceholder && (
                      <span className="mt-1 block text-[11px] italic text-neutral-500">
                        e.g., &ldquo;{p.ui.initialChatPlaceholder}&rdquo;
                      </span>
                    )}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800"
          >
            Cancel
          </button>
          <button
            onClick={() => onSelect(picked)}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
          >
            Start
          </button>
        </div>
      </div>
    </div>
  );
}
