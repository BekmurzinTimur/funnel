import { describe, expect, it } from 'vitest';
import { validateConfig } from '@shared/config.schema';
import { resolveResult } from '@shared/results';
import type { FunnelConfig } from '@shared/types';
import { materialise } from '@shared/variant';
import { readConfig } from '../helpers';

const v1A = materialise(readConfig('funnel-v1.json'), 'A');
const v3 = readConfig('iteration-2/funnel-v3.json');

describe('resolveResult', () => {
  it('first matching rule wins, in array order', () => {
    expect(resolveResult(v1A, { work_mode: 'remote', timezone_span: 'global' })).toBe('async_native');
    expect(resolveResult(v1A, { work_mode: 'hybrid', office_days: 2, async_maturity: 'high' })).toBe('async_native');
    expect(resolveResult(v1A, { work_mode: 'hybrid', office_days: 2, async_maturity: 'low' })).toBe('hybrid_structured');
    expect(resolveResult(v1A, { work_mode: 'office', office_days: 4, async_maturity: 'medium' })).toBe('office_core');
  });

  it('falls back to defaultResultId', () => {
    expect(resolveResult(v1A, { work_mode: 'remote', timezone_span: 'same', async_maturity: 'low' })).toBe('balanced');
    expect(resolveResult(v1A, {})).toBe('balanced');
  });

  it('handles the v3 rules placed first', () => {
    for (const variant of ['A', 'B']) {
      const config = materialise(v3, variant);
      expect(resolveResult(config, { work_mode: 'remote', priorities: ['compliance'], security_constraints: 'strict', meeting_hours: 20 })).toBe('regulated_scale');
      expect(resolveResult(config, { work_mode: 'hybrid', office_days: 2, priorities: ['speed'], meeting_hours: 20 })).toBe('meeting_heavy');
    }
  });

  it('ignores orphaned answers from a hidden branch', () => {
    // security_constraints is stored but hidden because compliance was deselected.
    const v3A = materialise(v3, 'A');
    expect(resolveResult(v3A, { work_mode: 'office', office_days: 3, priorities: ['speed'], security_constraints: 'regulated', meeting_hours: 2 })).toBe('office_core');

    const mini = miniConfig();
    expect(validateConfig(mini)).toMatchObject({ ok: true });
    const config = materialise(mini, 'A');
    expect(resolveResult(config, { q1: 'yes', q2: 'a' })).toBe('r_a');
    expect(resolveResult(config, { q1: 'no', q2: 'a' })).toBe('r_default');
  });
});

/** A rule that depends only on a gated step, so an orphan would change the outcome if it leaked. */
function miniConfig(): FunnelConfig {
  return {
    schemaVersion: '1.0',
    funnelId: 'mini',
    version: 1,
    session: { ttlHours: 1 },
    experiment: { id: 'mini-exp', variants: { A: { weight: 100, stepSequence: ['q1', 'q2', 'result'] } } },
    steps: {
      q1: { id: 'q1', type: 'single-select', content: { title: 'Q1' }, input: { options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] } },
      q2: {
        id: 'q2',
        type: 'single-select',
        content: { title: 'Q2' },
        input: { options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
        visibleWhen: { answer: 'q1', operator: 'eq', value: 'yes' },
      },
      result: { id: 'result', type: 'result' },
    },
    resultRules: [{ resultId: 'r_a', when: { answer: 'q2', operator: 'eq', value: 'a' } }],
    defaultResultId: 'r_default',
    results: { r_a: { id: 'r_a', title: 'A' }, r_default: { id: 'r_default', title: 'Default' } },
    events: { allowed: [{ name: 'session_started', properties: [] }] },
  };
}
