import { NextRequest } from "next/server";
import { getSessionManager } from "@/lib/session-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await getSessionManager().getSession(id);
  if (!session) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }
  return Response.json({ session });
}
