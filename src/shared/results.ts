import { evaluate } from './conditions';
import { visibleAnswers } from './navigation';
import type { Answers, MaterialisedConfig } from './types';

/**
 * First matching rule in array order wins; otherwise `defaultResultId`.
 * Only answers for currently visible steps are considered, so an orphaned
 * answer from an abandoned branch cannot select a result.
 */
export function resolveResult(config: MaterialisedConfig, answers: Answers): string {
  const effective = visibleAnswers(config, answers);
  for (const rule of config.resultRules) {
    if (evaluate(rule.when, effective)) return rule.resultId;
  }
  return config.defaultResultId;
}
