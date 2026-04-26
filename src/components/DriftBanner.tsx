"use client";

import { rollbackToPhase1 } from "@/hooks/useSSE";
import { useChatStore } from "@/stores/chat";
import { type DriftState, useSessionStore } from "@/stores/session";

interface DriftBannerProps {
  drift: DriftState;
}

export function DriftBanner({ drift }: DriftBannerProps) {
  if (drift.classification === "COMPATIBLE") return null;

  const sessionId = useSessionStore((s) => s.current?.id);
  const streaming = useChatStore((s) => s.streaming);

  async function handleRollback() {
    if (!sessionId) return;
    try {
      await rollbackToPhase1(sessionId);
    } catch (err) {
      useChatStore.getState().appendSystem(
        `Rollback failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  function handleDismissFlag() {
    useSessionStore.getState().setDrift(null);
  }

  if (drift.classification === "DRIFT") {
    return (
      <div className="border border-red-700 bg-red-900/30 px-3 py-3 text-sm text-red-100">
        <div className="font-semibold uppercase tracking-wider text-red-300 text-[11px]">
          ⛔ Change blocked - contract drift
        </div>
        <div className="mt-1 text-red-100">{drift.reason}</div>
        {drift.driftType && (
          <div className="mt-1 text-[11px] uppercase tracking-wider text-red-400">
            {drift.driftType.replace(/_/g, " ")}
          </div>
        )}
        <div className="mt-2 flex gap-2">
          <button
            onClick={() => void handleRollback()}
            disabled={streaming}
            className="rounded-md bg-red-700 px-3 py-1 text-xs font-medium text-white hover:bg-red-600 disabled:cursor-not-allowed disabled:bg-neutral-800"
          >
            Roll back to Phase 1
          </button>
        </div>
      </div>
    );
  }

  // FLAG
  return (
    <div className="border border-amber-700 bg-amber-900/30 px-3 py-3 text-sm text-amber-100">
      <div className="font-semibold uppercase tracking-wider text-amber-300 text-[11px]">
        ⚠ Warning - possible drift
      </div>
      <div className="mt-1">{drift.reason}</div>
      {drift.driftType && (
        <div className="mt-1 text-[11px] uppercase tracking-wider text-amber-400">
          {drift.driftType.replace(/_/g, " ")}
        </div>
      )}
      <div className="mt-2 flex gap-2">
        <button
          onClick={handleDismissFlag}
          className="rounded-md border border-amber-700 px-3 py-1 text-xs text-amber-200 hover:bg-amber-900/50"
        >
          Dismiss
        </button>
        <button
          onClick={() => void handleRollback()}
          disabled={streaming}
          className="rounded-md bg-amber-700 px-3 py-1 text-xs font-medium text-white hover:bg-amber-600 disabled:cursor-not-allowed disabled:bg-neutral-800"
        >
          Roll back to Phase 1
        </button>
      </div>
    </div>
  );
}
