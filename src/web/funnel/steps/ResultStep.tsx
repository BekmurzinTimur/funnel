import { useId, useState } from 'react';
import type { ResultDefinition, Step } from '@shared/types';
import { StepActions, StepErrorMessage, StepHeading, type StepError } from '../parts';

interface Props {
  step: Step;
  /** Resolved by the server (`resultId`); the client never derives it. */
  result: ResultDefinition | undefined;
  busy: boolean;
  error: StepError | null;
  onBack: (() => void) | null;
  /** `expanding` is true when this click opens the recommendations. */
  onCta: (action: string, expanding: boolean) => void;
  /** Re-fetch the session (resume) when the result is missing. */
  onReload: () => void;
}

export default function ResultStep({ step, result, busy, error, onBack, onCta, onReload }: Props) {
  const listId = useId();
  const errorId = useId();
  const cta = result?.cta;
  // Without a CTA nothing could reveal the list, so show it straight away.
  const [expanded, setExpanded] = useState(!cta);

  if (!result) {
    return (
      <div className="fn-step">
        <StepHeading title={step.content?.errorTitle || 'We could not build the recommendation'} />
        <StepActions busy={busy} onBack={onBack} submitLabel={null}>
          <button type="button" className="primary fn-primary" onClick={onReload} disabled={busy}>
            {step.content?.retryLabel || 'Try again'}
          </button>
        </StepActions>
      </div>
    );
  }

  const expands = cta?.action === 'expand_recommendation';
  const recommendations = result.recommendations ?? [];

  return (
    <div className="fn-step">
      <StepHeading eyebrow={step.content?.eyebrow || 'Your result'} title={result.title} text={result.summary} />
      {cta && (
        <button
          type="button"
          className="primary fn-primary fn-cta"
          disabled={busy}
          aria-expanded={expands ? expanded : undefined}
          aria-controls={expands ? listId : undefined}
          onClick={() => {
            onCta(cta.action, expands && !expanded);
            if (expands) setExpanded((open) => !open);
          }}
        >
          {cta.label}
        </button>
      )}
      {expanded && recommendations.length > 0 && (
        <ol id={listId} className="fn-recommendations">
          {recommendations.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ol>
      )}
      <StepErrorMessage id={errorId} error={error} busy={busy} />
      {onBack && <StepActions busy={busy} onBack={onBack} submitLabel={null} />}
    </div>
  );
}
