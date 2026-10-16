import type { ReactNode } from 'react';

const paths = {
  lock: (
    <>
      <rect x="5" y="10" width="14" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" />
    </>
  ),
  shield: (
    <>
      <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="9" r="5" />
      <path d="m12 13 8 8m-3-3 3-3m-6 0 3-3" />
    </>
  ),
  screen: (
    <>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8m-4-4v4" />
    </>
  ),
  add: <path d="M12 5v14M5 12h14" />,
  exit: <path d="M9 4H4v16h5m5-13 5 5-5 5m-7-5h12" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="13" rx="2" />
      <path d="M16 8V3H3v13h5" />
    </>
  ),
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
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z" />
    </>
  ),
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
