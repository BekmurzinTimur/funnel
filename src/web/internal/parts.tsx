import { useId, type ReactNode } from 'react';
import { count, pct, ratioLabel } from './format';

// Small presentational primitives shared by every tab. Follows the pattern of
// funnel/parts.tsx: plain functions, no state except where a control needs it.

/** `62.5% (25/40)`, the percentage in ink and the counts muted beside it. */
export function Ratio({ rate, n, d }: { rate: number | null; n: number; d: number }) {
  return (
    <span className="ratio" title={ratioLabel(rate, n, d)}>
      {pct(rate)}{' '}
      <span className="muted">
        ({count(n)}/{count(d)})
      </span>
    </span>
  );
}

export function Pill({ children, kind = 'accent' }: { children: ReactNode; kind?: 'accent' | 'neutral' }) {
  return <span className={kind === 'neutral' ? 'pill pill-neutral' : 'pill'}>{children}</span>;
}

/** A titled card. `aria-labelledby` is wired to the heading, as elsewhere in the app. */
export function SectionCard({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="card panel" aria-labelledby={id}>
      <div className="panel-head">
        <div>
          <h2 id={id}>{title}</h2>
          {subtitle && <p className="panel-sub muted">{subtitle}</p>}
        </div>
        {actions && <div className="panel-actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** A stat tile. Proportional figures on the value -- tabular-nums belongs in columns. */
export function StatTile({ label, value, note }: { label: string; value: string; note?: ReactNode }) {
  return (
    <div className="card stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {note && <div className="stat-note muted">{note}</div>}
    </div>
  );
}

export function EmptyNotice({ children }: { children: ReactNode }) {
  return <div className="card notice">{children}</div>;
}

/**
 * The footnote that used to sit under every table as superscripts. Collapsed
 * into a disclosure so the numbers lead and the methodology is one click away.
 */
export function Footnotes({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="footnotes">
      <summary>{summary}</summary>
      <div className="footnotes-body muted">{children}</div>
    </details>
  );
}
