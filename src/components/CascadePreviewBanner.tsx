"use client";

import { useMemo } from "react";
import { confirmCascade, cancelCascade } from "@/hooks/useSSE";
import { tryGetPipeline } from "@/lib/pipeline/configs";
import { describeLifecycle } from "@/lib/pipeline";
import type { PendingPreviewState } from "@/stores/session";
import { useChatStore } from "@/stores/chat";
import { useSessionStore } from "@/stores/session";

/**
 * Cascade-preview gate. Renders above the chat input whenever there is a
 * pending cascade preview. Confirm runs the cascade; Cancel drops the
 * pending plan server-side and returns the user to the unblocked review
 * state.
 */
export function CascadePreviewBanner({
  pending,
}: {
  pending: PendingPreviewState;
}) {
  const session = useSessionStore((s) => s.current);
  const sessionId = session?.id;
  const streaming = useChatStore((s) => s.streaming);
  const { preview, description } = pending;

  const pipeline = tryGetPipeline(session?.pipelineId);
  const slotLabels = useMemo(
    () =>
      Object.fromEntries(
        (pipeline?.slots ?? []).map((s) => [String(s.id), s.label] as const)
      ) as Record<string, string>,
    [pipeline]
  );
  const stepLabels = useMemo(
    () =>
      Object.fromEntries(
        (pipeline?.steps ?? []).map((s) => [String(s.id), s.label] as const)
      ) as Record<string, string>,
    [pipeline]
  );

  const stepLabel = stepLabels[String(preview.firstImpactStepId)] ?? preview.firstImpactStepId;
  const itemSuffix = preview.firstImpactItemId
    ? ` (${preview.firstImpactItemId})`
    : "";
  const affectedLabels = preview.affectedSlots.map(
    (id) => slotLabels[String(id)] ?? String(id)
  );
  const endsAt = describeLifecycle(preview.endsAt);

  async function onConfirm() {
    if (!sessionId) return;
    try {
      await confirmCascade(sessionId);
    } catch (err) {
      useChatStore.getState().appendSystem(
        `Confirm failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async function onCancel() {
    if (!sessionId) return;
    try {
      await cancelCascade(sessionId);
    } catch (err) {
      useChatStore.getState().appendSystem(
        `Cancel failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return (
    <div className="border-t border-amber-700/60 bg-amber-900/20 px-3 py-3 text-amber-100">
      <div className="text-[10px] uppercase tracking-wider text-amber-300">
        Confirm change
      </div>
      <div className="mt-1 text-sm">{description}</div>
      <ul className="mt-2 space-y-0.5 text-xs text-amber-200/90">
        <li>
          <span className="text-amber-300/70">First impact:</span> {stepLabel}
          {itemSuffix}
        </li>
        <li>
          <span className="text-amber-300/70">Affects:</span>{" "}
          {affectedLabels.length > 0
            ? affectedLabels.join(", ")
            : "(no slots populated yet)"}
        </li>
        <li>
          <span className="text-amber-300/70">Work:</span>{" "}
          {preview.estimatedWork}
        </li>
        <li>
          <span className="text-amber-300/70">Lands at:</span> {endsAt}
        </li>
      </ul>
      <div className="mt-3 flex justify-end gap-2">
        <button
          onClick={() => void onCancel()}
          disabled={streaming}
          className="rounded-md border border-amber-700/60 bg-transparent px-3 py-1.5 text-xs text-amber-200 hover:bg-amber-900/40 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={() => void onConfirm()}
          disabled={streaming}
          className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-500 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
        >
          Confirm
        </button>
      </div>
    </div>
  );
}
