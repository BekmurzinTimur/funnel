import { StepActions, StepErrorMessage, StepHeading, useStepIds, type StepProps } from '../parts';

export default function InfoStep({ step, busy, error, onBack, onSubmit }: StepProps) {
  const ids = useStepIds();
  const content = step.content ?? {};
  return (
    <form
      className="fn-step"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <StepHeading eyebrow={content.eyebrow} title={content.title} text={content.body} titleId={ids.title} textId={ids.text} />
      <StepErrorMessage id={ids.error} error={error} busy={busy} />
      <StepActions busy={busy} onBack={onBack} submitLabel={content.primaryActionLabel || 'Continue'} />
    </form>
  );
}
