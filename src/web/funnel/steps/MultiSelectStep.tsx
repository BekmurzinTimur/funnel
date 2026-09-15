import { useState } from 'react';
import { describedBy, StepActions, StepErrorMessage, StepHeading, useStepIds, type StepProps } from '../parts';

export default function MultiSelectStep({ step, initial, busy, error, onBack, onSubmit, onEdit }: StepProps) {
  const ids = useStepIds();
  const [draft, setDraft] = useState<string[]>(
    Array.isArray(initial) ? initial.filter((v): v is string => typeof v === 'string') : [],
  );
  const content = step.content ?? {};
  const options = step.input?.options ?? [];

  const toggle = (value: string) => {
    // Keep option order stable regardless of click order.
    setDraft((current) => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return options.map((o) => o.value).filter((v) => next.has(v));
    });
    onEdit();
  };

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
        role="group"
        className="fn-options"
        aria-labelledby={ids.title}
        aria-describedby={describedBy(content.helperText && ids.text, error && ids.error)}
      >
        {options.map((option) => {
          const checked = draft.includes(option.value);
          return (
            <label key={option.value} className={`fn-option fn-option-multi${checked ? ' is-selected' : ''}`}>
              <input type="checkbox" name={step.id} value={option.value} checked={checked} onChange={() => toggle(option.value)} />
              <span>{option.label}</span>
            </label>
          );
        })}
      </div>
      <StepErrorMessage id={ids.error} error={error} busy={busy} />
      <StepActions busy={busy} onBack={onBack} submitLabel={content.primaryActionLabel || 'Continue'} />
    </form>
  );
}
