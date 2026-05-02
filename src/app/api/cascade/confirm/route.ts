import { NextRequest } from "next/server";
import { makeSSEResponse } from "@/lib/streaming";
import {
  NoPendingPreviewError,
  SessionBusyError,
  WrongPhaseError,
  getSessionManager,
} from "@/lib/session-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CascadeConfirmBody {
  sessionId?: string;
  action?: "confirm" | "cancel";
}

/**
 * POST /api/cascade/confirm — completes the cascade-preview gate.
 *
 *   action=confirm: Streams the cascade via SSE (same envelope as /api/chat).
 *   action=cancel:  Drops the in-memory pending preview, returns 204.
 *
 * The pending preview is keyed by sessionId; if there isn't one (TTL
 * expired, server restarted, never set), confirm fails with a clear
 * NO_PENDING_PREVIEW error.
 */
export async function POST(req: NextRequest) {
  let body: CascadeConfirmBody;
  try {
    body = (await req.json()) as CascadeConfirmBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.sessionId) {
    return Response.json({ error: "sessionId is required" }, { status: 400 });
  }
  const sessionId = body.sessionId;
  const action = body.action ?? "confirm";

  const manager = getSessionManager();

  if (action === "cancel") {
    manager.cancelCascade({ sessionId });
    return new Response(null, { status: 204 });
  }

  return makeSSEResponse(async (sse) => {
    try {
      await manager.confirmCascade({ sessionId, sse, signal: req.signal });
    } catch (err: unknown) {
      if (err instanceof SessionBusyError) sse.error(err.message, err.code);
      else if (err instanceof NoPendingPreviewError) sse.error(err.message, err.code);
      else if (err instanceof WrongPhaseError) sse.error(err.message, err.code);
      else sse.error(err instanceof Error ? err.message : String(err));
    } finally {
      sse.complete();
    }
  });
}
