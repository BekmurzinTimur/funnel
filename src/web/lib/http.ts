import type { ApiError } from '@shared/api';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    const message =
      typeof body === 'object' && body !== null && 'message' in body ? String((body as { message: unknown }).message) : `HTTP ${status}`;
    super(message);
  }
}

/** Same-origin JSON request. Sends a JSON body only when one is given. */
export async function requestJson<T>(
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const response = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) throw new HttpError(response.status, data);
  return data as T;
}

export const authHeaders = (token: string) => ({ authorization: `Bearer ${token}` });

/** Sends text exactly as typed, so the server stores the config verbatim. */
export async function requestText(
  method: 'GET' | 'POST',
  url: string,
  token: string,
  body?: string,
): Promise<{ text: string; data: unknown }> {
  const response = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? authHeaders(token) : { ...authHeaders(token), 'content-type': 'application/json' },
    body,
  });
  const text = await response.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // not JSON; keep the text
  }
  if (!response.ok) throw new HttpError(response.status, data);
  return { text, data };
}

export const errorBody = (err: unknown): Partial<ApiError> =>
  err instanceof HttpError && typeof err.body === 'object' && err.body !== null ? (err.body as Partial<ApiError>) : {};

/**
 * Human-readable message for a failed request. 401 only ever comes from
 * /api/admin/*, so naming the token there is always correct.
 */
export function describeError(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.status === 401) return 'The admin token was rejected.';
    return errorBody(err).message ?? errorBody(err).error ?? `Request failed (HTTP ${err.status}).`;
  }
  return err instanceof Error ? err.message : String(err);
}
