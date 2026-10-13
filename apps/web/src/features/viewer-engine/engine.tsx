import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { download } from '../../api/client.js';
import { useT } from '../../app/i18n.js';
import { Tooltip } from '../../components/tooltip.js';
import { ErrorNotice } from '../../components/ui.js';
import { serverPath } from '../service-contracts.js';
import { viewerPath } from './core/access.js';
import { ViewerBoundary } from './core/boundary.js';
import { preferredViewer, type ViewerId } from './core/registry.js';
import type { ArchiveExtraction, ViewerProps } from './core/types.js';
import { ViewerLoading } from './loading.js';
import { OpenWith, OpenWithIcon } from './open-with.js';
import { useViewerPreferences } from './preferences.js';
import { gameViewerRegistry, gameViewerRenderer } from './trusted-viewers.js';
import './viewer.css';

const Image = lazy(() => import('./builtin-viewers/image.js'));
const Media = lazy(() => import('./builtin-viewers/media.js'));
const Json = lazy(() => import('./builtin-viewers/json.js'));
const Sqlite = lazy(() => import('./builtin-viewers/sqlite.js'));
const Archive = lazy(() => import('./builtin-viewers/archive.js'));
const Text = lazy(() => import('./builtin-viewers/text.js'));

export function FileViewer({
  source: initial,
  viewerId,
  serverId,
  identity,
  onText,
  onExtract,
  onViewerChange,
  actionTargets,
}: Omit<ViewerProps, 'onOpen'> & {
  viewerId?: ViewerId;
  onText: () => void;
  onExtract?: (selection?: ArchiveExtraction) => void;
  onViewerChange?: (viewerId: ViewerId) => void;
  actionTargets: {
    beforeHome: HTMLElement | null;
    afterHome: HTMLElement | null;
    breadcrumb?: HTMLElement | null;
  };
}) {
  const t = useT();
  const [source, setSource] = useState(initial);
  const containers = useRef([initial]);
  const [archiveDirectory, setArchiveDirectory] = useState('');
  const [viewer, setViewer] = useState<ViewerId | undefined>(viewerId);
  const [choosing, setChoosing] = useState(false);
  const chooserTrigger = useRef<HTMLButtonElement>(null);
  const preferences = useViewerPreferences(serverId, identity);
  const region = useRef<HTMLElement>(null);
  useEffect(() => {
    region.current?.focus({ preventScroll: true });
  }, []);
  function archiveAt(depth: number, directory = '') {
    const archives = (source.archives ?? []).slice(0, depth);
    setSource({ ...(containers.current[depth] ?? initial), archives, entry: undefined });
    containers.current = containers.current.slice(0, depth + 1);
    setArchiveDirectory(directory);
    setViewer('archive');
  }
  function choose(id: ViewerId) {
    setChoosing(false);
    if (id === 'text' && !source.entry && !source.archives?.length) {
      onText();
      return;
    }
    if (id === 'archive' && source.entry) {
      const next = {
        ...source,
        archives: [...(source.archives ?? []), source.entry],
        entry: undefined,
      };
      containers.current = [...containers.current.slice(0, next.archives.length), next];
      setSource(next);
      setArchiveDirectory('');
    }
    if (id !== 'archive' && !source.entry && source.archives?.length) {
      setSource({
        ...source,
        archives: source.archives.slice(0, -1),
        entry: source.archives.at(-1),
      });
      setArchiveDirectory(source.archives.at(-1)?.split('/').slice(0, -1).join('/') ?? '');
    }
    setViewer(id);
    if (!source.entry && !source.archives?.length) onViewerChange?.(id);
  }
  const props: ViewerProps = {
    source,
    serverId,
    identity,
    archiveDirectory,
    onArchiveDirectory: setArchiveDirectory,
    onExtract,
    onArchiveBack: source.archives?.length
      ? () => {
          const member = source.archives?.at(-1) ?? '';
          archiveAt((source.archives?.length ?? 1) - 1, member.split('/').slice(0, -1).join('/'));
        }
      : undefined,
    onOpen: (next) => {
      next = { ...next, gameId: initial.gameId };
      if (next.entry) setArchiveDirectory(next.entry.split('/').slice(0, -1).join('/'));
      const preferred = preferredViewer(next, preferences.data?.preferences);
      if (preferred === 'archive' && next.entry) {
        next = { ...next, archives: [...(next.archives ?? []), next.entry], entry: undefined };
        containers.current = [...containers.current.slice(0, next.archives?.length), next];
        setArchiveDirectory('');
      }
      setSource(next);
      setViewer(preferred);
    },
  };
  const key = JSON.stringify([
    source.path,
    source.archives,
    source.entry,
    viewer,
    viewer === 'archive' ? archiveDirectory : undefined,
  ]);
  const archiveDepth = source.archives?.length ?? 0;
  const insideArchive = viewer === 'archive' || Boolean(source.entry) || archiveDepth > 0;
  const directoryParts = (
    source.entry ? source.entry.split('/').slice(0, -1).join('/') : archiveDirectory
  )
    .split('/')
    .filter(Boolean);
  const GameViewer = viewer ? gameViewerRenderer(viewer) : undefined;
  const gameLabel = viewer ? gameViewerRegistry.get(viewer)?.descriptor.labelKey : undefined;
  return (
    <section
      className="ve-engine"
      ref={region}
      tabIndex={-1}
      aria-label={t(
        gameLabel ??
          (viewer === 'text' ? 'file.editor' : viewer ? `viewer.${viewer}` : 'viewer.open'),
      )}
    >
      {(viewer === 'json' || (viewer === 'text' && source.entry)) && (
        <span className="sr-only">{t('viewer.readOnly')}</span>
      )}
      {actionTargets.breadcrumb &&
        createPortal(
          <>
            <li>
              {insideArchive ? (
                <button
                  type="button"
                  className="text-button"
                  aria-current={
                    !archiveDepth && !source.entry && !archiveDirectory ? 'page' : undefined
                  }
                  onClick={() => archiveAt(0)}
                >
                  {initial.name}
                </button>
              ) : (
                <span className="fm-current-file" aria-current="page">
                  {source.name}
                </span>
              )}
            </li>
            {(source.archives ?? []).flatMap((member, depth) =>
              member.split('/').map((part, index, all) => (
                <li
                  key={JSON.stringify([source.archives?.slice(0, depth), all.slice(0, index + 1)])}
                >
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      index === all.length - 1
                        ? archiveAt(depth + 1)
                        : archiveAt(depth, all.slice(0, index + 1).join('/'))
                    }
                    aria-current={
                      depth === archiveDepth - 1 &&
                      index === all.length - 1 &&
                      !source.entry &&
                      !archiveDirectory
                        ? 'page'
                        : undefined
                    }
                  >
                    {part}
                  </button>
                </li>
              )),
            )}
            {insideArchive &&
              directoryParts.map((part, index) => (
                <li key={`directory:${directoryParts.slice(0, index + 1).join('/')}`}>
                  <button
                    type="button"
                    className="text-button"
                    aria-current={
                      !source.entry && index === directoryParts.length - 1 ? 'page' : undefined
                    }
                    onClick={() =>
                      archiveAt(archiveDepth, directoryParts.slice(0, index + 1).join('/'))
                    }
                  >
                    {part}
                  </button>
                </li>
              ))}
            {source.entry && (
              <li>
                <span className="fm-current-file" aria-current="page">
                  {source.name}
                </span>
              </li>
            )}
          </>,
          actionTargets.breadcrumb,
        )}
      {actionTargets.beforeHome &&
        createPortal(
          <>
            {onExtract && viewer === 'archive' && !source.entry && (
              <button
                type="button"
                className="fm-viewer-action"
                onClick={() => onExtract({ archives: source.archives })}
              >
                {t('file.extract')}
              </button>
            )}
            <Tooltip placement="cursor" content={t('viewer.openWith')}>
              <button
                ref={chooserTrigger}
                type="button"
                className="fm-viewer-action fm-viewer-open-with"
                aria-label={t('viewer.openWith')}
                onClick={() => setChoosing(true)}
              >
                <OpenWithIcon />
                <span className="fm-viewer-action-label">{t('viewer.openWith')}</span>
              </button>
            </Tooltip>
          </>,
          actionTargets.beforeHome,
        )}
      {actionTargets.afterHome &&
        createPortal(
          <Tooltip placement="cursor" content={t('web.download')}>
            <button
              type="button"
              className="fm-tool"
              aria-label={t('web.download')}
              onClick={() =>
                download(
                  source.entry || source.archives?.length
                    ? `${viewerPath(serverId, source.entry ? source : { ...source, entry: source.archives?.at(-1), archives: source.archives?.slice(0, -1) })}&download=true`
                    : `${serverPath(serverId)}/files/content?path=${encodeURIComponent(source.path)}`,
                )
              }
            >
              <svg
                viewBox="0 0 24 24"
                width="20"
                height="20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                aria-hidden="true"
              >
                <path d="M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5" />
              </svg>
            </button>
          </Tooltip>,
          actionTargets.afterHome,
        )}
      <div className="ve-body" key={key}>
        <ViewerBoundary>
          <Suspense fallback={<ViewerLoading />}>
            {GameViewer ? (
              <GameViewer {...props} />
            ) : viewer === 'image' ? (
              <Image {...props} />
            ) : viewer === 'audio' || viewer === 'video' ? (
              <Media {...props} kind={viewer} />
            ) : viewer === 'json' ? (
              <Json {...props} />
            ) : viewer === 'sqlite' ? (
              <Sqlite {...props} />
            ) : viewer === 'archive' ? (
              <Archive {...props} />
            ) : viewer === 'text' ? (
              <Text {...props} />
            ) : (
              <ErrorNotice error={{ messageKey: 'viewer.unavailable' }} />
            )}
          </Suspense>
        </ViewerBoundary>
      </div>
      {choosing && (
        <OpenWith
          source={source}
          serverId={serverId}
          selected={viewer}
          onChoose={choose}
          onClose={() => {
            setChoosing(false);
            requestAnimationFrame(() => chooserTrigger.current?.focus({ preventScroll: true }));
          }}
        />
      )}
    </section>
  );
}
