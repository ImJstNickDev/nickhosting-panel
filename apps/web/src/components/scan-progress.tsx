import type { ReactNode } from 'react';

/** Shared scan UI: only acknowledged progress, with independently scrollable logs.
 * Callers own localized copy and estimates; this component never invents progress. */
export function ScanProgress({
  label,
  status,
  completed,
  total,
  estimate,
  logLabel,
  children,
}: {
  label: string;
  status: string;
  completed?: number;
  total?: number;
  estimate?: string;
  logLabel: string;
  children?: ReactNode;
}) {
  return (
    <div className="stack catalog-progress">
      <progress
        aria-label={label}
        max={Math.max(1, total ?? 1)}
        value={completed === undefined ? undefined : total === 0 ? 1 : completed}
      />
      <p role="status">{status}</p>
      {estimate && <p className="muted">{estimate}</p>}
      {children && (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll the bounded log.
        <div role="log" aria-label={logLabel} aria-live="off" tabIndex={0} className="catalog-log">
          {children}
        </div>
      )}
    </div>
  );
}
