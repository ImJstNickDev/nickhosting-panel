import type { ViewerId } from './core/registry.js';

/** Small first-party marks; trusted game viewers receive a neutral extension mark. */
export function ViewerIcon({ id }: { id: ViewerId }) {
  return (
    <svg
      viewBox="0 0 32 32"
      width="32"
      height="32"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {id === 'text' ? (
        <>
          <path d="M7 5h12l6 6v8M19 5v7h6M7 5v22h8M11 13h4M11 18h3" />
          <path d="m18 24 7-7 3 3-7 7-4 1zM23 19l3 3" />
        </>
      ) : id === 'image' ? (
        <>
          <path d="M11 5H5v6M21 5h6v6M5 21v6h6M27 21v6h-6M8 22l7-8 5 6 3-3 4 5" />
          <circle cx="22" cy="10" r="2" />
        </>
      ) : id === 'audio' ? (
        <path d="M5 13v6M10 8v16M16 4v24M22 9v14M27 13v6" />
      ) : id === 'video' ? (
        <>
          <rect x="6" y="5" width="21" height="22" rx="4" />
          <path d="m14 11 8 5-8 5zM2 10h4M2 16h4M2 22h4" />
        </>
      ) : id === 'archive' ? (
        <>
          <path d="m5 7 7-3 8 3 7-3v21l-7 3-8-3-7 3zM12 4v21M20 7v21" />
          <path d="m9 15 7-4 8 6M21 14l3 3-3 2" />
        </>
      ) : id === 'sqlite' ? (
        <>
          <rect x="4" y="5" width="24" height="22" rx="3" />
          <path d="M4 12h24M4 19h24M12 12v15M20 12v15M9 8.5h3" />
        </>
      ) : id === 'json' ? (
        <>
          <path d="M8 10v14h5M8 16h13" />
          <rect x="4" y="3" width="8" height="7" rx="2" />
          <rect x="21" y="12" width="7" height="7" rx="2" />
          <rect x="13" y="21" width="9" height="7" rx="2" />
        </>
      ) : (
        <>
          <rect x="5" y="5" width="22" height="22" rx="5" />
          <path d="m11 12-4 4 4 4m10-8 4 4-4 4m-4-10-2 12" />
        </>
      )}
    </svg>
  );
}
