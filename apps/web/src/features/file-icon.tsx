import { getGameFileIcon } from './integrations.js';
import './file-icon.css';

/** Filename remains the accessible label. These original icons are decorative. */
export function FileIcon({
  folder,
  name = '',
  gameId,
  archive = false,
}: {
  folder: boolean;
  name?: string;
  gameId?: string;
  archive?: boolean;
}) {
  const asset = folder ? undefined : getGameFileIcon(gameId, name);
  if (asset)
    return (
      <img
        className="fm-icon fm-type-game"
        src={asset}
        alt=""
        aria-hidden="true"
        draggable={false}
      />
    );
  const filename = name.toLowerCase().split('/').at(-1) ?? '';
  const extension = filename.includes('.') ? (filename.split('.').at(-1) ?? '') : '';
  const kind = folder
    ? 'folder'
    : extension === 'json'
      ? 'json'
      : extension === 'jar'
        ? 'jar'
        : ['properties', 'ini', 'cfg', 'conf', 'toml'].includes(extension)
          ? 'config'
          : ['yaml', 'yml'].includes(extension)
            ? 'yaml'
            : ['sh', 'bash', 'py', 'js', 'ts', 'lua', 'bat', 'ps1'].includes(extension)
              ? 'code'
              : ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'].includes(extension)
                ? 'image'
                : archive ||
                    ['zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar', 'tgz'].includes(extension)
                  ? 'archive'
                  : [
                        'dat',
                        'mca',
                        'mcr',
                        'nbt',
                        'db',
                        'sqlite',
                        'sqlite3',
                        'bin',
                        'class',
                      ].includes(extension)
                    ? 'binary'
                    : 'text';
  return (
    <svg
      className={`fm-icon fm-type-${kind} ${folder ? 'fm-icon-folder' : ''}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === 'folder' ? (
        <path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10H3Z" />
      ) : (
        <>
          <path d="M6 3h8l4 4v14H6Z M14 3v5h4" />
          {kind === 'json' ? (
            <path d="M10 10H9v3l-1 1 1 1v3h1m4-8h1v3l1 1-1 1v3h-1" />
          ) : kind === 'jar' ? (
            <path d="M8 12h6v4a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2Zm6 0h1a2 2 0 0 1 0 4h-1M11 7c-2 1 2 2 0 3" />
          ) : kind === 'config' ? (
            <path d="M9 11h6m-6 4h6m-4-6v4m2 0v4" />
          ) : kind === 'yaml' ? (
            <path d="M9 11h1m2 0h3m-6 3h1m2 0h3m-6 3h1m2 0h3" />
          ) : kind === 'code' ? (
            <path d="m10 11-2 3 2 3m4-6 2 3-2 3" />
          ) : kind === 'image' ? (
            <>
              <circle cx="10" cy="11" r="1" />
              <path d="m8 18 3-4 2 2 2-2 2 4" />
            </>
          ) : kind === 'archive' ? (
            <path d="M11 10h2m-2 3h2m-2 3h2" />
          ) : kind === 'binary' ? (
            <path d="M9 11h2v5H9Zm5 0v5m-1-4 1-1m-1 5h2" />
          ) : (
            <path d="M9 12h6m-6 4h6" />
          )}
        </>
      )}
    </svg>
  );
}
