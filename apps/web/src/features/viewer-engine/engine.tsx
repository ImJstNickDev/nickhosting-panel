import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { download } from '../../api/client.js';
import { useT } from '../../app/i18n.js';
import { ErrorNotice } from '../../components/ui.js';
import { serverPath } from '../service-contracts.js';
import { viewerPath } from './core/access.js';
import { ViewerBoundary } from './core/boundary.js';
import { preferredViewer, type ViewerId } from './core/registry.js';
import type { ViewerProps } from './core/types.js';
import { ViewerLoading } from './loading.js';
import { OpenWith } from './open-with.js';
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
}: Omit<ViewerProps, 'onOpen'> & {
  viewerId?: ViewerId;
  onText: () => void;
  onExtract?: () => void;
}) {
  const t = useT();
  const [source, setSource] = useState(initial);
  const [archiveDirectory, setArchiveDirectory] = useState('');
  const [viewer, setViewer] = useState<ViewerId | undefined>(viewerId);
  const [choosing, setChoosing] = useState(false);
  const preferences = useViewerPreferences(serverId, identity);
  const region = useRef<HTMLElement>(null);
  useEffect(() => {
    region.current?.focus({ preventScroll: true });
  }, []);
  function choose(id: ViewerId) {
    setChoosing(false);
    if (id === 'text' && !source.entry) {
      onText();
      return;
    }
    setViewer(id);
  }
  const props: ViewerProps = {
    source,
    serverId,
    identity,
    archiveDirectory,
    onOpen: (next) => {
      next = { ...next, gameId: initial.gameId };
      if (next.entry) setArchiveDirectory(next.entry.split('/').slice(0, -1).join('/'));
      setSource(next);
      setViewer(preferredViewer(next, preferences.data?.preferences));
    },
  };
  const key = `${source.path}:${source.entry ?? ''}:${viewer}`;
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
      <div className="ve-toolbar">
        {(viewer === 'json' || (viewer === 'text' && source.entry)) && (
          <span className="ve-kind">{t('viewer.readOnly')}</span>
        )}
        {source.entry && (
          <>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setSource(initial);
                setViewer('archive');
              }}
            >
              {t('viewer.backToArchive')}
            </button>
            <span className="ve-current-entry">{source.entry}</span>
          </>
        )}
        <div className="ve-toolbar-actions">
          <button type="button" className="secondary" onClick={() => setChoosing(true)}>
            {t('viewer.openWith')}
          </button>
          {onExtract && viewer === 'archive' && !source.entry && (
            <button type="button" className="secondary" onClick={onExtract}>
              {t('file.extract')}
            </button>
          )}
          <button
            type="button"
            className="fm-tool"
            aria-label={t('web.download')}
            onClick={() =>
              download(
                source.entry
                  ? `${viewerPath(serverId, source)}&download=true`
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
        </div>
      </div>
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
          onClose={() => setChoosing(false)}
        />
      )}
    </section>
  );
}
