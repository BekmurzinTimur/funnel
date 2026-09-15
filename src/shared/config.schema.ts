import { z } from 'zod';
import { conditionRefs } from './conditions';
import {
  ANSWER_STEP_TYPES,
  OPERATORS,
  STEP_TYPES,
  type FunnelConfig,
  type StepType,
} from './types';

// ---------------------------------------------------------------------------
// Structural schema. Objects are loose: unknown display fields pass through to
// the renderer, and informational fields (status, releaseNote, locale, trigger)
// are accepted and ignored. The stored config is the submitted JSON verbatim.
// ---------------------------------------------------------------------------

const Title = z.looseObject({ title: z.string().min(1) });

const Validation = z.looseObject({
  required: z.boolean().optional(),
  minSelections: z.number().int().nonnegative().optional(),
  maxSelections: z.number().int().positive().optional(),
  messages: z.record(z.string(), z.string()).optional(),
});

const Option = z.looseObject({ value: z.string().min(1), label: z.string().min(1) });

const SelectStep = z.looseObject({
  content: Title,
  input: z.looseObject({ options: z.array(Option).min(1) }),
  validation: Validation.optional(),
});

/** Per-type shape checks, applied after the type is known to be whitelisted. */
const STEP_SCHEMAS: Record<StepType, z.ZodType> = {
  info: z.looseObject({ content: Title }),
  'single-select': SelectStep,
  'multi-select': SelectStep,
  number: z.looseObject({
    content: Title,
    input: z.looseObject({
      min: z.number().optional(),
      max: z.number().optional(),
      step: z.number().positive().optional(),
      unit: z.string().optional(),
    }),
    validation: Validation.optional(),
  }),
  result: z.looseObject({ content: z.looseObject({}).optional() }),
};

const Step = z.looseObject({
  id: z.string().min(1),
  type: z.string().min(1),
  visibleWhen: z.unknown().optional(),
});

const Variant = z.looseObject({
  weight: z.number(),
  stepSequence: z.array(z.string().min(1)).min(1),
  stepOverrides: z.record(z.string(), z.looseObject({})).optional(),
  resultOverrides: z.record(z.string(), z.looseObject({})).optional(),
});

const Result = z.looseObject({
  id: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().optional(),
  recommendations: z.array(z.string()).optional(),
  cta: z.looseObject({ label: z.string().min(1), action: z.string().min(1) }).optional(),
});

const StructuralSchema = z.looseObject({
  schemaVersion: z.string().min(1),
  funnelId: z.string().min(1).max(100),
  version: z.number().int().positive(),
  title: z.string().optional(),
  session: z.looseObject({ ttlHours: z.number().positive() }),
  progress: z.looseObject({ excludeTypes: z.array(z.string()).optional() }).optional(),
  experiment: z.looseObject({
    id: z.string().min(1),
    variants: z.record(z.string().regex(/^[A-Z]$/, 'variant keys must be a single uppercase letter'), Variant),
  }),
  steps: z.record(z.string().min(1), Step),
  resultRules: z.array(z.looseObject({ resultId: z.string().min(1), when: z.unknown() })),
  defaultResultId: z.string().min(1),
  results: z.record(z.string().min(1), Result),
  events: z.looseObject({
    allowed: z.array(z.looseObject({ name: z.string().min(1), properties: z.array(z.string()) })).min(1),
  }),
});

// ---------------------------------------------------------------------------
// Semantic / referential-integrity checks. Every violation is collected.
// ---------------------------------------------------------------------------

