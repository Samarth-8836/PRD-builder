"use client";

import { useState } from "react";
import { HistoryPanel } from "./HistoryPanel";
import { Markdown } from "./Markdown";
import { PhaseIndicator } from "./PhaseIndicator";
import { WireframeViewer } from "./WireframeViewer";
import { approve, validatePhase1 } from "@/hooks/useSSE";
import { PRD_PIPELINE, PRD_SLOT_IDS } from "@/lib/pipeline/configs/prd-builder";
import type { DocSlot, StepConfig } from "@/lib/pipeline/types";
import { useChatStore } from "@/stores/chat";
import { useDocumentStore } from "@/stores/document";
import { useSessionStore } from "@/stores/session";

const CONFIG = PRD_PIPELINE;

/** Slots eligible to render as a tab. JSON slots are internal-only — they
 *  feed the wireframe but don't have their own viewer. */
const VISIBLE_SLOTS: readonly DocSlot[] = CONFIG.slots.filter(
  (s) => s.kind !== "json"
);

const STEP_INDEX: ReadonlyMap<string, StepConfig> = new Map(
  CONFIG.steps.map((s) => [String(s.id), s] as const)
);

export function DocumentPanel() {
  const slots = useDocumentStore((s) => s.slots);
  const activeTab = useDocumentStore((s) => s.activeTab);
  const setActiveTab = useDocumentStore((s) => s.setActiveTab);
  const current = useSessionStore((s) => s.current);
  const streaming = useChatStore((s) => s.streaming);
  const [historyOpen, setHistoryOpen] = useState(false);

  const state = current?.state;
  const contractClient = slots[PRD_SLOT_IDS.projectContract];
  const hasContract = Boolean(contractClient?.payload.kind === "markdown" &&
    contractClient.payload.content.length > 0);

  const showDoneButton =
    hasContract && state?.kind === "phase1" && contractClient?.finalized;

  const reviewStep =
    state?.kind === "review" ? STEP_INDEX.get(String(state.stepId)) : undefined;
  const reviewStepProduceSlot = reviewStep?.produces[0];
  const reviewSlotPopulated = reviewStepProduceSlot
    ? Boolean(slots[String(reviewStepProduceSlot)]?.finalized)
    : false;
  const showApprove =
    state?.kind === "review" && reviewSlotPopulated && Boolean(reviewStep);
  const approveLabel = reviewStep?.approveLabel ?? "Approve";

  const wireframeReady = Boolean(slots[PRD_SLOT_IDS.wireframeFiles]?.finalized);
  const showExport =
    current && (wireframeReady || state?.kind === "complete");

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

  async function handleApprove() {
    if (!current) return;
    try {
      await approve(current.id);
    } catch (err) {
      useChatStore.getState().appendSystem(
        `Error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-neutral-800 px-4 py-3">
        {state && (
          <div className="mb-2">
            <PhaseIndicator state={state} />
          </div>
        )}
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-neutral-500">
              <span>Document</span>
              {current && current.pipelineVersion > 1 && (
                <span
                  className="rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-[10px] font-medium text-neutral-300"
                  title={`Locked pipeline version ${current.pipelineVersion}`}
                >
                  v{current.pipelineVersion}
                </span>
              )}
            </div>
            <div className="truncate text-sm font-semibold text-neutral-200">
              {current ? current.title : "Project Contract"}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {current && (
              <button
                onClick={() => setHistoryOpen(true)}
                className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1 text-xs font-medium text-neutral-200 hover:bg-neutral-800"
                title="View confirmed change history"
              >
                History
              </button>
            )}
            {showExport && current && (
              <a
                href={`/api/export/${current.id}`}
                className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1 text-xs font-medium text-neutral-200 hover:bg-neutral-800"
              >
                Export ↓
              </a>
            )}
            {showDoneButton && (
              <button
                onClick={() => void handleDone()}
                disabled={streaming}
                className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
              >
                Done - Validate &amp; Complete Phase 1
              </button>
            )}
            {showApprove && (
              <button
                onClick={() => void handleApprove()}
                disabled={streaming}
                className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
              >
                {approveLabel}
              </button>
            )}
          </div>
        </div>
        <DocumentTabs activeTab={activeTab} onSelect={setActiveTab} />
      </header>
      <DocumentBody activeTab={activeTab} />
      <HistoryPanel open={historyOpen} onClose={() => setHistoryOpen(false)} />
    </div>
  );
}

function DocumentBody({ activeTab }: { activeTab: string | null }) {
  const slots = useDocumentStore((s) => s.slots);

  const slot = activeTab ? VISIBLE_SLOTS.find((s) => String(s.id) === activeTab) : undefined;
  if (!slot) {
    return (
      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="text-sm text-neutral-600">
          {VISIBLE_SLOTS[0]?.emptyMessage ?? "Nothing to display yet."}
        </div>
      </div>
    );
  }

  const client = slots[String(slot.id)];

  if (slot.kind === "fileset") {
    return (
      <div className="flex-1 overflow-hidden p-4">
        {client?.finalized ? (
          <WireframeViewer />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-neutral-600">
            {slot.emptyMessage ?? "Not generated yet."}
          </div>
        )}
      </div>
    );
  }

  // markdown
  const content =
    client?.payload.kind === "markdown" ? client.payload.content : "";
  return (
    <div className="flex-1 overflow-y-auto px-6 py-5">
      {content.length > 0 ? (
        <Markdown>{content}</Markdown>
      ) : (
        <div className="text-sm text-neutral-600">
          {slot.emptyMessage ?? "Not generated yet."}
        </div>
      )}
    </div>
  );
}

function DocumentTabs({
  activeTab,
  onSelect,
}: {
  activeTab: string | null;
  onSelect: (id: string | null) => void;
}) {
  const slots = useDocumentStore((s) => s.slots);
  const visible = VISIBLE_SLOTS.filter((slot) => {
    const client = slots[String(slot.id)];
    if (!client) return false;
    if (slot.kind === "fileset") return client.finalized;
    if (slot.kind === "markdown") {
      return (
        client.payload.kind === "markdown" &&
        client.payload.content.length > 0
      );
    }
    return false;
  });
  if (visible.length <= 1) return null;

  return (
    <div className="mt-3 flex gap-1 border-b border-neutral-800 -mb-3">
      {visible.map((slot) => {
        const id = String(slot.id);
        const isActive = activeTab === id;
        const version = slots[id]?.payload.version ?? 0;
        return (
          <button
            key={id}
            onClick={() => onSelect(id)}
            className={`px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition ${
              isActive
                ? "border-blue-500 text-neutral-100"
                : "border-transparent text-neutral-500 hover:text-neutral-300"
            }`}
          >
            {slot.label}
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
