import { defineTrustedFilemanExtension } from '@nickhosting/game-sdk/ui';
import { satisfactoryFileKind, satisfactoryFileLocations } from '@nickhosting/satisfactory/ui';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { queryClient } from '../../api/client.js';
import { useT } from '../../app/i18n.js';
import { Tooltip } from '../../components/tooltip.js';
import { ErrorNotice } from '../../components/ui.js';
import { useFilemanNavigation } from '../../features/fileman/host.js';
import { fileDirectoryQuery } from '../../features/service-contracts.js';
import { availableGameDirectories, gameDirectoryExists } from './fileman-location.js';
import './fileman.css';

const key = (name: string) => `games.satisfactory.fileman.${name}`;
function WorldsLink({ serverId }: { serverId: string }) {
  const t = useT();
  const { sections } = useFilemanNavigation();
  if (!sections.includes('worlds')) return null;
  return (
    <Tooltip placement="cursor" content={t(key('worlds'))}>
      <Link
        className="fm-tool"
        aria-label={t(key('worlds'))}
        to={`/servers/${encodeURIComponent(serverId)}/game/worlds`}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z" />
        </svg>
      </Link>
    </Tooltip>
  );
}
function Locations({ serverId }: { serverId: string }) {
  const t = useT();
  const { navigateDirectory } = useFilemanNavigation();
  const pending = useRef<AbortController | undefined>(undefined);
  const [checking, setChecking] = useState(false);
  const [available, setAvailable] = useState<(typeof satisfactoryFileLocations)[number][]>([]);
  const [error, setError] = useState<unknown>();
  const refresh = useCallback(
    async (fresh: boolean) => {
      if (pending.current && !pending.current.signal.aborted) return;
      const controller = new AbortController();
      pending.current = controller;
      const identity = JSON.stringify(fileDirectoryQuery(serverId, '').queryKey[3]);
      try {
        const locations = await availableGameDirectories(
          satisfactoryFileLocations,
          async (parent) => {
            const assertCurrent = () => {
              if (identity !== JSON.stringify(fileDirectoryQuery(serverId, '').queryKey[3]))
                controller.abort();
              controller.signal.throwIfAborted();
            };
            assertCurrent();
            const entries = await queryClient.fetchQuery({
              ...fileDirectoryQuery(serverId, parent, { prepareDownloads: false }),
              staleTime: fresh ? 0 : 15_000,
            });
            assertCurrent();
            return entries;
          },
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setAvailable(locations);
          setError(undefined);
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          setAvailable([]);
          setError(failure);
        }
      } finally {
        if (pending.current === controller) pending.current = undefined;
      }
    },
    [serverId],
  );
  useEffect(() => {
    void refresh(false);
    return () => pending.current?.abort();
  }, [refresh]);
  async function openDirectory(target: string) {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setChecking(true);
    setError(undefined);
    const identity = JSON.stringify(fileDirectoryQuery(serverId, '').queryKey[3]);
    const checkIdentity = () => {
      if (identity !== JSON.stringify(fileDirectoryQuery(serverId, '').queryKey[3]))
        controller.abort();
      controller.signal.throwIfAborted();
    };
    try {
      const exists = await gameDirectoryExists(
        target,
        async (parent) => {
          checkIdentity();
          const entries = await queryClient.fetchQuery({
            ...fileDirectoryQuery(serverId, parent, { prepareDownloads: false }),
            staleTime: 0,
          });
          checkIdentity();
          return entries;
        },
        controller.signal,
      );
      if (!controller.signal.aborted) {
        if (exists) navigateDirectory?.(target);
        else setAvailable((items) => items.filter((item) => item.path !== target));
      }
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure);
    } finally {
      if (pending.current === controller) {
        setChecking(false);
        pending.current = undefined;
      }
    }
  }
  if (!navigateDirectory) return null;
  return (
    <div className="fm-tools satisfactory-file-locations">
      <label>
        <span className="sr-only">{t(key('locations'))}</span>
        <select
          aria-label={t(key('locations'))}
          value=""
          disabled={checking}
          onFocus={() => void refresh(true)}
          onPointerDown={() => void refresh(true)}
          onChange={(event) => {
            const location = satisfactoryFileLocations.find(
              (item) => item.id === event.target.value,
            );
            if (location) void openDirectory(location.path);
          }}
        >
          <option value="" disabled>
            {t(key('locations'))}
          </option>
          {available.map((item) => (
            <option key={item.id} value={item.id}>
              {t(key(item.id))}
            </option>
          ))}
        </select>
      </label>
      <WorldsLink serverId={serverId} />
      {Boolean(error) && <ErrorNotice error={error} />}
    </div>
  );
}
function ClassifiedIcon({ name, original }: { name: string; original: ReactNode }) {
  const t = useT();
  const kind = satisfactoryFileKind(name);
  if (!kind) return original;
  return (
    <Tooltip placement="cursor" content={t(key(`kind.${kind}`))}>
      <svg
        className={`fm-icon fm-type-${kind === 'configuration' ? 'config' : kind === 'modManifest' ? 'json' : 'binary'}`}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        role="img"
        aria-label={t(key(`kind.${kind}`))}
      >
        <path d="M6 3h8l4 4v14H6V3Zm8 0v5h4" />
        {kind === 'save' ? (
          <path d="M9 11h6v7H9v-7Zm2 0v3h2v-3" />
        ) : kind === 'blueprint' ? (
          <path d="m9 13 3-2 3 2v4l-3 2-3-2v-4Zm0 0 3 2 3-2m-3 2v4" />
        ) : kind === 'configuration' ? (
          <path d="M9 12h6m-6 4h6m-4-6v4m2 0v4" />
        ) : kind === 'modManifest' ? (
          <path d="M10 11H9v7h1m4-7h1v7h-1" />
        ) : (
          <path d="M9 11h6m-6 3h6m-6 3h4" />
        )}
      </svg>
    </Tooltip>
  );
}
export const satisfactoryFilemanExtension = defineTrustedFilemanExtension<ReactNode>(
  { id: 'satisfactory:files', gameId: 'satisfactory' },
  [
    {
      slot: 'breadcrumb',
      mode: 'append',
      when: (context) => context.surface === 'directory',
      render: (context) => (
        <Locations key={`${context.serverId}:${context.path}`} serverId={context.serverId} />
      ),
    },
    {
      slot: 'entry.icon',
      mode: 'decorate',
      when: (context) => Boolean(context.entry && !context.entry.directory),
      render: (context, original) => (
        <ClassifiedIcon name={context.entry?.name ?? ''} original={original} />
      ),
    },
    {
      slot: 'viewer.actions',
      mode: 'append',
      when: (context) =>
        context.viewerId === 'satisfactory:save' &&
        satisfactoryFileKind(context.entry?.name ?? context.path.split('/').at(-1) ?? '') ===
          'save',
      render: (context) => <WorldsLink serverId={context.serverId} />,
    },
  ],
);
