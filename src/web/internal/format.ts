// One source for every number the console prints, so a meter's direct label and
// the table cell beside it can never disagree.

/** A rate as a percentage, or an em dash when the denominator was zero. */
export const pct = (rate: number | null): string => (rate === null ? '—' : `${(rate * 100).toFixed(1)}%`);

/** Thousands-separated integer. */
export const count = (n: number): string => n.toLocaleString();

/** `62.5% (25/40)` -- the canonical rate-with-counts string. */
export const ratioLabel = (rate: number | null, n: number, d: number): string => `${pct(rate)} (${count(n)}/${count(d)})`;

/** Signed percentage-point delta between two rates, or null when either is missing. */
export function deltaPp(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return (a - b) * 100;
}

export const signedPp = (pp: number): string => `${pp >= 0 ? '+' : '−'}${Math.abs(pp).toFixed(1)}pp`;

export const formatDate = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
};
