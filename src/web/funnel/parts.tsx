import { useEffect, useId, useRef, type ReactNode } from 'react';
import type { AnswerValue, Step } from '@shared/types';

export interface StepError {
  message: string;
  /** Present for transport failures: re-runs the request that failed. */
  retry?: () => void;
}

/** Props shared by every answerable step component. */
export interface StepProps {
  step: Step;
  initial?: AnswerValue;
  busy: boolean;
  error: StepError | null;
  /** null on the first visible step. */
  onBack: (() => void) | null;
  onSubmit: (value?: AnswerValue) => void;
  /** Called when the draft changes, to clear a stale message. */
  onEdit: () => void;
}

export function useStepIds() {
  const base = useId();
  return { title: `${base}title`, text: `${base}text`, error: `${base}error`, unit: `${base}unit` };
}

export const describedBy = (...ids: Array<string | false | null | undefined>) => ids.filter(Boolean).join(' ') || undefined;

/** Eyebrow, title and supporting text. The title takes focus when a step mounts so the change is announced. */
export function StepHeading(props: { eyebrow?: string; title?: string; text?: string; titleId?: string; textId?: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div className="fn-heading">
      {props.eyebrow && <p className="fn-eyebrow">{props.eyebrow}</p>}
      <h1 ref={ref} id={props.titleId} className="fn-title" tabIndex={-1}>
        {props.title}
      </h1>
      {props.text && (
        <p id={props.textId} className="fn-text">
          {props.text}
        </p>
      )}
    </div>
  );
}

export function StepErrorMessage({ id, error, busy }: { id: string; error: StepError | null; busy: boolean }) {
  if (!error) return null;
  return (
    <div id={id} role="alert" className="fn-error">
      <span>{error.message}</span>
      {error.retry && (
        <button type="button" className="fn-retry" onClick={error.retry} disabled={busy}>
          Try again
        </button>
      )}
    </div>
  );
}

/** Back (when allowed) and the primary submit button. Pass `submitLabel={null}` for no submit. */
export function StepActions(props: { busy: boolean; onBack: (() => void) | null; submitLabel?: string | null; children?: ReactNode }) {
  const { busy, onBack, submitLabel = 'Continue', children } = props;
  return (
    <div className="fn-actions">
      {onBack && (
        <button type="button" className="fn-back" onClick={onBack} disabled={busy}>
          Back
        </button>
      )}
      {children}
      {submitLabel && (
        <button type="submit" className="primary fn-primary" disabled={busy} aria-busy={busy}>
          {submitLabel}
        </button>
      )}
    </div>
  );
}