type Path = (string | number)[];
export interface ConfigIssue {
  path: Path;
  message: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isScalar = (v: unknown) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
const isStepType = (t: unknown): t is StepType => (STEP_TYPES as readonly unknown[]).includes(t);
const isAnswerType = (t: unknown) => (ANSWER_STEP_TYPES as readonly unknown[]).includes(t);

export function integrityIssues(cfg: FunnelConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const add = (path: Path, message: string): void => {
    issues.push({ path, message });
  };
  const steps = cfg.steps ?? {};
  const results = cfg.results ?? {};

  const checkCondition = (node: unknown, path: Path): void => {
    if (!isObject(node)) return add(path, 'condition must be an object');
    const keys = Object.keys(node);
    for (const group of ['all', 'any'] as const) {
      if (!(group in node)) continue;
      if (keys.length !== 1) add(path, `a "${group}" group must not have other keys`);
      const children = node[group];
      if (!Array.isArray(children) || children.length === 0) {
        return add([...path, group], `"${group}" must be a non-empty array of conditions`);
      }
      children.forEach((child, i) => checkCondition(child, [...path, group, i]));
      return;
    }
    if ('not' in node) {
      if (keys.length !== 1) add(path, 'a "not" group must not have other keys');
      return checkCondition(node.not, [...path, 'not']);
    }
    if (!('answer' in node) || !('operator' in node)) {
      return add(path, 'condition must be a group (all / any / not) or a leaf { answer, operator, value }');
    }
    const { answer, operator, value } = node;
    if (typeof answer !== 'string' || answer === '') {
      add([...path, 'answer'], 'answer must be a step id');
    } else if (!steps[answer]) {
      add([...path, 'answer'], `references unknown step "${answer}"`);
    } else if (!isAnswerType(steps[answer].type)) {
      add([...path, 'answer'], `references step "${answer}" of type "${steps[answer].type}", which does not collect an answer`);
    }
    if (!(OPERATORS as readonly unknown[]).includes(operator)) {
      return add([...path, 'operator'], `unsupported operator "${String(operator)}" (supported: ${OPERATORS.join(', ')})`);
    }
    switch (operator) {
      case 'eq':
      case 'neq':
      case 'contains':
        if (!isScalar(value)) add([...path, 'value'], `operator "${operator}" needs a string, number or boolean value`);
        break;
      case 'in':
      case 'nin':
        if (!Array.isArray(value) || !value.every(isScalar)) add([...path, 'value'], `operator "${operator}" needs an array of values`);
        break;
      default:
        if (typeof value !== 'number') add([...path, 'value'], `operator "${operator}" needs a numeric value`);
    }
  };

  // Steps
  for (const [key, step] of Object.entries(steps)) {
    const base: Path = ['steps', key];
    if (step.id !== key) add([...base, 'id'], `step id "${step.id}" must equal its key "${key}"`);
    if (!isStepType(step.type)) {
      add([...base, 'type'], `unsupported step type "${String(step.type)}" (supported: ${STEP_TYPES.join(', ')})`);
    } else {
      const parsed = STEP_SCHEMAS[step.type].safeParse(step);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) add([...base, ...(issue.path as Path)], issue.message);
      }
      const v = step.validation;
      if (step.type === 'multi-select' && v?.minSelections !== undefined && v?.maxSelections !== undefined && v.minSelections > v.maxSelections) {
        add([...base, 'validation'], 'minSelections must not exceed maxSelections');
      }
      const input = step.input;
      if (step.type === 'number' && typeof input?.min === 'number' && typeof input?.max === 'number' && input.min > input.max) {
        add([...base, 'input'], 'min must not exceed max');
      }
    }
    if (step.visibleWhen !== undefined) checkCondition(step.visibleWhen, [...base, 'visibleWhen']);
  }

  // Variants
  const variants = Object.entries(cfg.experiment?.variants ?? {});
  if (variants.length === 0) add(['experiment', 'variants'], 'at least one variant is required');
  let weightSum = 0;
  let weightsValid = true;
  for (const [name, variant] of variants) {
    const base: Path = ['experiment', 'variants', name];
    if (!Number.isInteger(variant.weight) || variant.weight < 0) {
      weightsValid = false;
      add([...base, 'weight'], `weight must be a non-negative integer (got ${variant.weight})`);
    } else {
      weightSum += variant.weight;
    }

    const sequence = variant.stepSequence ?? [];
    const seen = new Set<string>();
    const resultPositions: number[] = [];
    sequence.forEach((id, i) => {
      const path: Path = [...base, 'stepSequence', i];
      const step = steps[id];
      if (!step) return add(path, `unknown step "${id}"`);
      if (seen.has(id)) add(path, `step "${id}" appears more than once`);
      if (step.type === 'result') resultPositions.push(i);
      for (const ref of conditionRefs(step.visibleWhen)) {
        if (!seen.has(ref)) {
          add(path, `step "${id}" is shown based on "${ref}", which does not appear earlier in variant ${name}'s sequence`);
        }
      }
      seen.add(id);
    });
    if (resultPositions.length !== 1) {
      add([...base, 'stepSequence'], `must contain exactly one result step (found ${resultPositions.length})`);
    } else if (resultPositions[0] !== sequence.length - 1) {
      add([...base, 'stepSequence'], 'the result step must be last');
    }

    for (const key of Object.keys(variant.stepOverrides ?? {})) {
      if (!steps[key]) add([...base, 'stepOverrides', key], `override for unknown step "${key}"`);
    }
    for (const key of Object.keys(variant.resultOverrides ?? {})) {
      if (!results[key]) add([...base, 'resultOverrides', key], `override for unknown result "${key}"`);
    }
  }
  if (variants.length > 0 && weightsValid && weightSum !== 100) {
    add(['experiment', 'variants'], `variant weights must sum to 100 (got ${weightSum})`);
  }

  // Results
  (cfg.resultRules ?? []).forEach((rule, i) => {
    if (!results[rule.resultId]) add(['resultRules', i, 'resultId'], `unknown result "${rule.resultId}"`);
    checkCondition(rule.when, ['resultRules', i, 'when']);
  });
  if (!results[cfg.defaultResultId]) add(['defaultResultId'], `unknown result "${cfg.defaultResultId}"`);

  // Events
  const names = new Set<string>();
  (cfg.events?.allowed ?? []).forEach((event, i) => {
    if (names.has(event.name)) add(['events', 'allowed', i, 'name'], `duplicate event name "${event.name}"`);
    names.add(event.name);
  });

  return issues;
}

export const FunnelConfigSchema = StructuralSchema.superRefine((cfg, ctx) => {
  let issues: ConfigIssue[];
  try {
    issues = integrityIssues(cfg as unknown as FunnelConfig);
  } catch {
    return; // structure is broken; structural issues already describe it
  }
  for (const issue of issues) ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
});

export function formatIssues(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string[] {
  return issues.map((i) => `${i.path.length ? i.path.map(String).join('.') : '(root)'}: ${i.message}`);
}

export type ConfigValidation = { ok: true; config: FunnelConfig } | { ok: false; errors: string[] };

/**
 * Validates a raw config. On success returns the *raw* object (not the parsed,
 * possibly key-stripped one) so callers can store and use it verbatim.
 */
export function validateConfig(raw: unknown): ConfigValidation {
  const result = FunnelConfigSchema.safeParse(raw);
  if (result.success) return { ok: true, config: raw as FunnelConfig };
  return { ok: false, errors: formatIssues(result.error.issues) };
}
