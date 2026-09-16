import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { AnalyticsResponse } from '@shared/api';
import { describeError, requestJson } from '../lib/http';
import { filterQuery, withParams, type FilterKey } from './tabs';

export interface Analytics {
  data: AnalyticsResponse | null;
  error: string | null;
  loading: boolean;
  /** Filters as they appear in the URL -- the source of truth while a request is in flight. */
  filters: URLSearchParams;
  setFilter: (key: FilterKey, value: string) => void;
  clearFilters: () => void;
}

export function useAnalytics(): Analytics {
  const [params, setParams] = useSearchParams();
  // Only the analytics filters key the fetch, so switching tabs never refetches.
  const queryString = filterQuery(params);

  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    requestJson<AnalyticsResponse>('GET', `/api/analytics${queryString ? `?${queryString}` : ''}`)
      .then((body) => {
        if (!cancelled) setData(body);
      })
      .catch((err) => {
        if (!cancelled) setError(describeError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [queryString]);

  function setFilter(key: FilterKey, value: string): void {
    // withParams keeps `tab`; rebuilding from queryString alone would drop it.
    const patch: Record<string, string> = { [key]: value };
    if (key === 'version') patch.variant = ''; // variant keys belong to a version
    setParams(withParams(params, patch));
  }

  function clearFilters(): void {
    setParams(withParams(params, { version: '', variant: '', utm_campaign: '' }));
  }

  return { data, error, loading, filters: new URLSearchParams(queryString), setFilter, clearFilters };
}
