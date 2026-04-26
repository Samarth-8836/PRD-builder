import { NextRequest } from "next/server";
import { makeSSEResponse } from "@/lib/streaming";
import {
  NoContractError,
  SessionBusyError,
  getSessionManager,
} from "@/lib/session-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PhaseCompleteRequestBody {
  sessionId?: string;
}

export async function POST(req: NextRequest) {
  let body: PhaseCompleteRequestBody;
  try {
    body = (await req.json()) as PhaseCompleteRequestBody;
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
      await manager.completePhase1({ sessionId, sse, signal: req.signal });
    } catch (err: unknown) {
      if (err instanceof SessionBusyError) {
        sse.error(err.message, err.code);
      } else if (err instanceof NoContractError) {
        sse.error(err.message, err.code);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        sse.error(msg);
      }
    } finally {
      sse.complete();
    }
  });
}
