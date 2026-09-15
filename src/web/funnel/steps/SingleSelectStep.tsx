import { useState } from 'react';
import { describedBy, StepActions, StepErrorMessage, StepHeading, useStepIds, type StepProps } from '../parts';

export default function SingleSelectStep({ step, initial, busy, error, onBack, onSubmit, onEdit }: StepProps) {
  const ids = useStepIds();
  const [draft, setDraft] = useState<string | undefined>(typeof initial === 'string' ? initial : undefined);
  const content = step.content ?? {};
  const options = step.input?.options ?? [];
  return (
    <form
      className="fn-step"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(draft);
      }}
    >
      <StepHeading eyebrow={content.eyebrow} title={content.title} text={content.helperText} titleId={ids.title} textId={ids.text} />
      <div
        role="radiogroup"
        className="fn-options"
        aria-labelledby={ids.title}
        aria-describedby={describedBy(content.helperText && ids.text, error && ids.error)}
        aria-invalid={error ? true : undefined}
      >
        {options.map((option) => (
          <label key={option.value} className={`fn-option${draft === option.value ? ' is-selected' : ''}`}>
            <input
              type="radio"
              name={step.id}
              value={option.value}
              checked={draft === option.value}
              onChange={() => {
                setDraft(option.value);
                onEdit();
              }}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
      <StepErrorMessage id={ids.error} error={error} busy={busy} />
      <StepActions busy={busy} onBack={onBack} submitLabel={content.primaryActionLabel || 'Continue'} />
    </form>
  );
}
