export type VideoIconKind =
  | 'play'
  | 'pause'
  | 'back'
  | 'forward'
  | 'repeat'
  | 'volume'
  | 'mute'
  | 'fullscreen'
  | 'exitFullscreen'
  | 'pip'
  | 'tracks';

export function VideoIcon({ kind }: { kind: VideoIconKind }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === 'play' ? (
        <path d="m9 5 11 7-11 7z" fill="currentColor" stroke="none" />
      ) : kind === 'pause' ? (
        <path d="M8 5v14M16 5v14" strokeWidth="3.5" />
      ) : kind === 'back' || kind === 'forward' ? (
        <>
          <g transform={kind === 'forward' ? 'translate(24 0) scale(-1 1)' : undefined}>
            <path d="M5 8h7a8 8 0 0 1 8 8M5 8l4-4M5 8l4 4" />
          </g>
          <text
            x="11"
            y="21"
            textAnchor="middle"
            fill="currentColor"
            stroke="none"
            fontSize="10"
            fontWeight="600"
          >
            10
          </text>
        </>
      ) : kind === 'repeat' ? (
        <path d="M4 10V7h16m-3-3 3 3-3 3M20 14v3H4m3-3-3 3 3 3" />
      ) : kind === 'fullscreen' ? (
        <path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5" />
      ) : kind === 'exitFullscreen' ? (
        <path d="M4 9h5V4m6 0v5h5M9 20v-5H4m11 5v-5h5" />
      ) : kind === 'tracks' ? (
        <path d="M4 14v-3a8 8 0 0 1 16 0v3M4 12H3v7h4v-7H4m16 0h1v7h-4v-7h3" />
      ) : kind === 'pip' ? (
        <>
          <rect x="3" y="5" width="18" height="14" rx="1.5" />
          <rect x="12" y="11" width="7" height="6" rx="0.5" fill="currentColor" stroke="none" />
        </>
      ) : (
        <>
          <path d="M4 9h4l5-4v14l-5-4H4z" />
          {kind === 'mute' ? (
            <path d="m17 9 5 6m0-6-5 6" />
          ) : (
            <path d="M17 8a6 6 0 0 1 0 8M20 5a10 10 0 0 1 0 14" />
          )}
        </>
      )}
    </svg>
  );
}
