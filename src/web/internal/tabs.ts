// URL state for the internal console. Everything lives in the query string:
// `tab` picks the section, the FILTER_KEYS scope the analytics behind it.

export const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'experiment', label: 'Experiment' },
  { id: 'versions', label: 'Versions' },
  { id: 'events', label: 'Events' },
] as const;

export type TabId = (typeof TABS)[number]['id'];

export const DEFAULT_TAB: TabId = 'overview';

/** Analytics filters. These are the only params `/api/analytics` accepts (SPEC §7). */
export const FILTER_KEYS = ['version', 'variant', 'utm_campaign'] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];

const isTabId = (value: string): value is TabId => TABS.some((t) => t.id === value);

/** Missing or unrecognised `tab` resolves to Overview -- never a blank page. */
export function parseTab(params: URLSearchParams): TabId {
  const raw = params.get('tab');
  return raw !== null && isTabId(raw) ? raw : DEFAULT_TAB;
}

/**
 * Merge a patch into the current params, preserving everything else. Every
 * write goes through here: a filter change must keep `tab`, and a tab change
 * must keep the filters.
 */
export function withParams(params: URLSearchParams, patch: Record<string, string>): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const [key, value] of Object.entries(patch)) {
    if (value === '') next.delete(key);
    else next.set(key, value);
  }
  // Overview is the default, so it stays out of the URL and `/dashboard` remains canonical.
  if (next.get('tab') === DEFAULT_TAB) next.delete('tab');
  return next;
}

/**
 * Just the analytics filters, in a stable key order. The fetch effect keys on
 * this string, so switching tabs must not refire the request.
 */
export function filterQuery(params: URLSearchParams): string {
  const query = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = params.get(key);
    if (value) query.set(key, value);
  }
  return query.toString();
}
