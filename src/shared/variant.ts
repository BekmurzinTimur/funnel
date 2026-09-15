import type { FunnelConfig, MaterialisedConfig, ResultDefinition, Step, VariantDefinition } from './types';

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Deep merge: plain objects merge recursively; arrays and scalars replace. Never mutates. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = isPlainObject(out[key]) && isPlainObject(value) ? deepMerge(out[key], value) : value;
  }
  return out as T;
}

/**
 * Applies one variant: its stepSequence, with stepOverrides merged into steps and
 * resultOverrides merged into results. The result carries no trace of variants.
 */
export function materialise(config: FunnelConfig, variant: string): MaterialisedConfig {
  const def = config.experiment.variants[variant];
  if (!def) throw new Error(`Unknown variant "${variant}" for ${config.funnelId} v${config.version}`);

  const steps: Record<string, Step> = {};
  for (const [id, step] of Object.entries(config.steps)) {
    steps[id] = deepMerge(step, def.stepOverrides?.[id]);
  }
  const results: Record<string, ResultDefinition> = {};
  for (const [id, result] of Object.entries(config.results)) {
    results[id] = deepMerge(result, def.resultOverrides?.[id]);
  }

  return {
    funnelId: config.funnelId,
    version: config.version,
    title: config.title,
    session: config.session,
    progress: { excludeTypes: config.progress?.excludeTypes ?? ['info', 'result'] },
    stepSequence: [...def.stepSequence],
    steps,
    resultRules: config.resultRules,
    defaultResultId: config.defaultResultId,
    results,
    events: config.events,
  };
}

/** FNV-1a, 32-bit. Stable across platforms and runtimes. */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 0–99 bucket for a session within an experiment. */
export function bucketOf(sessionId: string, experimentId: string): number {
  return fnv1a(sessionId + experimentId) % 100;
}

/**
 * Deterministic weighted assignment: `hash(session_id + experiment_id) % 100`,
 * bucketed by cumulative weight in variant-key order. The caller persists the
 * result — stickiness is a property of the data, not of the hash.
 */
export function assignVariant(
  sessionId: string,
  experimentId: string,
  variants: Record<string, Pick<VariantDefinition, 'weight'>>,
): string {
  const keys = Object.keys(variants).sort();
  if (keys.length === 0) throw new Error('Experiment has no variants');
  const bucket = bucketOf(sessionId, experimentId);
  let cumulative = 0;
  for (const key of keys) {
    cumulative += variants[key].weight;
    if (bucket < cumulative) return key;
  }
  return keys[keys.length - 1];
}
