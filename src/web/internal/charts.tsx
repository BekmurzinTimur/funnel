import type { ReactNode } from 'react';
import { pct, ratioLabel } from './format';
import './charts.css';

/*
 * Hand-rolled marks -- no chart dependency. Specs held here:
 *   - bars <= 24px thick, 4px rounded data-end, square at the baseline
 *   - a 2px surface gap separates touching fills; never a border around a mark
 *   - gridlines are solid hairlines, never dashed
 *   - a legend appears whenever there are >= 2 series; one series needs none
 *   - labels wear text tokens, never the series colour
 */

export interface Series {
  /** Stable key -- colour follows the entity, so a filter never repaints survivors. */
  id: string;
  label: string;
  /** Slot index into the validated categorical palette. */
  slot: 1 | 2;
}

/** Figure wrapper: caption, optional legend, then the marks. */
export function ChartFrame({
  caption,
  series,
  children,
}: {
  caption: string;
  series?: Series[];
  children: ReactNode;
}) {
  return (
    <figure className="chart">
      <figcaption className="chart-caption">{caption}</figcaption>
      {series && series.length >= 2 && <Legend series={series} />}
      <div className="chart-body">{children}</div>
    </figure>
  );
}

export function Legend({ series }: { series: Series[] }) {
  return (
    <ul className="legend">
      {series.map((s) => (
        <li key={s.id}>
          <span className={`legend-key series-${s.slot}`} aria-hidden="true" />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * One funnel step as a meter. The fill is the step's share of the sessions that
 * entered the funnel, so the bars narrow the way the funnel does and a
 * conditional branch shows up as a short bar. The track behind it is everything
 * that never got here.
 *
 * Deliberately NOT converted/eligible: that ratio is edge-based and therefore
 * ~100% at every step, so it renders as a wall of full bars carrying no signal.
 * It stays in the numbers table, where it works as a data-quality check.
 */
export function Meter({
  label,
  badge,
  fill,
  valueLabel,
  ariaLabel,
  trailing,
}: {
  label: string;
  badge?: ReactNode;
  /** 0..1 share of the bar to fill, or null when there is no denominator. */
  fill: number | null;
  valueLabel: string;
  ariaLabel: string;
  trailing?: ReactNode;
}) {
  const width = fill === null ? 0 : Math.min(1, Math.max(0, fill)) * 100;
  return (
    <div className="meter-row">
      <div className="meter-label">
        <code>{label}</code>
        {badge}
      </div>
      <div className="meter-track" role="img" aria-label={ariaLabel}>
        {width > 0 && (
          // A full bar has no remainder beside it, so it drops the separating gap.
          <div className={width >= 100 ? 'meter-fill meter-fill-full' : 'meter-fill'} style={{ width: `${width}%` }} />
        )}
      </div>
      <div className="meter-value">{valueLabel}</div>
      <div className="meter-trailing muted">{trailing}</div>
    </div>
  );
}

export interface BarDatum {
  id: string;
  label: string;
  /** 0..1, or null when the denominator was zero. */
  rate: number | null;
  /** Rendered at the bar tip. */
  valueLabel: string;
  slot: 1 | 2;
}

/**
 * Horizontal bars on a shared 0-100% scale. One series or two; past that the
 * data belongs in a table rather than more hues.
 */
export function SeriesBars({ data, max = 1 }: { data: BarDatum[]; max?: number }) {
  return (
    <div className="sbars">
      {data.map((d) => {
        const width = d.rate === null || max === 0 ? 0 : Math.min(1, d.rate / max) * 100;
        return (
          <div key={d.id} className="sbar-row">
            <span className="sbar-label">{d.label}</span>
            <span className="sbar-track">
              {width > 0 && <span className={`sbar-fill series-${d.slot}`} style={{ width: `${width}%` }} />}
            </span>
            <span className="sbar-value">{d.valueLabel}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Percentage scale caption, so bars are readable without gridline clutter. */
export function ScaleNote({ max = 1 }: { max?: number }) {
  return <p className="scale-note muted">Scale: 0 – {pct(max)}</p>;
}
