// Pooled two-proportion z-test for the A/B primary metric (SPEC §14).

/** Abramowitz–Stegun 7.1.26 (|error| < 1.5e-7). */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - poly * Math.exp(-ax * ax));
}

export const normalCdf = (z: number): number => 0.5 * (1 + erf(z / Math.SQRT2));

export interface ZTestResult {
  z: number | null;
  pValue: number | null;
  significantAt95: boolean;
}

/** x = successes, n = trials. z/pValue null when a group is empty or the pooled rate is 0 or 1. */
export function twoProportionZTest(x1: number, n1: number, x2: number, n2: number): ZTestResult {
  if (n1 === 0 || n2 === 0) return { z: null, pValue: null, significantAt95: false };
  const pooled = (x1 + x2) / (n1 + n2);
  if (pooled <= 0 || pooled >= 1) return { z: null, pValue: null, significantAt95: false };
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  const z = (x1 / n1 - x2 / n2) / se;
  const pValue = Math.min(1, Math.max(0, 2 * (1 - normalCdf(Math.abs(z)))));
  return { z, pValue, significantAt95: pValue < 0.05 };
}
