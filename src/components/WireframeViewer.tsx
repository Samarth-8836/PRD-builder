"use client";

import { tryGetPipeline } from "@/lib/pipeline/configs";
import { useDocumentStore } from "@/stores/document";
import { useSessionStore } from "@/stores/session";

/**
 * Sandboxed iframe that loads the generated wireframe artifact from
 * /api/wireframe/{sessionId}/index.html. PRD-pipeline-only — only the
 * PRD pipeline produces a `fileset` slot with browseable HTML. Other
 * pipelines render their final artifact via the markdown viewer. The
 * caller (DocumentPanel) gates on `slot.kind === "fileset"` before
 * mounting this component.
 *
 * The iframe is keyed on sessionId + slot version, so a new generation
 * forces a fresh iframe (avoiding any cached state).
 */
export function WireframeViewer() {
  const session = useSessionStore((s) => s.current);
  const sessionId = session?.id;
  const pipeline = tryGetPipeline(session?.pipelineId);
  // Find the first fileset slot in the pipeline. PRD has exactly one
  // (wireframeFiles); other pipelines may have none, in which case this
  // component renders nothing useful.
  const filesetSlotId = pipeline?.slots.find((s) => s.kind === "fileset")?.id;
  const slot = useDocumentStore((s) =>
    filesetSlotId ? s.slots[String(filesetSlotId)] : undefined
  );

  const ready =
    Boolean(slot?.finalized) && slot?.payload.kind === "fileset";

  if (!sessionId || !filesetSlotId || !ready) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-neutral-600">
        The wireframe will appear here once Stage 2 finishes generating it.
      </div>
    );
  }

  const version = slot!.payload.version;
  const src = `/api/wireframe/${sessionId}/index.html?v=${version}`;
  const iframeKey = `${sessionId}:${version}`;

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between text-[11px] uppercase tracking-wider text-neutral-500">
        <span>Wireframe v{version}</span>
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          className="text-neutral-400 hover:text-neutral-200"
        >
          Open in new tab ↗
        </a>
      </div>
      <iframe
        key={iframeKey}
        src={src}
        sandbox="allow-scripts"
        title="Wireframe preview"
        className="h-full w-full flex-1 rounded-md border border-neutral-800 bg-white"
      />
    </div>
  );
}
