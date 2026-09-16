import type { AnalyticsResponse } from '@shared/api';
import { ChartFrame, SeriesBars, type BarDatum } from '../charts';
import { pct } from '../format';
import { Pill, Ratio, SectionCard, TokenForm } from '../parts';
import type { AdminToken } from '../useAdminToken';
import VersionAdmin from './VersionAdmin';

/**
 * Versions: the publish/check/rollback loop in one place.
 *
 * The top half is public analytics; the bottom half needs the admin token. The
 * gate controls ONLY what is mounted below the divider, so an anonymous visitor
 * still sees every number and issues no /api/admin request at all.
 */
export default function VersionsTab({
  data,
  error,
  admin,
}: {
  data: AnalyticsResponse | null;
  error: string | null;
  admin: AdminToken;
}) {
  return (
    <div className="stack">
      <p className="eyebrow">Public analytics</p>
      {error ? (
        <div className="card notice" role="alert">
          <p className="error">Could not load analytics: {error}</p>
        </div>
      ) : data === null || data.meta.funnelId === null ? (
        <div className="card notice">
          <p>No funnel versions are stored yet.</p>
          <p className="muted">Publish a config below to get started.</p>
        </div>
      ) : (
        <VersionAnalytics data={data} />
      )}

      <hr className="gate-divider" />

      <p className="eyebrow">
        Requires admin token
        {admin.token === '' && <Pill kind="neutral">locked</Pill>}
      </p>
      {admin.token === '' ? (
        <SectionCard
          title="Manage versions"
          subtitle="Publishing, activating and rollback need the admin token. Analytics above need none."
        >
          <TokenForm token={admin.token} onSave={admin.setToken} onClear={admin.clearToken} />
        </SectionCard>
      ) : (
        <VersionAdmin admin={admin} />
      )}
    </div>
  );
}

function VersionAnalytics({ data }: { data: AnalyticsResponse }) {
  const { versions, stepConversion } = data.versionComparison;
  const scope = [
    data.filters.variant && `variant ${data.filters.variant}`,
    data.filters.utm_campaign && `campaign ${data.filters.utm_campaign}`,
  ]
    .filter(Boolean)
    .join(' · ');

  // One series -- versions are not the A/B variants, so never the two-hue pair.
  const bars: BarDatum[] = versions.map((v) => ({
    id: String(v.version),
    label: `v${v.version}`,
    rate: v.conversion,
    valueLabel: pct(v.conversion),
    slot: 1,
  }));
  const peak = Math.max(...bars.map((b) => b.rate ?? 0), 0.01);
  const max = Math.min(1, Math.ceil(peak * 10) / 10);

  return (
    <>
      <SectionCard
        title="Version comparison"
        subtitle={`${scope ? `Filtered to ${scope}. ` : ''}Forced sessions included.`}
      >
        {bars.length > 0 && (
          <ChartFrame caption="End-to-end conversion by version">
            <SeriesBars data={bars} max={max} />
          </ChartFrame>
        )}
        <div className="table-scroll">
          <table className="data-table">
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
                    {v.version === data.meta.activeVersion && <Pill>active</Pill>}
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
      </SectionCard>

      {stepConversion.map((matrix) => (
        <SectionCard
          key={matrix.variant}
          title={`Step conversion × version · variant ${matrix.variant}`}
          subtitle={
            <>
              Converted ÷ eligible within that version and variant. Because conversion is edge-based the rates sit near
              100% — read the <strong>counts</strong> for volume and the <strong>n/a</strong> cells for shape: n/a means
              the step is not in that version&apos;s sequence for this variant.
            </>
          }
        >
          <div className="table-scroll">
            <table className="data-table">
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
        </SectionCard>
      ))}
    </>
  );
}
