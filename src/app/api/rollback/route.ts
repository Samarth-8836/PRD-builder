import { NextRequest } from "next/server";
import { makeSSEResponse } from "@/lib/streaming";
import {
  SessionBusyError,
  WrongPhaseError,
  getSessionManager,
} from "@/lib/session-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RollbackBody {
  sessionId?: string;
}

export async function POST(req: NextRequest) {
  let body: RollbackBody;
  try {
    body = (await req.json()) as RollbackBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.sessionId) {
    return Response.json({ error: "sessionId is required" }, { status: 400 });
  }
  const sessionId = body.sessionId;

  const manager = getSessionManager();

  return makeSSEResponse(async (sse) => {
    try {
      await manager.rollbackToPhase1({ sessionId, sse, signal: req.signal });
    } catch (err: unknown) {
      if (err instanceof SessionBusyError) sse.error(err.message, err.code);
      else if (err instanceof WrongPhaseError) sse.error(err.message, err.code);
      else sse.error(err instanceof Error ? err.message : String(err));
    } finally {
      sse.complete();
    }
  });
}
