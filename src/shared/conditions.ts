import type { Answers, ConditionLeaf, ConditionNode, Scalar, StepId } from './types';

const isScalar = (v: unknown): v is Scalar =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Evaluates a condition tree against answers.
 * - A leaf whose answer is missing is `false` — for negative operators too.
 * - A type mismatch is `false`, never a throw.
 * - An unknown operator throws (publish-time validation should have caught it).
 */
export function evaluate(node: ConditionNode, answers: Answers): boolean {
  if ('all' in node) return node.all.every((child) => evaluate(child, answers));
  if ('any' in node) return node.any.some((child) => evaluate(child, answers));
  if ('not' in node) return !evaluate(node.not, answers);
  return evaluateLeaf(node, answers);
}

function evaluateLeaf({ answer, operator, value }: ConditionLeaf, answers: Answers): boolean {
  const given = Object.hasOwn(answers, answer) ? answers[answer] : undefined;
  if (given === undefined || given === null) {
    if (!(OPERATOR_SET as Set<string>).has(operator)) throw unknownOperator(operator);
    return false;
  }
  switch (operator) {
    case 'eq':
      return isScalar(given) && given === value;
    case 'neq':
      return isScalar(given) && isScalar(value) && given !== value;
    case 'in':
      return isScalar(given) && Array.isArray(value) && value.includes(given);
    case 'nin':
      return isScalar(given) && Array.isArray(value) && !value.includes(given);
    case 'gt':
      return typeof given === 'number' && typeof value === 'number' && given > value;
    case 'gte':
      return typeof given === 'number' && typeof value === 'number' && given >= value;
    case 'lt':
      return typeof given === 'number' && typeof value === 'number' && given < value;
    case 'lte':
      return typeof given === 'number' && typeof value === 'number' && given <= value;
    case 'contains':
      return Array.isArray(given) && isScalar(value) && given.includes(value);
    default:
      throw unknownOperator(operator);
  }
}

const OPERATOR_SET = new Set(['eq', 'neq', 'in', 'nin', 'gt', 'gte', 'lt', 'lte', 'contains']);

function unknownOperator(operator: unknown): Error {
  return new Error(`Unknown condition operator: ${String(operator)}`);
}

/** Step IDs referenced by the leaves of a condition. Tolerates malformed nodes. */
export function conditionRefs(node: unknown): StepId[] {
  const refs = new Set<StepId>();
  const visit = (n: unknown) => {
    if (!isObject(n)) return;
    if (Array.isArray(n.all)) n.all.forEach(visit);
    else if (Array.isArray(n.any)) n.any.forEach(visit);
    else if ('not' in n) visit(n.not);
    else if (typeof n.answer === 'string') refs.add(n.answer);
  };
  visit(node);
  return [...refs];
}
