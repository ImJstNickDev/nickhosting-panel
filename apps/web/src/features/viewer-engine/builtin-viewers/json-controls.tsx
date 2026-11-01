import type { ReactNode } from 'react';
import { Tooltip } from '../../../components/tooltip.js';

export function JsonIcon({
  kind,
}: {
  kind:
    | 'previous'
    | 'next'
    | 'expand'
    | 'collapse'
    | 'detail'
    | 'copy'
    | 'path'
    | 'raw'
    | 'close'
    | 'search';
}) {
  const paths = {
    previous: 'm14 6-6 6 6 6',
    next: 'm10 6 6 6-6 6',
    expand: 'M4 4h16v16H4zM8 12h8m-4-4v8',
    collapse: 'M4 4h16v16H4zM8 12h8',
    detail: 'M3 4h18v16H3zM14 4v16M7 8h3m-3 4h3',
    copy: 'M9 8h11v13H9zM15 8V3H4v13h5',
    path: 'M10 13a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-2 2M14 11a4 4 0 0 0-6 0l-4 4a4 4 0 0 0 6 6l2-2',
    raw: 'm8 6-5 6 5 6m8-12 5 6-5 6m-3-15-2 18',
    close: 'm6 6 12 12M6 18 18 6',
    search: 'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14m5-2 6 6',
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[kind]} />
    </svg>
  );
}
export function JsonButton({
  label,
  kind,
  onClick,
  disabled = false,
  preserveFocus = false,
}: {
  label: string;
  kind: Parameters<typeof JsonIcon>[0]['kind'];
  onClick: () => void;
  disabled?: boolean;
  preserveFocus?: boolean;
}) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        className="jt-icon"
        aria-label={label}
        disabled={disabled && !preserveFocus}
        aria-disabled={disabled || undefined}
        onClick={() => {
          if (!disabled) onClick();
        }}
      >
        <JsonIcon kind={kind} />
      </button>
    </Tooltip>
  );
}
export function JsonSkeleton({ label }: { label: string }) {
  return (
    <div className="jt-skeleton" role="status" aria-label={label}>
      {Array.from({ length: 12 }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Fixed decorative skeleton rows never reorder.
        <div key={index} style={{ marginLeft: index % 4 === 0 ? 12 : 34 }} />
      ))}
    </div>
  );
}
export function JsonFeedback({ children }: { children: ReactNode }) {
  return <div className="jt-feedback">{children}</div>;
}
