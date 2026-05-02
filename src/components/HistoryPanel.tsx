"use client";

import { useEffect, useState } from "react";
import type {
  ChangeLogEntry,
  DiffSummary,
} from "@/lib/pipeline/types";
import type { Session } from "@/lib/storage";
import { useSessionStore } from "@/stores/session";

interface HistoryPanelProps {
  open: boolean;
  onClose: () => void;
}

interface HistoryData {
  changeLog: ChangeLogEntry[];
  changeLogSummary?: string;
  pipelineVersion: number;
}

/**
 * Side-drawer history of confirmed Phase-2 changes. Loads the session
 * JSON from `/api/sessions/[id]` on every open + Refresh click — no
 * persistent subscription. The diff summaries are generated post-hoc
 * fire-and-forget on the server, so a freshly-confirmed cascade may
 * show "(summary pending)" for a few seconds. Click Refresh to re-fetch.
 */
export function HistoryPanel({ open, onClose }: HistoryPanelProps) {
  const sessionId = useSessionStore((s) => s.current?.id);
  const [data, setData] = useState<HistoryData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(): Promise<void> {
    if (!sessionId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}`);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const body = (await res.json()) as { session: Session };
      setData({
        changeLog: body.session.changeLog ?? [],
        changeLogSummary: body.session.changeLogSummary,
        pipelineVersion: body.session.pipelineVersion ?? 1,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open && sessionId) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sessionId]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog">
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        aria-hidden
      />
      <aside className="relative z-10 flex h-full w-full max-w-md flex-col border-l border-neutral-800 bg-neutral-950 text-neutral-100 shadow-2xl">
        <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
          <div>
            <div className="text-xs uppercase tracking-wider text-neutral-500">
              History
            </div>
            <div className="text-sm font-semibold">
              {data ? `${data.changeLog.length} confirmed change${data.changeLog.length === 1 ? "" : "s"}` : "Loading…"}
              {data && data.pipelineVersion > 1 && (
                <span className="ml-2 rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-[10px] text-neutral-300">
                  v{data.pipelineVersion}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void load()}
              disabled={loading}
              className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
            >
              {loading ? "Loading…" : "Refresh"}
            </button>
            <button
              onClick={onClose}
              className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
              aria-label="Close history"
            >
              ✕
            </button>
          </div>
        </header>
        <div className="flex-1 overflow-y-auto p-4">
          {error && (
            <div className="rounded-md border border-red-700 bg-red-900/30 px-3 py-2 text-sm text-red-100">
              {error}
            </div>
          )}
          {!error && data && data.changeLog.length === 0 && !data.changeLogSummary && (
            <div className="text-sm text-neutral-500">
              No confirmed changes yet. Once you confirm a change request,
              it will appear here with a per-slot summary.
            </div>
          )}
          {!error && data?.changeLogSummary && (
            <section className="mb-4 rounded-md border border-neutral-800 bg-neutral-900/50 px-3 py-2 text-xs text-neutral-300">
              <div className="mb-1 uppercase tracking-wider text-neutral-500">
                Earlier changes (summarized)
              </div>
              <div className="whitespace-pre-wrap">
                {data.changeLogSummary}
              </div>
            </section>
          )}
          {!error && data && (
            <ul className="flex flex-col gap-3">
              {[...data.changeLog].reverse().map((entry, i) => (
                <HistoryEntry key={`${entry.ts}-${i}`} entry={entry} />
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}

function HistoryEntry({ entry }: { entry: ChangeLogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const ts = formatTs(entry.ts);
  const diffs = entry.diffSummaries ?? [];

  return (
    <li className="rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm">
      <div className="flex items-baseline justify-between gap-2">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex-1 text-left"
          aria-expanded={expanded}
        >
          <div className="text-neutral-100">{entry.summary}</div>
          <div className="mt-0.5 text-[11px] text-neutral-500">
            {ts} · first impact: {entry.firstImpactStepId}
            {entry.firstImpactItemId ? `:${entry.firstImpactItemId}` : ""}
            {diffs.length > 0
              ? ` · ${diffs.length} slot${diffs.length === 1 ? "" : "s"} changed`
              : " · summaries pending"}
          </div>
        </button>
        <span className="text-neutral-600 text-xs">
          {expanded ? "▾" : "▸"}
        </span>
      </div>
      {expanded && (
        <div className="mt-2 border-t border-neutral-800 pt-2">
          <div className="text-xs text-neutral-400">{entry.description}</div>
          {diffs.length > 0 ? (
            <ul className="mt-2 space-y-2">
              {diffs.map((d) => (
                <DiffRow key={d.slotId + d.ts} diff={d} />
              ))}
            </ul>
          ) : (
            <div className="mt-2 text-xs italic text-neutral-500">
              Per-slot summaries are still being generated. Click Refresh
              in a moment to fetch them.
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function DiffRow({ diff }: { diff: DiffSummary }) {
  return (
    <li className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-neutral-500">
        {diff.slotLabel}
      </div>
      <div className="mt-0.5 text-xs text-neutral-200">{diff.summary}</div>
    </li>
  );
}

function formatTs(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleString();
  } catch {
    return ts;
  }
}
