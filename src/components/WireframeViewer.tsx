"use client";

import { PRD_SLOT_IDS } from "@/lib/pipeline/configs/prd-builder";
import { useDocumentStore } from "@/stores/document";
import { useSessionStore } from "@/stores/session";

/**
 * Sandboxed iframe that loads the generated wireframe artifact from
 * /api/wireframe/{sessionId}/index.html. The sandbox attribute is
 * intentionally `allow-scripts` only — no `allow-same-origin` — so
 * scripts inside the iframe can't reach back into the parent's origin.
 *
 * The iframe is keyed on sessionId + slot version, so a new generation
 * forces a fresh iframe (avoiding any cached state).
 */
export function WireframeViewer() {
  const sessionId = useSessionStore((s) => s.current?.id);
  const slot = useDocumentStore(
    (s) => s.slots[PRD_SLOT_IDS.wireframeFiles]
  );

  const ready =
    Boolean(slot?.finalized) && slot?.payload.kind === "fileset";

  if (!sessionId || !ready) {
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
