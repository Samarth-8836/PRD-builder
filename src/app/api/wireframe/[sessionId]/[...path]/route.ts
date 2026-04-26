import { NextRequest } from "next/server";
import { getStorage } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ sessionId: string; path: string[] }>;
}

/**
 * Serves files from a session's wireframe artifact. Used as the iframe
 * src target for the Wireframe tab. Files live in storage as a flat map
 * (filename -> UTF-8 content) and are looked up by name.
 *
 * The iframe runs with `sandbox="allow-scripts"` (no allow-same-origin),
 * so cross-origin restrictions don't matter for this responder — we just
 * return the bytes with a sensible Content-Type.
 */
export async function GET(_req: NextRequest, ctx: RouteParams) {
  const { sessionId, path } = await ctx.params;
  if (!sessionId) {
    return new Response("Missing sessionId", { status: 400 });
  }
  if (!path || path.length === 0) {
    return new Response("Missing path", { status: 400 });
  }

  const filename = path.join("/");
  if (filename.includes("..") || filename.startsWith("/")) {
    return new Response("Invalid path", { status: 400 });
  }

  const session = await getStorage().getSession(sessionId);
  if (!session) {
    return new Response("Session not found", { status: 404 });
  }
  const wireframe = session.wireframe;
  if (!wireframe) {
    return new Response("Wireframe not generated yet", { status: 404 });
  }

  const content = wireframe.files[filename];
  if (content === undefined) {
    return new Response(`File not found: ${filename}`, { status: 404 });
  }

  return new Response(content, {
    status: 200,
    headers: {
      "Content-Type": contentTypeFor(filename),
      // Always serve fresh — version bumps on regeneration and the iframe
      // reload key in the viewer assumes no caching.
      "Cache-Control": "no-store",
      // Prevent MIME sniffing.
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function contentTypeFor(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".htm")) {
    return "text/html; charset=utf-8";
  }
  if (lower.endsWith(".js") || lower.endsWith(".mjs")) {
    return "application/javascript; charset=utf-8";
  }
  if (lower.endsWith(".css")) return "text/css; charset=utf-8";
  if (lower.endsWith(".json")) return "application/json; charset=utf-8";
  return "text/plain; charset=utf-8";
}
