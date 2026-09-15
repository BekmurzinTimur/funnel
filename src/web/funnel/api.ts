// HTTP calls for the funnel, built strictly against @shared/api (type-only imports keep zod out of the bundle).
import type { AnswerBody, BackBody, NavigationResponse, SessionResponse } from '@shared/api';
import type { AnswerValue } from '@shared/types';
import { requestJson } from '../lib/http';

/** Create or resume. `search` is a query string such as `?variant=B&utm_source=x` (or ''). No body is sent. */
export function createSession(search: string): Promise<SessionResponse> {
  return requestJson<SessionResponse>('POST', `/api/session${search}`);
}

/** `value` is omitted for info and unknown step types. */
export function postAnswer(stepId: string, value?: AnswerValue): Promise<NavigationResponse> {
  const body: AnswerBody = value === undefined ? { stepId } : { stepId, value };
  return requestJson<NavigationResponse>('POST', '/api/session/answer', body);
}

export function postBack(stepId: string): Promise<NavigationResponse> {
  const body: BackBody = { stepId };
  return requestJson<NavigationResponse>('POST', '/api/session/back', body);
}

export const currentSearch = (): string => window.location.search;

/** Current query params plus `reset=1`, so Start over keeps utm_* and a `variant` override consistent with a refresh. */
export function startOverSearch(): string {
  const params = new URLSearchParams(window.location.search);
  params.set('reset', '1');
  return `?${params.toString()}`;
}

/** Drop `reset` from the address bar so a refresh resumes instead of resetting again. */
export function removeResetParam(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('reset')) return;
  url.searchParams.delete('reset');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}
