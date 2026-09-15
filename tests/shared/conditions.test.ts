import { describe, expect, it } from 'vitest';
import { evaluate } from '@shared/conditions';
import type { Answers, ConditionNode } from '@shared/types';

const answers: Answers = { work_mode: 'hybrid', team_size: 12, priorities: ['speed', 'compliance'] };
const leaf = (answer: string, operator: string, value: unknown) => ({ answer, operator, value }) as ConditionNode;

describe('evaluate', () => {
  it('eq / neq use strict equality', () => {
    expect(evaluate(leaf('work_mode', 'eq', 'hybrid'), answers)).toBe(true);
    expect(evaluate(leaf('team_size', 'eq', '12'), answers)).toBe(false);
    expect(evaluate(leaf('work_mode', 'neq', 'remote'), answers)).toBe(true);
    expect(evaluate(leaf('work_mode', 'neq', 'hybrid'), answers)).toBe(false);
  });

  it('in / nin test membership of a scalar answer', () => {
    expect(evaluate(leaf('work_mode', 'in', ['hybrid', 'office']), answers)).toBe(true);
    expect(evaluate(leaf('work_mode', 'in', ['remote']), answers)).toBe(false);
    expect(evaluate(leaf('work_mode', 'nin', ['remote']), answers)).toBe(true);
    expect(evaluate(leaf('work_mode', 'nin', ['hybrid']), answers)).toBe(false);
  });

  it('numeric comparisons; a non-number answer is false', () => {
    expect(evaluate(leaf('team_size', 'gt', 11), answers)).toBe(true);
    expect(evaluate(leaf('team_size', 'gte', 12), answers)).toBe(true);
    expect(evaluate(leaf('team_size', 'lt', 12), answers)).toBe(false);
    expect(evaluate(leaf('team_size', 'lte', 12), answers)).toBe(true);
    expect(evaluate(leaf('work_mode', 'gt', 1), answers)).toBe(false);
  });

  it('contains checks a multi-select array; a non-array answer is false', () => {
    expect(evaluate(leaf('priorities', 'contains', 'compliance'), answers)).toBe(true);
    expect(evaluate(leaf('priorities', 'contains', 'cost'), answers)).toBe(false);
    expect(evaluate(leaf('work_mode', 'contains', 'hybrid'), answers)).toBe(false);
  });

  it('a missing answer is false, including for neq / nin', () => {
    expect(evaluate(leaf('office_days', 'eq', 3), answers)).toBe(false);
    expect(evaluate(leaf('office_days', 'neq', 3), answers)).toBe(false);
    expect(evaluate(leaf('office_days', 'nin', [3]), answers)).toBe(false);
    expect(evaluate({ not: leaf('office_days', 'eq', 3) }, answers)).toBe(true);
  });

  it('type mismatches are false, never a throw', () => {
    expect(evaluate(leaf('work_mode', 'in', 'hybrid'), answers)).toBe(false);
    expect(evaluate(leaf('priorities', 'eq', 'speed'), answers)).toBe(false);
    expect(evaluate(leaf('team_size', 'gt', '5'), answers)).toBe(false);
  });

  it('evaluates all / any / not groups recursively', () => {
    const node: ConditionNode = {
      any: [
        { all: [leaf('work_mode', 'eq', 'remote'), leaf('team_size', 'gt', 5)] },
        { all: [leaf('priorities', 'contains', 'speed'), { not: leaf('work_mode', 'eq', 'office') }] },
      ],
    };
    expect(evaluate(node, answers)).toBe(true);
    expect(evaluate(node, { ...answers, work_mode: 'office' })).toBe(false);
  });

  it('throws on an unknown operator', () => {
    expect(() => evaluate(leaf('work_mode', 'regex', '.*'), answers)).toThrow(/Unknown condition operator/);
  });
});
