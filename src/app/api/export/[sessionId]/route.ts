import { NextRequest } from "next/server";
import { getStorage } from "@/lib/storage";
import { buildZip, type ZipEntry } from "@/lib/zip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ sessionId: string }>;
}

/**
 * GET /api/export/[sessionId]
 *
 * Bundles whatever artifacts the session has produced so far into a ZIP:
 *   project-contract.md
 *   workflow-map.md          (when present)
 *   screen-inventory.md      (when present)
 *   wireframe/index.html     (when wireframe exists)
 *   wireframe/data.js
 *   wireframe/<screen>.html  (one per screen)
 *
 * Available at any phase from phase1 onward — the user can take a partial
 * snapshot if they want.
 */
export async function GET(_req: NextRequest, ctx: RouteParams) {
  const { sessionId } = await ctx.params;
  if (!sessionId) {
    return new Response("Missing sessionId", { status: 400 });
  }

  const session = await getStorage().getSession(sessionId);
  if (!session) {
    return new Response("Session not found", { status: 404 });
  }
  const contract = session.documents.projectContract;
  if (!contract) {
    return new Response("Session has no contract to export yet", {
      status: 409,
    });
  }

  const entries: ZipEntry[] = [
    { path: "project-contract.md", content: contract.content },
  ];
  if (session.documents.workflowMap) {
    entries.push({
      path: "workflow-map.md",
      content: session.documents.workflowMap.content,
    });
  }
  if (session.documents.screenInventory) {
    entries.push({
      path: "screen-inventory.md",
      content: session.documents.screenInventory.content,
    });
  }
  if (session.wireframe) {
    for (const [name, content] of Object.entries(session.wireframe.files)) {
      entries.push({ path: `wireframe/${name}`, content });
    }
  }

  const zip = buildZip(entries);
  // Copy into a plain ArrayBuffer to satisfy DOM's BodyInit — the Node
  // Buffer's <ArrayBufferLike> generic doesn't reduce to <ArrayBuffer>
  // under strict mode.
  const ab = new ArrayBuffer(zip.byteLength);
  new Uint8Array(ab).set(zip);
  const filename = `${slugify(session.title)}-${shortId(sessionId)}.zip`;
  return new Response(ab, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(ab.byteLength),
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "prd-builder"
  );
}

function shortId(id: string): string {
  return id.split("-")[0]!.slice(0, 8);
}
