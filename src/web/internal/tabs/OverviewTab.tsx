import type { AnalyticsResponse, StepRow } from '@shared/api';
import { Meter } from '../charts';
import { count, pct, ratioLabel } from '../format';
import { EmptyNotice, Footnotes, Pill, Ratio, SectionCard } from '../parts';

/**
 * Per-step funnel. The meter IS the table: bar length plus exact counts in one
 * row, with the full numeric breakdown one disclosure away.
 */
export default function OverviewTab({ data }: { data: AnalyticsResponse }) {
  if (data.summary.started === 0 && data.eventCounts.length === 0) {
    return (
      <EmptyNotice>
        <p>No sessions match these filters for v{data.filters.version}.</p>
        <p className="muted">
          Locally, run <code>npm run seed</code> against the dev server to generate traffic.
        </p>
      </EmptyNotice>
    );
  }

  return (
    <div className="stack">
      {data.steps.map((group) => {
        // The entry step's Eligible IS the variant's session_started set (SPEC §7),
        // so it is the honest denominator for "share of sessions that got here".
        const entered = group.rows.find((r) => r.isEntry)?.eligible ?? 0;
        return (
          <SectionCard
            key={group.variant}
            title={`Funnel · variant ${group.variant}`}
            subtitle={`v${data.filters.version} · each bar is the share of the ${count(entered)} sessions that started`}
          >
            <div className="meter-head" aria-hidden="true">
              <span>Step</span>
              <span>Reached, of sessions started</span>
              <span />
              <span>Drop-off</span>
            </div>
            <div className="chart-body">
              {group.rows.map((row) => {
                const share = entered === 0 ? null : row.reached / entered;
                return (
                  <Meter
                    key={row.stepId}
                    label={row.stepId}
                    badge={row.isEntry ? <Pill kind="neutral">entry</Pill> : undefined}
                    fill={share}
                    valueLabel={ratioLabel(share, row.reached, entered)}
                    ariaLabel={`${row.stepId}: reached by ${row.reached} of ${entered} sessions started`}
                    trailing={row.dropOff === null ? '—' : pct(row.dropOffRate)}
                  />
                );
              })}
            </div>

            <details className="table-details">
              <summary>Full numbers for variant {group.variant}</summary>
              <StepTable rows={group.rows} />
            </details>
          </SectionCard>
        );
      })}

      <Footnotes summary="How these numbers are built">
        <p>
          <strong>The bars are reach, not conversion.</strong> Each bar is that step&apos;s <em>Reached</em> count over
          the sessions that started the funnel, so the bars narrow as the funnel does and a conditional step shows up
          short — only the sessions routed down that branch ever arrive. Conversion is in the numbers table below: it
          is edge-based and therefore close to 100% at every step, which makes it a data-quality check rather than
          something to plot.
        </p>
        <p>
          <strong>Conversion = Reached ∩ Eligible ÷ Eligible.</strong> It is edge-based: Eligible counts sessions whose{' '}
          <code>step_completed</code> routed them to this step (the entry step uses <code>session_started</code>), so a
          conditional step only counts sessions that were sent to it. <em>Reached − Converted</em> is a data-quality
          signal (views with no recorded incoming edge), not a conversion.
        </p>
        <p>
          <strong>Drop-off is per step</strong>, not a partition of abandoned sessions: a session that viewed a step,
          went back and abandoned elsewhere is counted at each step it never moved past, so the column can sum to more
          than the number of abandoned sessions.
        </p>
      </Footnotes>
    </div>
  );
}

function StepTable({ rows }: { rows: StepRow[] }) {
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>Step</th>
            <th>Type</th>
            <th className="num">Reached</th>
            <th className="num">Eligible</th>
            <th className="num">Converted</th>
            <th className="num">Conversion</th>
            <th className="num">Drop-off</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.stepId}>
              <td>
                <code>{r.stepId}</code>
                {r.isEntry && <Pill kind="neutral">entry</Pill>}
              </td>
              <td className="muted">{r.type}</td>
              <td className="num">{r.reached}</td>
              <td className="num">{r.eligible}</td>
              <td className="num">{r.converted}</td>
              <td className="num">
                <Ratio rate={r.conversionRate} n={r.converted} d={r.eligible} />
              </td>
              <td className="num">
                {r.dropOff === null ? (
                  <span className="muted">—</span>
                ) : (
                  <Ratio rate={r.dropOffRate} n={r.dropOff} d={r.reached} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
