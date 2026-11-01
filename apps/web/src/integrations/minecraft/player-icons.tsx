export function PlayerIcon({
  name,
}: {
  name: 'search' | 'refresh' | 'op' | 'whitelist' | 'ban' | 'kick' | 'edit' | 'plus';
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === 'search' && (
        <>
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m16 16 4 4" />
        </>
      )}
      {name === 'refresh' && (
        <>
          <path d="M20 7v5h-5M4 17v-5h5" />
          <path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1" />
        </>
      )}
      {name === 'op' && (
        <>
          <path d="m12 3 8 3v6c0 4-8 9-8 9s-8-5-8-9V6z" />
          <path d="m8 12 3 3 5-6" />
        </>
      )}
      {name === 'whitelist' && <path d="M9 5H5v15h14v-5M9 3h6v4H9zM10 13l3 3 8-8" />}
      {name === 'ban' && (
        <>
          <circle cx="12" cy="12" r="8" />
          <path d="m6 6 12 12" />
        </>
      )}
      {name === 'kick' && <path d="M10 4H4v16h6M9 12h12m-5-5 5 5-5 5" />}
      {name === 'edit' && <path d="m4 16 12-12 4 4L8 20H4zM13 7l4 4" />}
      {name === 'plus' && <path d="M12 5v14M5 12h14" />}
    </svg>
  );
}
