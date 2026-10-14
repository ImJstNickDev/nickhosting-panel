import type { ReactNode } from 'react';
import { Tooltip } from '../../../../components/tooltip.js';

const paths = {
  outline: 'M8 5h13M8 12h13M8 19h13M3 5h.01M3 12h.01M3 19h.01',
  find: 'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14m5-2 6 6',
  previous: 'm15 6-6 6 6 6',
  next: 'm9 6 6 6-6 6',
  close: 'm6 6 12 12M6 18 18 6',
  print: 'M7 8V3h10v5M6 17H3V9h18v8h-3M7 14h10v7H7zM17 11h.01',
  copy: 'M9 8h11v13H9zM15 8V3H4v13h5',
  metadata: 'M12 11v6m0-10h.01M21 12a9 9 0 1 0-18 0 9 9 0 0 0 18 0',
};
export function QuillButton({
  kind,
  label,
  onClick,
  pressed,
  disabled,
}: {
  kind: keyof typeof paths;
  label: string;
  onClick(): void;
  pressed?: boolean;
  disabled?: boolean;
}) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        className="quill-icon"
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d={paths[kind]} />
        </svg>
      </button>
    </Tooltip>
  );
}
export function QuillSkeleton() {
  return (
    <div className="quill-skeleton" aria-hidden="true">
      {Array.from({ length: 12 }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Fixed decorative skeleton lines never reorder.
        <span key={`line-${i}`} style={{ width: `${i % 4 === 0 ? 48 : 92 - (i % 3) * 10}%` }} />
      ))}
    </div>
  );
}
export function QuillFallback({ children }: { children: ReactNode }) {
  return <span className="quill-fallback">{children}</span>;
}
