import { describe, expect, it } from 'vitest';
import { nextStep, prevStep, progress, validate, visibleAnswers, visibleSteps } from '@shared/navigation';
import type { Answers } from '@shared/types';
import { materialise } from '@shared/variant';
import { readConfig } from '../helpers';

const v1 = readConfig('funnel-v1.json');
const v3 = readConfig('iteration-2/funnel-v3.json');
const A = materialise(v1, 'A');
const B = materialise(v1, 'B');

describe('materialise', () => {
  it('uses the variant sequence and deep-merges overrides without dropping fields', () => {
    expect(B.stepSequence[1]).toBe('work_mode');
    expect(B.steps.priorities.content?.title).toBe('What would make the biggest difference right now?');
    expect(B.steps.priorities.input?.options).toHaveLength(5);
    expect(B.results.async_native.title).toBe('Your team is ready to reduce meetings');
    expect(B.results.async_native.summary).toBe(v1.results.async_native.summary);
    expect(A.steps.priorities.content?.title).toBe('What should the operating model improve?');
    expect(v1.steps.priorities.content?.title).toBe('What should the operating model improve?');
    expect(materialise(v3, 'B').stepSequence).not.toContain('tool_count');
  });
});

describe('visibleSteps', () => {
  it('shows office_days only for hybrid / office', () => {
    expect(visibleSteps(A, {})).not.toContain('office_days');
    expect(visibleSteps(A, { work_mode: 'remote' })).not.toContain('office_days');
    expect(visibleSteps(A, { work_mode: 'hybrid' })).toContain('office_days');
    expect(visibleSteps(A, { work_mode: 'office' })).toContain('office_days');
  });
});

describe('progress policy', () => {
  it('counts an unresolved conditional step toward the total', () => {
    expect(progress(A, {}, 'intro')).toEqual({ current: 0, total: 7 });
    expect(progress(A, {}, 'team_size')).toEqual({ current: 1, total: 7 });
    expect(progress(B, {}, 'work_mode')).toEqual({ current: 1, total: 7 });
  });

  it('excludes or includes the step once the gate resolves', () => {
    expect(progress(A, { team_size: 5, work_mode: 'remote' }, 'priorities')).toEqual({ current: 3, total: 6 });
    expect(progress(A, { team_size: 5, work_mode: 'hybrid' }, 'priorities')).toEqual({ current: 3, total: 7 });
  });

  it('reports total on the result step', () => {
    expect(progress(A, { work_mode: 'remote' }, 'result')).toEqual({ current: 6, total: 6 });
  });

  it('never grows the denominator along a forward path', () => {
    for (const config of [A, B, materialise(v3, 'A'), materialise(v3, 'B')]) {
      const path: Answers = {
        team_size: 8, work_mode: 'office', priorities: ['compliance'], security_constraints: 'strict',
        timezone_span: 'same', office_days: 3, meeting_hours: 4, async_maturity: 'low', tool_count: 6,
      };
      const given: Answers = {};
      let lastTotal = Infinity;
      for (const id of config.stepSequence) {
        if (!visibleSteps(config, given).includes(id)) continue;
        const { total, current } = progress(config, given, id);
        expect(total).toBeLessThanOrEqual(lastTotal);
        expect(current).toBeLessThanOrEqual(total);
        lastTotal = total;
        if (id in path) given[id] = path[id];
      }
    }
  });

  it('treats a v3 compliance follow-up as pending until priorities is answered', () => {
    const v3A = materialise(v3, 'A');
    const pending = progress(v3A, { team_size: 5, work_mode: 'remote' }, 'priorities').total;
    expect(progress(v3A, { team_size: 5, work_mode: 'remote', priorities: ['speed'] }, 'timezone_span').total).toBe(pending - 1);
    expect(progress(v3A, { team_size: 5, work_mode: 'remote', priorities: ['compliance'] }, 'security_constraints').total).toBe(pending);
  });
});

describe('orphaned answers', () => {
  it('keeps the stored answer but excludes it from visible steps, progress and effective answers', () => {
    const answers: Answers = { team_size: 5, work_mode: 'hybrid', office_days: 3 };
    const changed: Answers = { ...answers, work_mode: 'remote' };

    expect(visibleSteps(A, changed)).not.toContain('office_days');
    expect(visibleAnswers(A, changed)).not.toHaveProperty('office_days');
    expect(progress(A, changed, 'priorities').total).toBe(6);
    expect(changed.office_days).toBe(3);

    // Re-entering the branch: the form remembers.
    expect(visibleAnswers(A, { ...changed, work_mode: 'office' })).toMatchObject({ office_days: 3 });
  });
});

describe('nextStep / prevStep', () => {
  it('skips hidden steps in both directions', () => {
    expect(nextStep(A, { work_mode: 'remote' }, 'timezone_span')).toBe('async_maturity');
    expect(nextStep(A, { work_mode: 'hybrid' }, 'timezone_span')).toBe('office_days');
    expect(prevStep(A, { work_mode: 'remote' }, 'async_maturity')).toBe('timezone_span');
    expect(prevStep(A, { work_mode: 'office' }, 'async_maturity')).toBe('office_days');
  });

  it('returns null at the ends', () => {
    expect(prevStep(A, {}, 'intro')).toBeNull();
    expect(nextStep(A, {}, 'result')).toBeNull();
    expect(nextStep(A, {}, 'intro')).toBe('team_size');
  });
});

describe('validate', () => {
  it('number: required, bounds and whole numbers, with config messages', () => {
    const step = A.steps.team_size;
    expect(validate(step, undefined)).toEqual({ ok: false, message: 'Enter the team size.' });
    expect(validate(step, 0)).toEqual({ ok: false, message: 'The team must have at least one person.' });
    expect(validate(step, 201)).toEqual({ ok: false, message: 'For this demo, enter a value up to 200.' });
    expect(validate(step, 2.5)).toMatchObject({ ok: false });
    expect(validate(step, '12')).toMatchObject({ ok: false });
    expect(validate(step, 12)).toEqual({ ok: true });
  });

  it('single-select: must be a listed option', () => {
    const step = A.steps.work_mode;
    expect(validate(step, undefined)).toEqual({ ok: false, message: "Select the team's main work mode." });
    expect(validate(step, 'moon')).toMatchObject({ ok: false });
    expect(validate(step, 'remote')).toEqual({ ok: true });
  });

  it('multi-select: listed options within selection bounds', () => {
    const step = A.steps.priorities;
    expect(validate(step, [])).toEqual({ ok: false, message: 'Choose at least one priority.' });
    expect(validate(step, ['speed', 'focus', 'culture', 'cost'])).toEqual({ ok: false, message: 'Choose no more than three priorities.' });
    expect(validate(step, ['speed', 'compliance'])).toMatchObject({ ok: false });
    expect(validate(step, ['speed', 'speed'])).toMatchObject({ ok: false });
    expect(validate(step, ['speed', 'focus'])).toEqual({ ok: true });
  });

  it('steps without answers always pass', () => {
    expect(validate(A.steps.intro, undefined)).toEqual({ ok: true });
    expect(validate({ id: 'x', type: 'slider' }, 42)).toEqual({ ok: true });
  });
});
