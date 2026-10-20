import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../app/i18n.js';
import { Tooltip } from '../../components/tooltip.js';
import { ErrorNotice } from '../../components/ui.js';
import { FilemanScope, FilemanSlot } from '../fileman/host.js';
import { FilemanToolbarIcon } from '../fileman/presentation.js';
import { AtlasPathContribution } from './builtin-viewers/atlas-path-provider.js';
import { viewerDownloadPath } from './core/access.js';
import { ViewerBoundary } from './core/boundary.js';
import { compressedArchiveOptions, decodedMember, isSingleCompressed } from './core/compressed.js';
import { canUseDocumentView } from './core/document-registry.js';
import {
  preferredViewer,
  savedViewer,
  type ViewerId,
  type ViewerSource,
  viewerExtension,
} from './core/registry.js';
import type { ArchiveExtraction, ViewerProps } from './core/types.js';
import { ViewerDownload } from './download-action.js';
import { GameViewerMount } from './game-viewer-host.js';
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
const Pdf = lazy(() => import('./builtin-viewers/pdf.js'));
const Text = lazy(() => import('./builtin-viewers/text.js'));

export function FileViewer({
  source: initial,
  viewerId,
  serverId,
  identity,
  onText,
  onClose,
  onExtract,
  onViewerChange,
  onContextChange,
  actionTargets,
  autoDecodeCompressed = true,
}: Omit<ViewerProps, 'onOpen'> & {
  viewerId?: ViewerId;
  /** False when the caller explicitly selected Atlas for the original container. */
  autoDecodeCompressed?: boolean;
  onText: () => void;
  onClose: () => void;
  onExtract?: (selection?: ArchiveExtraction) => void;
  onViewerChange?: (viewerId: ViewerId, options?: { autoDecodeCompressed: boolean }) => void;
  onContextChange?: (context: { viewerId?: ViewerId; path: string; readOnly: true }) => void;
  actionTargets: {
    beforeHome: HTMLElement | null;
    afterHome: HTMLElement | null;
    breadcrumb?: HTMLElement | null;
    tools?: HTMLElement | null;
    search?: HTMLElement | null;
    view?: HTMLElement | null;
  };
}) {
  const t = useT();
  const [source, setSource] = useState(initial);
  const containers = useRef([initial]);
  const decodedContainers = useRef(
    new Map<string, { original: ViewerSource; internal: ViewerSource }>(),
  );
  const [archiveDirectory, setArchiveDirectory] = useState('');
  const [listingView, setListingView] = useState<'list' | 'grid'>('list');
  const [decodeEnabled, setDecodeEnabled] = useState(
    autoDecodeCompressed && isSingleCompressed(initial),
  );
  const [selectedViewer, setViewer] = useState<ViewerId | undefined>(
    autoDecodeCompressed && isSingleCompressed(initial) && viewerId === 'archive'
      ? undefined
      : viewerId,
  );
  const [choosing, setChoosing] = useState(false);
  const chooserTrigger = useRef<HTMLButtonElement>(null);
  const preferences = useViewerPreferences(serverId, identity);
  const compressed = useQuery({
    ...compressedArchiveOptions(serverId, identity, source),
    enabled: decodeEnabled,
    select: (page) => decodedMember(source, page),
    refetchOnWindowFocus: false,
  });
  const decodedSource = decodeEnabled ? compressed.data : undefined;
  const viewer = decodeEnabled
    ? decodedSource
      ? (selectedViewer ?? preferredViewer(decodedSource, preferences.data?.preferences))
      : undefined
    : selectedViewer;
  const alias = !source.entry
    ? decodedContainers.current.get(JSON.stringify(source.archives ?? []))
    : undefined;
  const visibleSource = alias?.original ?? source;
  const renderSource =
    decodedSource && viewer === 'archive'
      ? {
          ...decodedSource,
          archives: [...(decodedSource.archives ?? []), decodedSource.entry as string],
          entry: undefined,
        }
      : (decodedSource ?? source);
  useEffect(() => {
    if (!decodedSource || viewer !== 'archive') return;
    const internal = {
      ...decodedSource,
      archives: [...(decodedSource.archives ?? []), decodedSource.entry as string],
      entry: undefined,
    };
    decodedContainers.current.set(JSON.stringify(internal.archives), {
      original: source,
      internal,
    });
    containers.current[internal.archives.length] = internal;
  }, [decodedSource, source, viewer]);
  const contextChange = useRef(onContextChange);
  contextChange.current = onContextChange;
  useEffect(() => {
    contextChange.current?.({ viewerId: viewer, path: source.path, readOnly: true });
  }, [viewer, source.path]);
  const region = useRef<HTMLElement>(null);
  useEffect(() => {
    region.current?.focus({ preventScroll: true });
  }, []);
  function archiveAt(depth: number, directory = '') {
    const archives = (source.archives ?? []).slice(0, depth);
    const decoded = [...decodedContainers.current.values()].find(
      (item) => JSON.stringify(item.original.archives ?? []) === JSON.stringify(archives),
    );
    const next = decoded?.internal ?? {
      ...(containers.current[depth] ?? initial),
      archives,
      entry: undefined,
    };
    setSource(next);
    containers.current = containers.current.slice(0, (next.archives?.length ?? 0) + 1);
    setArchiveDirectory(directory);
    setDecodeEnabled(false);
    setViewer('archive');
  }
  function choose(id: ViewerId) {
    setChoosing(false);
    const decode = isSingleCompressed(visibleSource) && id !== 'archive';
    if (alias) setSource(visibleSource);
    if (id === 'archive' && isSingleCompressed(visibleSource)) {
      setArchiveDirectory('');
      for (const [key, item] of decodedContainers.current)
        if (
          JSON.stringify(item.original.archives ?? []) ===
          JSON.stringify(visibleSource.archives ?? [])
        )
          decodedContainers.current.delete(key);
    }
    if (id === 'text' && !decode && !source.entry && !source.archives?.length) {
      onText();
      return;
    }
    setDecodeEnabled(decode);
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
    if (id !== 'archive' && !decode && !source.entry && source.archives?.length) {
      setSource({
        ...source,
        archives: source.archives.slice(0, -1),
        entry: source.archives.at(-1),
      });
      setArchiveDirectory(source.archives.at(-1)?.split('/').slice(0, -1).join('/') ?? '');
    }
    setViewer(id);
    if (!visibleSource.entry && !visibleSource.archives?.length)
      onViewerChange?.(id, { autoDecodeCompressed: decode });
  }
  const props: ViewerProps = {
    source: renderSource,
    serverId,
    identity,
    archiveDirectory,
    onArchiveDirectory: setArchiveDirectory,
    onExtract,
    chrome: {
      search: actionTargets.search ?? null,
      view: actionTargets.view ?? null,
      tools: actionTargets.tools ?? actionTargets.beforeHome,
    },
    listingView,
    onListingView: setListingView,
    onOpenWith: (next) => {
      props.onOpen(next);
      setChoosing(true);
    },
    onArchiveBack: source.archives?.some(
      (_, index) =>
        !decodedContainers.current.has(JSON.stringify(source.archives?.slice(0, index + 1))),
    )
      ? () => {
          const depth = (source.archives ?? []).findLastIndex(
            (_, index) =>
              !decodedContainers.current.has(JSON.stringify(source.archives?.slice(0, index + 1))),
          );
          const member = source.archives?.[depth] ?? '';
          archiveAt(depth, member.split('/').slice(0, -1).join('/'));
        }
      : onClose,
    onOpen: (next) => {
      next = { ...next, gameId: initial.gameId };
      if (next.entry) setArchiveDirectory(next.entry.split('/').slice(0, -1).join('/'));
      const decode =
        isSingleCompressed(next) && savedViewer(next, preferences.data?.preferences) !== 'archive';
      const preferred = decode
        ? savedViewer(next, preferences.data?.preferences)
        : preferredViewer(next, preferences.data?.preferences);
      if ((decode || preferred === 'archive') && next.entry) {
        next = { ...next, archives: [...(next.archives ?? []), next.entry], entry: undefined };
        containers.current = [...containers.current.slice(0, next.archives?.length), next];
        setArchiveDirectory('');
      }
      setSource(next);
      setDecodeEnabled(decode);
      setViewer(preferred);
    },
  };
  const key = JSON.stringify([
    source.path,
    source.archives,
    source.entry,
    decodedSource?.entry,
    canUseDocumentView(renderSource, viewer) ? 'document' : viewer,
    viewer === 'archive' ? archiveDirectory : undefined,
  ]);
  const archiveDepth = source.archives?.length ?? 0;
  const visibleDepth =
    (source.archives ?? []).findLastIndex(
      (_, index) =>
        !decodedContainers.current.has(JSON.stringify(source.archives?.slice(0, index + 1))),
    ) + 1;
  const insideArchive = viewer === 'archive' || Boolean(source.entry) || archiveDepth > 0;
  const directoryParts = (
    source.entry ? source.entry.split('/').slice(0, -1).join('/') : archiveDirectory
  )
    .split('/')
    .filter(Boolean);
  const GameViewer = viewer ? gameViewerRenderer(viewer) : undefined;
  const gameLabel = viewer ? gameViewerRegistry.get(viewer)?.descriptor.labelKey : undefined;
  return (
    <FilemanScope
      context={{ viewerId: viewer, path: source.path, surface: 'viewer', readOnly: true }}
    >
      {insideArchive && (
        <AtlasPathContribution
          serverId={serverId}
          identity={identity}
          root={initial}
          source={source}
          directory={archiveDirectory}
          aliases={[
            ...decodedContainers.current.values(),
            ...(decodedSource && viewer === 'archive'
              ? [{ original: source, internal: renderSource }]
              : []),
          ]}
          onOpen={props.onOpen}
          shouldDecode={(next) => savedViewer(next, preferences.data?.preferences) !== 'archive'}
          onAliases={(aliases) => {
            for (const alias of aliases)
              decodedContainers.current.set(JSON.stringify(alias.internal.archives ?? []), alias);
          }}
          onNavigate={({ source: next, directory }) => {
            setSource(next);
            const depth = next.archives?.length ?? 0;
            containers.current = containers.current.slice(0, depth + 1);
            containers.current[depth] = next;
            setArchiveDirectory(directory);
            setDecodeEnabled(false);
            setViewer('archive');
          }}
        />
      )}
      <section
        className="ve-engine"
        ref={region}
        tabIndex={-1}
        aria-label={t(
          gameLabel ??
            (viewer === 'text' ? 'file.editor' : viewer ? `viewer.${viewer}` : 'viewer.open'),
        )}
      >
        {(viewer === 'json' || (viewer === 'text' && renderSource.entry)) && (
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
                      !visibleDepth && !source.entry && !archiveDirectory ? 'page' : undefined
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
                decodedContainers.current.has(JSON.stringify(source.archives?.slice(0, depth + 1)))
                  ? []
                  : member.split('/').map((part, index, all) => (
                      <li
                        key={JSON.stringify([
                          source.archives?.slice(0, depth),
                          all.slice(0, index + 1),
                        ])}
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
                            depth === visibleDepth - 1 &&
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
            <FilemanSlot name="viewer.actions">
              {onExtract && viewer === 'archive' && !source.entry && (
                <Tooltip placement="cursor" content={t('file.extract')}>
                  <button
                    type="button"
                    className="fm-tool"
                    aria-label={t('file.extract')}
                    onClick={() => onExtract({ archives: renderSource.archives })}
                  >
                    <FilemanToolbarIcon kind="extract" />
                  </button>
                </Tooltip>
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
            </FilemanSlot>,
            actionTargets.beforeHome,
          )}
        {actionTargets.afterHome &&
          createPortal(
            <FilemanSlot name="viewer.download">
              <ViewerDownload
                original={viewerDownloadPath(serverId, visibleSource)}
                decoded={
                  decodedSource
                    ? viewerDownloadPath(serverId, decodedSource)
                    : alias
                      ? viewerDownloadPath(serverId, alias.internal)
                      : undefined
                }
              />
            </FilemanSlot>,
            actionTargets.afterHome,
          )}
        <div className="ve-body" key={key}>
          <FilemanSlot name="viewer.content">
            <ViewerBoundary>
              <Suspense fallback={<ViewerLoading />}>
                {decodeEnabled && compressed.error ? (
                  <ErrorNotice error={compressed.error} retry={() => void compressed.refetch()} />
                ) : decodeEnabled && !decodedSource ? (
                  <ViewerLoading />
                ) : GameViewer ? (
                  <GameViewerMount
                    viewer={GameViewer}
                    source={renderSource}
                    serverId={serverId}
                    identity={identity}
                    onViewerChange={choose}
                  />
                ) : viewer === 'image' ? (
                  <Image {...props} />
                ) : viewer === 'audio' || viewer === 'video' ? (
                  <Media {...props} kind={viewer} />
                ) : viewer === 'pdf' ? (
                  <Pdf {...props} />
                ) : canUseDocumentView(renderSource, viewer) ? (
                  <Text {...props} initialView={viewer} onViewChange={setViewer} />
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
          </FilemanSlot>
        </div>
        {choosing && (!decodeEnabled || decodedSource || compressed.error) && (
          <OpenWith
            source={renderSource}
            displayName={visibleSource.name}
            archivePreferenceExtension={
              isSingleCompressed(visibleSource)
                ? viewerExtension(visibleSource.name, visibleSource.gameId)
                : undefined
            }
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
    </FilemanScope>
  );
}
