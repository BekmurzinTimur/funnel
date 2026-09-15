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
