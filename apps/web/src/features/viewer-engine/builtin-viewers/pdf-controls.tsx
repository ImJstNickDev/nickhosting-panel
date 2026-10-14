import type { ReactNode } from 'react';
import { Tooltip } from '../../../components/tooltip.js';
export function PdfButton({
  label,
  children,
  onClick,
  disabled,
  pressed,
}: {
  label: string;
  children: ReactNode;
  onClick(): void;
  disabled?: boolean;
  pressed?: boolean;
}) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        className="folio-button"
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </button>
    </Tooltip>
  );
}
export function PdfIcon({
  name,
}: {
  name:
    | 'thumbnails'
    | 'outline'
    | 'previous'
    | 'next'
    | 'minus'
    | 'plus'
    | 'width'
    | 'fit'
    | 'actual'
    | 'rotate'
    | 'find'
    | 'close'
    | 'print'
    | 'refresh';
}) {
  const paths: Record<typeof name, ReactNode> = {
    thumbnails: (
      <>
        <rect x="4" y="3" width="6" height="7" rx="1" />
        <rect x="14" y="3" width="6" height="7" rx="1" />
        <rect x="4" y="14" width="6" height="7" rx="1" />
        <rect x="14" y="14" width="6" height="7" rx="1" />
      </>
    ),
    outline: (
      <>
        <path d="M8 5h12M8 12h12M8 19h12M3 5h1M3 12h1M3 19h1" />
      </>
    ),
    previous: <path d="m14 6-6 6 6 6" />,
    next: <path d="m10 6 6 6-6 6" />,
    minus: <path d="M5 12h14" />,
    plus: <path d="M5 12h14M12 5v14" />,
    width: (
      <>
        <path d="M3 4v16M21 4v16M4 12h16m-13-3-3 3 3 3m10-6 3 3-3 3" />
      </>
    ),
    fit: (
      <>
        <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />
        <rect x="8" y="6" width="8" height="12" rx="1" />
      </>
    ),
    actual: (
      <>
        <path d="M4 8h2v8M11 8h2v8M17 8h2v8M9 10v.1M9 14v.1M15 10v.1M15 14v.1" />
      </>
    ),
    rotate: (
      <>
        <path d="M3 9a9 9 0 1 1 1 9M3 3v6h6" />
      </>
    ),
    find: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 5 5" />
      </>
    ),
    close: <path d="m6 6 12 12M6 18 18 6" />,
    refresh: (
      <>
        <path d="M20 7v5h-5M4 17v-5h5M5 8a7 7 0 0 1 12-3l3 3M4 16l3 3a7 7 0 0 0 12-3" />
      </>
    ),
    print: (
      <>
        <path d="M7 8V3h10v5M7 17H4V8h16v9h-3" />
        <rect x="7" y="14" width="10" height="7" />
        <path d="M16 11h1" />
      </>
    ),
  };
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
