import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { AnalyticsResponse, FunnelMetrics, StepRow } from '@shared/api';
import { HttpError, requestJson } from '../lib/http';
import InternalNav from '../lib/InternalNav';
import './dashboard.css';

// Track D — SPEC §7: analytics dashboard. Correct numbers first: every
// percentage is shown next to its absolute counts.

const FILTER_KEYS = ['version', 'variant', 'utm_campaign'] as const;

const pct = (rate: number | null): string => (rate === null ? '—' : `${(rate * 100).toFixed(1)}%`);

/** `62.5% (25/40)`, or `— (0/0)` when the denominator is zero. */
function Ratio({ rate, n, d }: { rate: number | null; n: number; d: number }) {
  return (
    <span className="ratio">
      {pct(rate)} <span className="muted">({n}/{d})</span>
    </span>
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof HttpError) {
    const body = err.body as { error?: string; message?: string } | null;
    return body?.message ?? body?.error ?? `HTTP ${err.status}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export default function DashboardPage() {
  const [params, setParams] = useSearchParams();
  const query = new URLSearchParams();
  for (const k of FILTER_KEYS) {
    const v = params.get(k);
    if (v) query.set(k, v);
  }
  const queryString = query.toString();

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
        if (!cancelled) setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [queryString]);

  function setFilter(key: (typeof FILTER_KEYS)[number], value: string) {
    const next = new URLSearchParams(queryString);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key === 'version') next.delete('variant'); // variant keys belong to a version
    setParams(next);
  }

  const empty = data !== null && data.summary.started === 0 && data.eventCounts.length === 0;

  return (
    <main className="page page-wide dashboard">
      <InternalNav />
      <h1>Funnel analytics</h1>

      <FilterBar data={data} params={query} loading={loading} onChange={setFilter} />

      {error && (
        <div className="card dash-notice" role="alert">
          <p className="error">Could not load analytics: {error}</p>
          <button type="button" onClick={() => setParams(new URLSearchParams())}>
            Clear filters
          </button>
        </div>
      )}

      {!error && data === null && <p className="muted">Loading analytics…</p>}

      {!error && data !== null && data.meta.funnelId === null && (
        <div className="card dash-notice">No funnel versions are stored yet.</div>
      )}

      {!error && data !== null && data.meta.funnelId !== null && (
        <>
          {empty ? (
            <div className="card dash-notice">
              <p>No sessions match these filters for v{data.filters.version}.</p>
              <p className="muted">
                Locally, run <code>npm run seed</code> against the dev server to generate traffic.
              </p>
            </div>
          ) : (
            <>
              <Summary metrics={data.summary} />
              <StepSection data={data} />
              <AbCard data={data} />
            </>
          )}
          <VersionComparison data={data} />
          {!empty && <EventCounts data={data} />}
        </>
      )}
    </main>
  );
}

function FilterBar({
  data,
  params,
  loading,
  onChange,
}: {
  data: AnalyticsResponse | null;
  params: URLSearchParams;
  loading: boolean;
  onChange: (key: (typeof FILTER_KEYS)[number], value: string) => void;
}) {
  const meta = data?.meta;
  const version = data ? String(data.filters.version ?? '') : (params.get('version') ?? '');
  const variant = params.get('variant') ?? '';
  const campaign = params.get('utm_campaign') ?? '';
  const campaigns = meta?.campaigns ?? [];
  const campaignOptions = campaign && !campaigns.includes(campaign) ? [...campaigns, campaign] : campaigns;
  const variants = meta?.variants ?? [];
  const variantOptions = variant && !variants.includes(variant) ? [...variants, variant] : variants;

  return (
    <div className="dash-filters card">
      <label>
        <span>Version</span>
        <select value={version} disabled={!meta} onChange={(e) => onChange('version', e.target.value)}>
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
        <select value={variant} disabled={!meta} onChange={(e) => onChange('variant', e.target.value)}>
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
        <select value={campaign} disabled={!meta} onChange={(e) => onChange('utm_campaign', e.target.value)}>
          <option value="">All</option>
          {campaignOptions.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
      <span className="muted dash-status" aria-live="polite">
        {loading && data ? 'Updating…' : ''}
      </span>
    </div>
  );
}

function Summary({ metrics }: { metrics: FunnelMetrics }) {
  return (
    <section className="dash-summary" aria-label="Summary">
      <div className="card stat">
        <div className="stat-label">Started</div>
        <div className="stat-value">{metrics.started}</div>
        <div className="muted">distinct sessions</div>
      </div>
      <div className="card stat">
        <div className="stat-label">Completed</div>
        <div className="stat-value">{metrics.completed}</div>
        <div>
          completion <Ratio rate={metrics.completionRate} n={metrics.completed} d={metrics.started} />
        </div>
      </div>
      <div className="card stat">
        <div className="stat-label">CTA CTR</div>
        <div className="stat-value">{pct(metrics.ctaCtr)}</div>
        <div className="muted">
          {metrics.ctaClicked}/{metrics.completed} clicked ÷ completed
        </div>
      </div>
      <div className="card stat">
        <div className="stat-label">End-to-end conversion</div>
        <div className="stat-value">{pct(metrics.conversion)}</div>
        <div className="muted">
          {metrics.ctaClicked}/{metrics.started} clicked ÷ started
        </div>
      </div>
    </section>
  );
}

function StepSection({ data }: { data: AnalyticsResponse }) {
  return (
    <section className="dash-section">
      <h2>Per-step funnel · v{data.filters.version}</h2>
      <StepChart data={data} />
      {data.steps.map((group) => (
        <div key={group.variant} className="dash-block">
          <h3>Variant {group.variant}</h3>
          <StepTable rows={group.rows} />
        </div>
      ))}
      <ol className="footnotes muted">
        <li>
          Conversion = Reached ∩ Eligible ÷ Eligible. It is edge-based: Eligible counts sessions whose{' '}
          <code>step_completed</code> routed them to this step (the entry step uses <code>session_started</code>), so a
          conditional step only counts sessions that were sent to it. <em>Reached − Converted</em> is a data-quality
          signal (views with no recorded incoming edge), not a conversion.
        </li>
        <li>
          Drop-off is per step, not a partition of abandoned sessions: a session that viewed a step, went back and
          abandoned elsewhere is counted at each step it never moved past, so the column can sum to more than the number
          of abandoned sessions.
        </li>
      </ol>
    </section>
  );
}

function StepTable({ rows }: { rows: StepRow[] }) {
  return (
    <div className="table-scroll">
      <table className="dash-table">
        <thead>
          <tr>
            <th>Step</th>
            <th>Type</th>
            <th className="num">Reached</th>
            <th className="num">Eligible</th>
            <th className="num">Converted</th>
            <th className="num">Conversion¹</th>
            <th className="num">Drop-off²</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.stepId}>
              <td>
                <code>{r.stepId}</code>
                {r.isEntry && <span className="tag">entry</span>}
              </td>
              <td className="muted">{r.type}</td>
              <td className="num">{r.reached}</td>
              <td className="num">{r.eligible}</td>
              <td className="num">{r.converted}</td>
              <td className="num">
                <Ratio rate={r.conversionRate} n={r.converted} d={r.eligible} />
              </td>
              <td className="num">
                {r.dropOff === null ? <span className="muted">—</span> : <Ratio rate={r.dropOffRate} n={r.dropOff} d={r.reached} />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Horizontal bars of per-step conversion (converted ÷ eligible), one small multiple per variant. */
function StepChart({ data }: { data: AnalyticsResponse }) {
  return (
    <figure className="card bar-chart">
      <figcaption>Step conversion (converted ÷ eligible)</figcaption>
      <div className="bar-groups">
        {data.steps.map((group) => (
          <div key={group.variant} className="bar-group">
            <div className="bar-group-title">Variant {group.variant}</div>
            {group.rows.map((r) => {
              const width = r.conversionRate === null ? 0 : Math.min(1, r.conversionRate) * 100;
              const label = `${pct(r.conversionRate)} (${r.converted}/${r.eligible})`;
              return (
                <div key={r.stepId} className="bar-row" title={`${group.variant} · ${r.stepId}: ${label}`}>
                  <span className="bar-label">{r.stepId}</span>
                  <span className="bar-track">
                    {width > 0 && <span className="bar-fill" style={{ width: `${width}%` }} />}
                  </span>
                  <span className="bar-value">{label}</span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </figure>
  );
}

function AbCard({ data }: { data: AnalyticsResponse }) {
  const { variants, zTest, experimentId } = data.abComparison;
  return (
    <section className="dash-section">
      <h2>A vs B · funnel level · v{data.filters.version}</h2>
      <div className="card">
        <p className="muted">
          Experiment <code>{experimentId ?? '—'}</code>
          {data.filters.utm_campaign ? ` · campaign ${data.filters.utm_campaign}` : ''} · variant filter ignored
        </p>
        <div className="table-scroll">
          <table className="dash-table">
            <thead>
              <tr>
                <th>Metric</th>
                {variants.map((v) => (
                  <th key={v.variant} className="num">
                    Variant {v.variant}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Started</td>
                {variants.map((v) => (
                  <td key={v.variant} className="num">
                    {v.started}
                  </td>
                ))}
              </tr>
              <tr>
                <td>Completion</td>
                {variants.map((v) => (
                  <td key={v.variant} className="num">
                    <Ratio rate={v.completionRate} n={v.completed} d={v.started} />
                  </td>
                ))}
              </tr>
              <tr>
                <td>CTA CTR</td>
                {variants.map((v) => (
                  <td key={v.variant} className="num">
                    <Ratio rate={v.ctaCtr} n={v.ctaClicked} d={v.completed} />
                  </td>
                ))}
              </tr>
              <tr>
                <td>
                  <strong>Conversion</strong> (primary)
                </td>
                {variants.map((v) => (
                  <td key={v.variant} className="num">
                    <Ratio rate={v.conversion} n={v.ctaClicked} d={v.started} />
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        <p className="ztest">
          Two-proportion z-test on <code>{zTest.metric}</code>
          {variants.length >= 2 ? ` (${variants[0].variant} vs ${variants[1].variant})` : ''}:{' '}
          {zTest.z === null || zTest.pValue === null ? (
            <span className="muted">not enough data</span>
          ) : (
            <>
              z = {zTest.z.toFixed(3)}, p = {zTest.pValue.toFixed(4)} —{' '}
              {zTest.significantAt95 ? (
                <strong className="sig">significant at 95%</strong>
              ) : (
                <span>not significant at 95%</span>
              )}
            </>
          )}
        </p>
        <p className="muted small">
          Forced (<code>?variant=</code>) sessions are excluded from this comparison; per-step comparison across variants
          is intentionally not shown because B reorders/removes steps.
        </p>
      </div>
    </section>
  );
}

function VersionComparison({ data }: { data: AnalyticsResponse }) {
  const { versions, stepConversion } = data.versionComparison;
  const scope = [data.filters.variant && `variant ${data.filters.variant}`, data.filters.utm_campaign && `campaign ${data.filters.utm_campaign}`]
    .filter(Boolean)
    .join(' · ');
  return (
    <section className="dash-section">
      <h2>Version comparison</h2>
      <p className="muted">{scope ? `Filtered to ${scope}. ` : ''}Forced sessions included.</p>
      <div className="table-scroll">
        <table className="dash-table">
          <thead>
            <tr>
              <th>Version</th>
              <th>Experiment</th>
              <th className="num">Started</th>
              <th className="num">Completion</th>
              <th className="num">CTA CTR</th>
              <th className="num">Conversion</th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.version}>
                <td>
                  v{v.version}
                  {v.version === data.meta.activeVersion && <span className="tag">active</span>}
                </td>
                <td>
                  <code>{v.experimentId}</code>
                </td>
                <td className="num">{v.started}</td>
                <td className="num">
                  <Ratio rate={v.completionRate} n={v.completed} d={v.started} />
                </td>
                <td className="num">
                  <Ratio rate={v.ctaCtr} n={v.ctaClicked} d={v.completed} />
                </td>
                <td className="num">
                  <Ratio rate={v.conversion} n={v.ctaClicked} d={v.started} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {stepConversion.map((matrix) => (
        <div key={matrix.variant} className="dash-block">
          <h3>Step conversion × version · variant {matrix.variant}</h3>
          <div className="table-scroll">
            <table className="dash-table">
              <thead>
                <tr>
                  <th>Step</th>
                  {matrix.rows.map((row) => (
                    <th key={row.version} className="num">
                      v{row.version}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrix.stepIds.map((stepId) => (
                  <tr key={stepId}>
                    <td>
                      <code>{stepId}</code>
                    </td>
                    {matrix.rows.map((row) => {
                      const cell = row.cells[stepId];
                      return (
                        <td key={row.version} className="num">
                          {cell ? (
                            <Ratio rate={cell.rate} n={cell.converted} d={cell.eligible} />
                          ) : (
                            <span className="muted" title="Step not in this version's sequence for this variant">
                              n/a
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      <p className="footnotes muted">
        Cells are converted ÷ eligible within that version and variant. <strong>n/a</strong> = the step is not in that
        version’s sequence for the variant.
      </p>
    </section>
  );
}

function EventCounts({ data }: { data: AnalyticsResponse }) {
  return (
    <section className="dash-section">
      <h2>Events · v{data.filters.version}</h2>
      <p className="muted">Distinct sessions per event name for the current filters. New event types appear here automatically.</p>
      <div className="table-scroll">
        <table className="dash-table dash-table-narrow">
          <thead>
            <tr>
              <th>Event</th>
              <th className="num">Sessions</th>
            </tr>
          </thead>
          <tbody>
            {data.eventCounts.map((e) => (
              <tr key={e.name}>
                <td>
                  <code>{e.name}</code>
                </td>
                <td className="num">{e.sessions}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
