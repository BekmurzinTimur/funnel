import { useState } from 'react';
import { describedBy, StepActions, StepErrorMessage, StepHeading, useStepIds, type StepProps } from '../parts';

export default function NumberStep({ step, initial, busy, error, onBack, onSubmit, onEdit }: StepProps) {
  const ids = useStepIds();
  const [raw, setRaw] = useState(typeof initial === 'number' ? String(initial) : '');
  const content = step.content ?? {};
  const { min, max, step: increment, unit } = step.input ?? {};
  const integer = increment === undefined || Number.isInteger(increment);

  return (
    <form
      className="fn-step"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        // Empty → undefined (validate reports "required"); otherwise a number, possibly NaN for validate to reject.
        onSubmit(raw.trim() === '' ? undefined : Number(raw));
      }}
    >
      <StepHeading eyebrow={content.eyebrow} title={content.title} text={content.helperText} titleId={ids.title} textId={ids.text} />
      <div className="fn-number">
        <input
          type="number"
          inputMode={integer && (min === undefined || min >= 0) ? 'numeric' : 'decimal'}
          name={step.id}
          min={min}
          max={max}
          step={increment}
          value={raw}
          onChange={(e) => {
            setRaw(e.target.value);
            onEdit();
          }}
          aria-labelledby={ids.title}
          aria-describedby={describedBy(unit && ids.unit, content.helperText && ids.text, error && ids.error)}
          aria-invalid={error ? true : undefined}
        />
        {unit && (
          <span id={ids.unit} className="fn-unit">
            {unit}
          </span>
        )}
      </div>
      <StepErrorMessage id={ids.error} error={error} busy={busy} />
      <StepActions busy={busy} onBack={onBack} submitLabel={content.primaryActionLabel || 'Continue'} />
    </form>
  );
}
