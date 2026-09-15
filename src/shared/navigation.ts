import { conditionRefs, evaluate } from './conditions';
import type {
  Answers,
  MaterialisedConfig,
  NavigationState,
  Progress,
  Step,
  StepId,
  ValidationResult,
} from './types';

const hasAnswer = (answers: Answers, id: StepId) =>
  Object.hasOwn(answers, id) && answers[id] !== undefined && answers[id] !== null;

interface Walk {
  /** Steps the user can navigate, in sequence order. */
  visible: StepId[];
  /** Visible steps plus hidden steps whose gate is still unresolved (progress policy). */
  countable: StepId[];
  /** Answers of visible steps only — orphaned answers are excluded. */
  effective: Answers;
}

/**
 * Single pass over stepSequence. Gates are evaluated against the answers of
 * steps already known to be visible; publish-time validation guarantees a gate
 * only references earlier steps, so one pass resolves everything. An answer to a
 * hidden step (an orphan) is kept in storage but never enters `effective`, so it
 * cannot open further gates or influence the result.
 */
function walk(config: MaterialisedConfig, answers: Answers): Walk {
  const visible: StepId[] = [];
  const countable: StepId[] = [];
  const effective: Answers = {};
  const reachable = new Set<StepId>();

  for (const id of config.stepSequence) {
    const step = config.steps[id];
    if (!step) continue;
    let isVisible = true;
    let pending = false;
    if (step.visibleWhen) {
      isVisible = evaluate(step.visibleWhen, effective);
      // Unresolved: the gate depends on a step the user can still reach but has not answered.
      pending = !isVisible && conditionRefs(step.visibleWhen).some((ref) => reachable.has(ref) && !hasAnswer(effective, ref));
    }
    if (isVisible) {
      visible.push(id);
      if (hasAnswer(answers, id)) effective[id] = answers[id];
    }
    if (isVisible || pending) {
      countable.push(id);
      reachable.add(id);
    }
  }
  return { visible, countable, effective };
}

export function visibleSteps(config: MaterialisedConfig, answers: Answers): StepId[] {
  return walk(config, answers).visible;
}

/** Answers for currently visible steps only. Use for result evaluation. */
export function visibleAnswers(config: MaterialisedConfig, answers: Answers): Answers {
  return walk(config, answers).effective;
}

export function firstStep(config: MaterialisedConfig, answers: Answers): StepId | null {
  return visibleSteps(config, answers)[0] ?? null;
}

export function nextStep(config: MaterialisedConfig, answers: Answers, from: StepId): StepId | null {
  const position = config.stepSequence.indexOf(from);
  const visible = visibleSteps(config, answers);
  return visible.find((id) => config.stepSequence.indexOf(id) > position) ?? null;
}

export function prevStep(config: MaterialisedConfig, answers: Answers, from: StepId): StepId | null {
  const position = config.stepSequence.indexOf(from);
  const earlier = visibleSteps(config, answers).filter((id) => config.stepSequence.indexOf(id) < position);
  return earlier[earlier.length - 1] ?? null;
}

/**
 * Progress policy: a conditional step whose gating answer is not yet given counts
 * toward the total. Once the gate resolves the step is included or excluded for
 * real, so on a forward path the denominator only shrinks. Steps whose type is in
 * `progress.excludeTypes` are navigable but never counted.
 *
 * `current` is the 1-based position of the current step among counted steps; an
 * excluded step (e.g. intro) reports how many counted steps precede it, and the
 * result step reports `total`.
 */
export function progress(config: MaterialisedConfig, answers: Answers, currentStepId: StepId | null): Progress {
  const { countable } = walk(config, answers);
  const excluded = new Set(config.progress.excludeTypes);
  const counts = (id: StepId) => !excluded.has(config.steps[id]?.type ?? '');
  const total = countable.filter(counts).length;
  if (currentStepId == null) return { current: 0, total };
  if (config.steps[currentStepId]?.type === 'result') return { current: total, total };
  const index = countable.indexOf(currentStepId);
  if (index < 0) return { current: 0, total };
  return { current: countable.slice(0, index + 1).filter(counts).length, total };
}

export function navigationState(
  config: MaterialisedConfig,
  answers: Answers,
  currentStepId: StepId | null,
  resultId: string | null,
): NavigationState {
  return {
    currentStepId,
    visibleSteps: visibleSteps(config, answers),
    progress: progress(config, answers, currentStepId),
    resultId,
  };
}

const OK: ValidationResult = { ok: true };
const fail = (message: string): ValidationResult => ({ ok: false, message });
const isEmpty = (v: unknown) => v === undefined || v === null || v === '';

/**
 * Validates a submitted value for a step. Used by the client for instant
 * feedback and re-run by the server before persisting. Steps that collect no
 * answer (info, result, unknown types) always pass.
 */
export function validate(step: Step, value: unknown): ValidationResult {
  const rules = step.validation ?? {};
  const message = (key: string, fallback: string) => rules.messages?.[key] ?? fallback;
  const options = step.input?.options ?? [];

  switch (step.type) {
    case 'number': {
      const { min, max, step: increment } = step.input ?? {};
      if (isEmpty(value)) return rules.required ? fail(message('required', 'Enter a value.')) : OK;
      if (typeof value !== 'number' || !Number.isFinite(value)) return fail(message('type', 'Enter a number.'));
      if (typeof min === 'number' && value < min) return fail(message('min', `Enter a value of at least ${min}.`));
      if (typeof max === 'number' && value > max) return fail(message('max', `Enter a value of at most ${max}.`));
      if (typeof increment === 'number' && increment > 0) {
        const steps = (value - (typeof min === 'number' ? min : 0)) / increment;
        if (Math.abs(steps - Math.round(steps)) > 1e-9) {
          return fail(message('step', increment === 1 ? 'Enter a whole number.' : `Enter a value in steps of ${increment}.`));
        }
      }
      return OK;
    }
    case 'single-select': {
      if (isEmpty(value)) return rules.required ? fail(message('required', 'Select an option.')) : OK;
      if (typeof value !== 'string' || !options.some((o) => o.value === value)) {
        return fail(message('invalid', 'Select one of the listed options.'));
      }
      return OK;
    }
    case 'multi-select': {
      const selected = value === undefined || value === null ? [] : value;
      if (!Array.isArray(selected) || selected.some((v) => typeof v !== 'string' || !options.some((o) => o.value === v))) {
        return fail(message('invalid', 'Select from the listed options.'));
      }
      if (new Set(selected).size !== selected.length) return fail(message('invalid', 'Each option can be selected once.'));
      const min = rules.minSelections ?? (rules.required ? 1 : 0);
      if (selected.length < min) return fail(message('minSelections', message('required', `Choose at least ${min}.`)));
      if (rules.maxSelections !== undefined && selected.length > rules.maxSelections) {
        return fail(message('maxSelections', `Choose no more than ${rules.maxSelections}.`));
      }
      return OK;
    }
    default:
      return OK;
  }
}
