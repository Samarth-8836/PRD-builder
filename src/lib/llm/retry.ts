export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
}

const DEFAULTS: Required<Omit<RetryOptions, "signal">> = {
  maxAttempts: 6,
  baseDelayMs: 500,
  maxDelayMs: 60_000,
};

export class RetryableHttpError extends Error {
  /** Optional retry hint from the server (Retry-After in seconds, parsed
   *  from either the header or a textual hint in the body like "try again
   *  in 7.6s"). The retry helper will wait at least this long before the
   *  next attempt. */
  retryAfterMs?: number;

  constructor(public status: number, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "RetryableHttpError";
    this.retryAfterMs = retryAfterMs;
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/**
 * Parses Retry-After hints from either the response header or common
 * textual patterns provider error bodies use ("try again in 7.6s",
 * "retry after 10 seconds"). Returns ms or undefined.
 */
export function parseRetryAfter(headerValue: string | null, body?: string): number | undefined {
  if (headerValue) {
    const seconds = Number(headerValue);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(headerValue);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  if (body) {
    const m = body.match(/(?:try\s*again|retry)\s+(?:after\s+|in\s+)?(\d+(?:\.\d+)?)\s*(s|sec|seconds?|ms|millis(?:econds?)?)/i);
    if (m) {
      const value = Number(m[1]);
      const unit = m[2]!.toLowerCase();
      if (Number.isFinite(value)) {
        return unit.startsWith("ms") || unit.startsWith("milli") ? value : value * 1000;
      }
    }
  }
  return undefined;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Runs `fn` with exponential backoff on retryable errors (network failures,
 * 408/429/5xx). Honors `RetryableHttpError.retryAfterMs` when present
 * (typically populated for 429 from Retry-After or provider hints). Non-
 * retryable errors propagate immediately.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs } = { ...DEFAULTS, ...opts };
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable =
        err instanceof RetryableHttpError ||
        (err instanceof TypeError && /fetch|network/i.test(err.message));
      if (!retryable || attempt === maxAttempts) throw err;

      const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const hint = err instanceof RetryableHttpError ? err.retryAfterMs ?? 0 : 0;
      // Use whichever is larger: the server's hint or our exponential
      // backoff. Add a small jitter to spread retries from concurrent
      // callers.
      const wait = Math.max(exponential, hint) + Math.floor(Math.random() * 250);
      await delay(Math.min(wait, maxDelayMs * 2), opts.signal);
    }
  }
  throw lastErr;
}
