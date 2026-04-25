import { getSessionManager } from "@/lib/session-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const sessions = await getSessionManager().listSessions();
  return Response.json({ sessions });
}
