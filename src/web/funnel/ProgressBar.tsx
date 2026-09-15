import type { Progress } from '@shared/types';

/** Renders the server's progress verbatim. The label is hidden on excluded steps before the first question (current === 0). */
export default function ProgressBar({ progress, complete }: { progress: Progress; complete: boolean }) {
  const { current, total } = progress;
  const percent = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
  const label = complete ? 'All questions answered' : current > 0 ? `Question ${current} of ${total}` : null;
  return (
    <div className="fn-progress">
      <div
        className="fn-progress-track"
        role="progressbar"
        aria-label="Progress"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={current}
        aria-valuetext={label ?? 'Not started'}
      >
        <div className="fn-progress-fill" style={{ width: `${percent}%` }} />
      </div>
      {label && <p className="fn-progress-label">{label}</p>}
    </div>
  );
}
