import { Link, useSearchParams } from 'react-router-dom';
import type { AnalyticsResponse } from '@shared/api';
import InternalHeader from './InternalHeader';
import { count, pct } from './format';
import { StatTile } from './parts';
import { FILTER_KEYS, parseTab, TABS, withParams, type FilterKey, type TabId } from './tabs';
import { useAnalytics } from './useAnalytics';
import EventsTab from './tabs/EventsTab';
import ExperimentTab from './tabs/ExperimentTab';
import OverviewTab from './tabs/OverviewTab';
import VersionsTab from './tabs/VersionsTab';
import './internal.css';

/*
 * The internal console: one page, four tabs, one filter scope.
 *
 * The shell owns all remote state and renders the header, filters and tab bar
 * UNCONDITIONALLY. Loading, empty and error states belong inside each tab --
 * gating the shell on analytics would make the publish form unreachable on an
 * empty database, so the first config could never be published.
 */
export default function InternalPage() {
  const [params, setParams] = useSearchParams();
  const tab = parseTab(params);
  const { data, error, loading, filters, setFilter, clearFilters } = useAnalytics();

  return (
    <main className="page page-wide console">
      <InternalHeader />

      <FilterBar data={data} filters={filters} loading={loading} onChange={setFilter} />

      <KpiRow data={data} loading={loading} />

      <nav className="tabbar" aria-label="Console sections">
        {TABS.map((t) => (
          <Link
            key={t.id}
            to={{ search: `?${withParams(params, { tab: t.id }).toString()}` }}
            className={t.id === tab ? 'tab tab-active' : 'tab'}
            aria-current={t.id === tab ? 'page' : undefined}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      <div className="tab-panel">
        <TabBody tab={tab} data={data} error={error} loading={loading} onClearFilters={clearFilters} />
      </div>
    </main>
  );
}

function TabBody({
  tab,
  data,
  error,
  loading,
  onClearFilters,
}: {
  tab: TabId;
  data: AnalyticsResponse | null;
  error: string | null;
  loading: boolean;
  onClearFilters: () => void;
}) {
  // The Versions tab renders even with no analytics at all -- that is the only
  // route to publishing the first config on a fresh database.
  if (tab === 'versions') return <VersionsTab data={data} error={error} />;

  if (error) {
    return (
      <div className="card notice" role="alert">
        <p className="error">Could not load analytics: {error}</p>
        <button type="button" onClick={onClearFilters}>
          Clear filters
        </button>
      </div>
    );
  }
  if (data === null) return <p className="muted">{loading ? 'Loading analytics…' : 'No analytics available.'}</p>;
  if (data.meta.funnelId === null) {
    return (
      <div className="card notice">
        <p>No funnel versions are stored yet.</p>
        <p className="muted">Publish a config on the Versions tab to get started.</p>
      </div>
    );
  }

  switch (tab) {
    case 'overview':
      return <OverviewTab data={data} />;
    case 'experiment':
      return <ExperimentTab data={data} />;
    case 'events':
      return <EventsTab data={data} />;
  }
}

function FilterBar({
  data,
  filters,
  loading,
  onChange,
}: {
  data: AnalyticsResponse | null;
  filters: URLSearchParams;
  loading: boolean;
  onChange: (key: FilterKey, value: string) => void;
}) {
  const meta = data?.meta;
  // The URL is the source of truth while a request is in flight or after an error.
  const version = filters.get('version') ?? (data ? String(data.filters.version ?? '') : '');
  const variant = filters.get('variant') ?? '';
  const campaign = filters.get('utm_campaign') ?? '';
  const campaigns = meta?.campaigns ?? [];
  const campaignOptions = campaign && !campaigns.includes(campaign) ? [...campaigns, campaign] : campaigns;
  const variants = meta?.variants ?? [];
  const variantOptions = variant && !variants.includes(variant) ? [...variants, variant] : variants;

  return (
    <div className="filters card" role="search">
      <label>
        <span>Version</span>
        <select value={version} disabled={!meta} onChange={(e) => onChange(FILTER_KEYS[0], e.target.value)}>
          {!meta && <option value={version}>{version ? `v${version}` : '…'}</option>}
          {meta?.versions.map((v) => (
            <option key={v} value={String(v)}>
              v{v}
              {v === meta.activeVersion ? ' (active)' : ''}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Variant</span>
        <select value={variant} disabled={!meta} onChange={(e) => onChange(FILTER_KEYS[1], e.target.value)}>
          <option value="">All</option>
          {variantOptions.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>UTM campaign</span>
        <select value={campaign} disabled={!meta} onChange={(e) => onChange(FILTER_KEYS[2], e.target.value)}>
          <option value="">All</option>
          {campaignOptions.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
      <span className="muted filter-status" aria-live="polite">
        {loading && data ? 'Updating…' : ''}
      </span>
    </div>
  );
}

/** Headline metrics, always visible above the tabs. */
function KpiRow({ data, loading }: { data: AnalyticsResponse | null; loading: boolean }) {
  const m = data?.summary;
  const dash = loading ? '…' : '—';
  return (
    <section className="kpi-row" aria-label="Summary">
      <StatTile label="Started" value={m ? count(m.started) : dash} note="distinct sessions" />
      <StatTile
        label="Completed"
        value={m ? count(m.completed) : dash}
        note={m ? `${pct(m.completionRate)} of started` : undefined}
      />
      <StatTile
        label="CTA CTR"
        value={m ? pct(m.ctaCtr) : dash}
        note={m ? `${count(m.ctaClicked)}/${count(m.completed)} clicked ÷ completed` : undefined}
      />
      <StatTile
        label="End-to-end conversion"
        value={m ? pct(m.conversion) : dash}
        note={m ? `${count(m.ctaClicked)}/${count(m.started)} clicked ÷ started` : undefined}
      />
    </section>
  );
}
