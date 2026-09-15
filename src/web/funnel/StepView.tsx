import type { AnswerValue, Answers, MaterialisedConfig } from '@shared/types';
import type { StepError } from './parts';
import InfoStep from './steps/InfoStep';
import MultiSelectStep from './steps/MultiSelectStep';
import NumberStep from './steps/NumberStep';
import ResultStep from './steps/ResultStep';
import SingleSelectStep from './steps/SingleSelectStep';
import UnknownStep from './steps/UnknownStep';

interface Props {
  config: MaterialisedConfig;
  stepId: string | null;
  answers: Answers;
  resultId: string | null;
  busy: boolean;
  error: StepError | null;
  onBack: (() => void) | null;
  onSubmit: (value?: AnswerValue) => void;
  onEdit: () => void;
  onCta: (action: string, expanding: boolean) => void;
  onReload: () => void;
  onStartOver: () => void;
}

/** Picks a component by step type. Knows nothing about variants — `config` is already materialised. */
export default function StepView(props: Props) {
  const { config, stepId, answers, resultId, busy, error, onBack, onSubmit, onEdit } = props;
  const common = { busy, error, onBack, onSubmit, onEdit };

  if (!stepId) {
    return (
      <div className="fn-step">
        <div className="fn-heading">
          <h1 className="fn-title">There's nothing to show right now</h1>
          <p className="fn-text">This session has no active step. Start over to begin again.</p>
        </div>
        <div className="fn-actions">
          <button type="button" className="primary fn-primary" onClick={props.onStartOver} disabled={busy}>
            Start over
          </button>
        </div>
      </div>
    );
  }

  const step = config.steps[stepId];
  if (!step) return <UnknownStep {...common} />;
  const initial = answers[stepId];

  switch (step.type) {
    case 'info':
      return <InfoStep step={step} {...common} />;
    case 'single-select':
      return <SingleSelectStep step={step} initial={initial} {...common} />;
    case 'multi-select':
      return <MultiSelectStep step={step} initial={initial} {...common} />;
    case 'number':
      return <NumberStep step={step} initial={initial} {...common} />;
    case 'result':
      return (
        <ResultStep
          step={step}
          result={resultId ? config.results[resultId] : undefined}
          busy={busy}
          error={error}
          onBack={onBack}
          onCta={props.onCta}
          onReload={props.onReload}
        />
      );
    default:
      return <UnknownStep {...common} />;
  }
}
