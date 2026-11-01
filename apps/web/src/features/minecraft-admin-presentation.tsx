import { useT } from '../app/i18n.js';
import type { Combination } from './minecraft-admin-model.js';

export function MinecraftAdminIcon({
  kind,
}: {
  kind: 'more' | 'scan' | 'gateway' | 'sleep' | 'close' | 'chevron' | 'settings';
}) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === 'more' ? (
        <>
          <circle cx="5" cy="12" r="1" />
          <circle cx="12" cy="12" r="1" />
          <circle cx="19" cy="12" r="1" />
        </>
      ) : kind === 'gateway' ? (
        <>
          <path d="M4 20V5h16v15M8 20V9h8v11M2 20h20" />
          <path d="M12 12v5m-2-2 2 2 2-2" />
        </>
      ) : kind === 'sleep' ? (
        <path d="M20.5 13A8.5 8.5 0 0 1 11 3.5 8.5 8.5 0 1 0 20.5 13Z" />
      ) : kind === 'close' ? (
        <path d="m6 6 12 12M6 18 18 6" />
      ) : kind === 'chevron' ? (
        <path d="m9 5 7 7-7 7" />
      ) : kind === 'settings' ? (
        <>
          <path d="M4 7h16M4 17h16" />
          <circle cx="9" cy="7" r="3" />
          <circle cx="15" cy="17" r="3" />
        </>
      ) : (
        <path d="M4 8V4h4m8 0h4v4m0 8v4h-4m-8 0H4v-4M4 12h16" />
      )}
    </svg>
  );
}
export function CreationState({ choice }: { choice: Combination }) {
  const t = useT();
  const state = choice.creation?.state ?? 'blocked';
  return (
    <span className={`minecraft-creation-state minecraft-creation-${state}`}>
      {t(`versions.creation.${state}`)}
    </span>
  );
}
