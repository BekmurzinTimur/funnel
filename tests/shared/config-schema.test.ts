import { describe, expect, it } from 'vitest';
import { validateConfig } from '@shared/config.schema';
import type { FunnelConfig } from '@shared/types';
import { readConfig } from '../helpers';

const v1 = readConfig('funnel-v1.json');
const v3 = readConfig('iteration-2/funnel-v3.json');

function errorsOf(config: unknown): string[] {
  const result = validateConfig(config);
  if (result.ok) throw new Error('expected validation to fail');
  return result.errors;
}

describe('config schema', () => {
  it('accepts both provided configs', () => {
    expect(validateConfig(v1)).toMatchObject({ ok: true });
    expect(validateConfig(v3)).toMatchObject({ ok: true });
  });

  it('returns the raw object, keeping informational fields', () => {
    const result = validateConfig(v3);
    expect(result.ok && result.config.releaseNote).toBe(v3.releaseNote);
  });

  it('rejects unsupported step types and operators, collecting every violation', () => {
    const bad = structuredClone(v1) as FunnelConfig;
    bad.steps.team_size.type = 'slider';
    bad.steps.office_days.visibleWhen = { answer: 'work_mode', operator: 'regex', value: 'x' } as never;
    bad.experiment.variants.B.weight = 40;
    bad.defaultResultId = 'nope';
    bad.events.allowed.push({ name: 'step_viewed', properties: [] });

    const errors = errorsOf(bad);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^steps\.team_size\.type: unsupported step type "slider"/),
        expect.stringMatching(/^steps\.office_days\.visibleWhen\.operator: unsupported operator "regex"/),
        expect.stringMatching(/weights must sum to 100 \(got 90\)/),
        expect.stringMatching(/^defaultResultId: unknown result "nope"/),
        expect.stringMatching(/duplicate event name "step_viewed"/),
      ]),
    );
  });

  it('requires a gate to reference a step earlier in the same variant sequence', () => {
    const bad = structuredClone(v1) as FunnelConfig;
    bad.experiment.variants.B.stepSequence = ['intro', 'office_days', 'work_mode', 'timezone_span', 'team_size', 'async_maturity', 'priorities', 'tool_count', 'result'];
    expect(errorsOf(bad)).toEqual([
      expect.stringMatching(/^experiment\.variants\.B\.stepSequence\.1: step "office_days" is shown based on "work_mode"/),
    ]);
  });

  it('checks references to steps, results and the result step position', () => {
    const bad = structuredClone(v3) as FunnelConfig;
    bad.resultRules[0].when = { answer: 'intro', operator: 'eq', value: 'x' };
    bad.resultRules[1].resultId = 'missing_result';
    bad.experiment.variants.A.stepSequence = bad.experiment.variants.A.stepSequence.filter((id) => id !== 'result');
    bad.experiment.variants.B.stepSequence.push('ghost');
    bad.experiment.variants.B.stepOverrides = { ...bad.experiment.variants.B.stepOverrides, nowhere: {} };
    bad.steps.work_mode.id = 'workmode';

    const errors = errorsOf(bad);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/resultRules\.0\.when\.answer: references step "intro" of type "info"/),
        expect.stringMatching(/resultRules\.1\.resultId: unknown result "missing_result"/),
        expect.stringMatching(/variants\.A\.stepSequence: must contain exactly one result step \(found 0\)/),
        expect.stringMatching(/variants\.B\.stepSequence\.10: unknown step "ghost"/),
        expect.stringMatching(/variants\.B\.stepOverrides\.nowhere: override for unknown step/),
        expect.stringMatching(/steps\.work_mode\.id: step id "workmode" must equal its key/),
      ]),
    );
  });

  it('reports structural problems readably', () => {
    const bad = structuredClone(v1) as unknown as Record<string, unknown>;
    bad.version = 0;
    delete bad.events;
    const errors = errorsOf(bad);
    expect(errors.some((e) => e.startsWith('version:'))).toBe(true);
    expect(errors.some((e) => e.startsWith('events:'))).toBe(true);
  });
});
