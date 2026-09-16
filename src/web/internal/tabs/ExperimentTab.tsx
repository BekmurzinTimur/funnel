import type { AnalyticsResponse } from '@shared/api';
import { ScaleNote, SeriesBars, ChartFrame, type BarDatum, type Series } from '../charts';
import { deltaPp, signedPp } from '../format';
import { EmptyNotice, Ratio, SectionCard } from '../parts';

/**
 * A vs B at funnel level. Two series, so the categorical slots apply: A is
 * always slot 1 and B always slot 2 -- colour follows the variant, never the
 * row order, so a filter never repaints them.
 */
export default function ExperimentTab({ data }: { data: AnalyticsResponse }) {
  const { variants, zTest, experimentId } = data.abComparison;

  if (variants.length === 0) {
    return (
      <EmptyNotice>
        <p>No experiment data for v{data.filters.version}.</p>
        <p className="muted">Forced (?variant=) sessions are excluded from this comparison.</p>
      </EmptyNotice>
    );
  }

  const slotOf = (variant: string): 1 | 2 => (variant === variants[0]?.variant ? 1 : 2);
  const series: Series[] = variants.map((v) => ({ id: v.variant, label: `Variant ${v.variant}`, slot: slotOf(v.variant) }));

  const bars: BarDatum[] = variants.map((v) => ({
    id: v.variant,
    label: `Variant ${v.variant}`,
    rate: v.conversion,
    valueLabel: v.conversion === null ? '—' : `${(v.conversion * 100).toFixed(1)}%`,
    slot: slotOf(v.variant),
  }));

  // Scale to the largest bar so small conversion rates stay readable.
  const peak = Math.max(...bars.map((b) => b.rate ?? 0), 0.01);
  const max = Math.min(1, Math.ceil(peak * 10) / 10);

  const lift = variants.length >= 2 ? deltaPp(variants[1].conversion, variants[0].conversion) : null;

  return (
    <div className="stack">
      <SectionCard
        title="Primary metric · end-to-end conversion"
        subtitle={
          <>
            Experiment <code>{experimentId ?? '—'}</code>
            {data.filters.utm_campaign ? ` · campaign ${data.filters.utm_campaign}` : ''} · v{data.filters.version} ·
            the variant filter does not apply here
          </>
        }
      >
        <ChartFrame caption="cta_clicked ÷ session_started" series={series}>
          <SeriesBars data={bars} max={max} />
        </ChartFrame>
        <ScaleNote max={max} />

        {lift !== null && variants.length >= 2 && (
          <p className="lift">
            Variant {variants[1].variant} vs {variants[0].variant}:{' '}
            {/*
             * The delta only wears a direction colour when the test actually
             * clears 95%. Painting an inconclusive gap green reads as a win.
             */}
            <span className={zTest.significantAt95 ? (lift >= 0 ? 'delta-good' : 'delta-bad') : 'delta-flat'}>
              {signedPp(lift)}
            </span>{' '}
            <span className="muted">
              {zTest.significantAt95 ? '— significant at 95%' : '— not significant at 95%, treat as no difference'}
            </span>
          </p>
        )}

        <p className="ztest muted">
          Two-proportion z-test on <code>{zTest.metric}</code>
          {variants.length >= 2 ? ` (${variants[0].variant} vs ${variants[1].variant})` : ''}:{' '}
          {zTest.z === null || zTest.pValue === null ? (
            'not enough data'
          ) : (
            <>
              z = {zTest.z.toFixed(3)}, p = {zTest.pValue.toFixed(4)}
            </>
          )}
        </p>
      </SectionCard>

      <SectionCard title="All funnel-level metrics" subtitle="Forced sessions excluded throughout">
        <div className="table-scroll">
          <table className="data-table">
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
        <p className="muted small">
          Forced (<code>?variant=</code>) sessions are excluded from this comparison; per-step comparison across
          variants is intentionally not shown because B reorders and removes steps.
        </p>
      </SectionCard>
    </div>
  );
}
