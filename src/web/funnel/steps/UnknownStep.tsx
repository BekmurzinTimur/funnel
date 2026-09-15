import { StepActions, StepErrorMessage, StepHeading, useStepIds, type StepProps } from '../parts';

/** SPEC §11 defence in depth: a step type this build cannot render is skippable, never a crash. */
export default function UnknownStep({ busy, error, onBack, onSubmit }: Omit<StepProps, 'step'>) {
  const ids = useStepIds();
  return (
    <form
      className="fn-step"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <StepHeading
        title="This step isn't available in this version"
        text="You can skip it and carry on with the rest of the questions."
        titleId={ids.title}
        textId={ids.text}
      />
      <StepErrorMessage id={ids.error} error={error} busy={busy} />
      <StepActions busy={busy} onBack={onBack} />
    </form>
  );
}
