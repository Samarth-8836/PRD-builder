import { NextRequest } from "next/server";
import { getPipeline } from "@/lib/pipeline/configs";
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
 * Bundles whatever artifacts the session has produced so far into a ZIP.
 * Iterates over `PipelineConfig.slots` so the archive's contents track
 * the active pipeline's slot definitions automatically.
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
  const pipeline = getPipeline(session.pipelineId);
  const anchor = session.slots[pipeline.driftAnchor];
  if (!anchor || anchor.kind !== "markdown") {
    return new Response(
      `Session has no ${pipeline.slots.find((s) => s.id === pipeline.driftAnchor)?.label ?? "anchor"} to export yet`,
      { status: 409 }
    );
  }

  const entries: ZipEntry[] = [];
  for (const slot of pipeline.slots) {
    const payload = session.slots[String(slot.id)];
    if (!payload) continue;
    if (payload.kind === "markdown") {
      entries.push({
        path: slot.fileBaseName ?? `${String(slot.id)}.md`,
        content: payload.content,
      });
    } else if (payload.kind === "fileset") {
      // Fileset slots: emit each file under a folder named after the slot
      // (or using the fileBaseName as a directory hint).
      const folder = slot.fileBaseName?.includes("/")
        ? slot.fileBaseName.split("/")[0]
        : String(slot.id);
      for (const [name, content] of Object.entries(payload.files)) {
        entries.push({ path: `${folder}/${name}`, content });
      }
    }
    // JSON slots are internal — typically bundled into fileset slots
    // (e.g., PRD's wireframeData → wireframe/data.js).
  }

  const zip = buildZip(entries);
  // Copy into a plain ArrayBuffer to satisfy DOM's BodyInit — the Node
  // Buffer's <ArrayBufferLike> generic doesn't reduce to <ArrayBuffer>
  // under strict mode.
  const ab = new ArrayBuffer(zip.byteLength);
  new Uint8Array(ab).set(zip);
  const versionSuffix =
    session.pipelineVersion && session.pipelineVersion > 1
      ? `-v${session.pipelineVersion}`
      : "";
  const filename = `${slugify(session.title)}-${shortId(sessionId)}${versionSuffix}.zip`;
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
      .slice(0, 50) || "export"
  );
}

function shortId(id: string): string {
  return id.split("-")[0]!.slice(0, 8);
}
