import { NextRequest } from "next/server";
import { streamCompletion } from "@/lib/llm/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Smoke test for Module 1 (LLM Provider).
 *
 * GET /api/test-llm?q=say%20hello
 *
 * Streams the model response back as text/event-stream events:
 *   data: {"delta":"hi"}
 *   data: {"delta":" there"}
 *   data: [DONE]
 */
export async function GET(req: NextRequest) {
  const query = req.nextUrl.searchParams.get("q") ?? "Say hello in one short sentence.";
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: object | "[DONE]") => {
        const data = payload === "[DONE]" ? "[DONE]" : JSON.stringify(payload);
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      };

      try {
        for await (const chunk of streamCompletion({
          messages: [
            { role: "system", content: "You are a concise assistant." },
            { role: "user", content: query },
          ],
        })) {
          send({ delta: chunk.delta });
        }
        send("[DONE]");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send({ error: message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
