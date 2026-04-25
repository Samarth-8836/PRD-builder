import type { StreamEvent } from "./types";

/**
 * Server-side writer that emits typed events as Server-Sent Events.
 *
 * Wire format: each event is a single line `data: <json>\n\n`. The `event:`
 * field is omitted — the JSON payload carries `type` so a single handler can
 * dispatch on the client. `complete` events are followed by stream close.
 */
export class SSEWriter {
  private readonly encoder = new TextEncoder();
  private closed = false;

  constructor(private readonly controller: ReadableStreamDefaultController<Uint8Array>) {}

  send(event: StreamEvent): void {
    if (this.closed) return;
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    this.controller.enqueue(this.encoder.encode(payload));
  }

  error(message: string, code?: string): void {
    this.send({ type: "error", message, code });
  }

  complete(): void {
    if (this.closed) return;
    this.send({ type: "complete" });
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.controller.close();
    } catch {
      // already closed by the runtime; ignore.
    }
  }

  isClosed(): boolean {
    return this.closed;
  }
}

export function makeSSEResponse(
  start: (writer: SSEWriter) => Promise<void> | void
): Response {
  let writer: SSEWriter;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      writer = new SSEWriter(controller);
      Promise.resolve(start(writer)).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        writer.error(message);
        writer.complete();
      });
    },
    cancel() {
      writer?.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
