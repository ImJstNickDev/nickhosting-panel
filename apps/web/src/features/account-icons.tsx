import type { ReactNode } from 'react';

const paths = {
  camera: (
    <>
      <path d="M8 6 9.5 4h5L16 6h3a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z" />
      <circle cx="12" cy="12.5" r="3.5" />
    </>
  ),
  remove: (
    <>
      <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5m4-5v5" />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="m4 7 8 6 8-6" />
    </>
  ),
  discord: (
    <>
      <path d="M8 6h8a4 4 0 0 1 3.8 3L21 15a3 3 0 0 1-5 2l-2-2h-4l-2 2a3 3 0 0 1-5-2l1.2-6A4 4 0 0 1 8 6Z" />
      <path d="M7 9v4m-2-2h4m6 0h.01M18 11h.01" />
    </>
  ),
  edit: (
    <>
      <path d="m14 5 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14Z" />
    </>
  ),
  unlink: (
    <>
      <path d="m9 15-2 2a3 3 0 0 1-4-4l2-2m10-2 2-2a3 3 0 0 1 4 4l-2 2M4 4l16 16M7 3v3M3 7h3m12 11h3m-3 0v3" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
} satisfies Record<string, ReactNode>;

export function AccountIcon({ name }: { name: keyof typeof paths }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
