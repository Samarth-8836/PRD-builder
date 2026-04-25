import { NextRequest } from "next/server";
import { makeSSEResponse } from "@/lib/streaming";
import {
  NotImplementedInM1Error,
  SessionBusyError,
  getSessionManager,
} from "@/lib/session-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ChatRequestBody {
  sessionId?: string;
  message?: string;
}

export async function POST(req: NextRequest) {
  let body: ChatRequestBody;
  try {
    body = (await req.json()) as ChatRequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const message = (body.message ?? "").trim();
  if (!message) {
    return Response.json({ error: "message is required" }, { status: 400 });
  }

  const manager = getSessionManager();

  return makeSSEResponse(async (sse) => {
    try {
      if (!body.sessionId) {
        await manager.startSession({
          firstMessage: message,
          sse,
          signal: req.signal,
        });
      } else {
        await manager.handleMessage({
          sessionId: body.sessionId,
          message,
          sse,
          signal: req.signal,
        });
      }
    } catch (err: unknown) {
      if (err instanceof SessionBusyError) {
        sse.error(err.message, err.code);
      } else if (err instanceof NotImplementedInM1Error) {
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
