export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value });
export const fail = <T = never>(error: string): ParseResult<T> => ({ ok: false, error });
