import { useEffect, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { Dialog, ErrorNotice, Loading } from '../../components/ui.js';
import { Pagination } from '../../components/workspace-controls.js';
import { playersBase, usePlayerResource } from './player-workspace.js';
import { key, type ServerView, useMetricsFormat } from './telemetry.js';

type Capture = { name: string; mtimeMs: number; bytes: number };

export function PlayerGallery({ server, watchUntil }: { server: ServerView; watchUntil: number }) {
  const t = useT(),
    f = useMetricsFormat();
  const running = server.runtimeState === 'running';
  const list = usePlayerResource<{ files: Capture[] }>(server, 'screenshots', {
    enabled: running,
    interval: (query) => (running && !query.state.error && Date.now() < watchUntil ? 3500 : false),
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const files = list.data?.files ?? [];
  const pageSize = 8,
    pages = Math.max(1, Math.ceil(files.length / pageSize));
  useEffect(() => {
    if (page > pages) setPage(pages);
  }, [page, pages]);
  const current = !list.error && list.data?.files.find((s) => s.name === selected);
  const fileTime = (stamp: number) =>
    stamp > 0 && Number.isFinite(new Date(stamp).getTime()) ? f.date(new Date(stamp)) : '—';
  return (
    <section className="ow-panel">
      <header className="ow-heading">
        <h2>{t(key('gallery'))}</h2>
        {running && (
          <button
            className="secondary"
            type="button"
            disabled={list.isFetching}
            onClick={() => void list.refetch()}
          >
            {t(key('refresh'))}
          </button>
        )}
      </header>
      {!running ? (
        <p className="ow-empty">
          {t(key(server.runtimeState === 'offline' ? 'offline' : 'not_ready'))}
        </p>
      ) : list.error ? (
        <ErrorNotice error={list.error} retry={() => void list.refetch()} />
      ) : !list.data ? (
        <Loading />
      ) : !list.data.files.length ? (
        <p className="ow-empty">{t(key('noScreenshots'))}</p>
      ) : (
        <>
          <ul className="ow-captures">
            {files.slice((page - 1) * pageSize, page * pageSize).map((shot) => (
              <li key={shot.name}>
                <button
                  className="ow-capture-tile"
                  type="button"
                  onClick={() => setSelected(shot.name)}
                >
                  <CaptureThumbnail server={server} file={shot} />
                  <strong>{shot.name}</strong>
                  <span>
                    {fileTime(shot.mtimeMs)} · {f.bytes(shot.bytes)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {pages > 1 && (
            <Pagination
              label={t(key('gallery'))}
              previousLabel={t('web.previous')}
              nextLabel={t('web.next')}
              summary={t(key('pageNumber'), { page, total: pages })}
              canPrevious={page > 1}
              canNext={page < pages}
              onPrevious={() => setPage((p) => p - 1)}
              onNext={() => setPage((p) => p + 1)}
            />
          )}
        </>
      )}
      {running && current && (
        <CaptureDialog
          key={current.name}
          server={server}
          file={current}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}

function captureUrl(server: ServerView, name: string) {
  return `${playersBase(server.serverId)}/screenshots/image?name=${encodeURIComponent(name)}`;
}

function CaptureThumbnail({ server, file }: { server: ServerView; file: Capture }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="ow-thumbnail" aria-hidden="true">
      {file.bytes > 0 && file.bytes <= 524288 && !failed ? (
        <img
          alt=""
          src={captureUrl(server, file.name)}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : (
        <svg
          aria-hidden="true"
          width="30"
          height="30"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth="1.4"
          fill="none"
        >
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <circle cx="8" cy="9" r="1.5" />
          <path d="m4 17 5-5 3 3 4-5 4 5" />
        </svg>
      )}
    </span>
  );
}

function CaptureDialog({
  server,
  file,
  onClose,
}: {
  server: ServerView;
  file: Capture;
  onClose: () => void;
}) {
  const t = useT();
  const [failed, setFailed] = useState(false);
  const url = captureUrl(server, file.name);
  return (
    <Dialog title={file.name} open closeIcon className="ow-detail ow-capture" onClose={onClose}>
      {failed ? (
        <>
          <p role="alert">{t(key('imageFailed'))}</p>
          <button className="secondary" type="button" onClick={() => setFailed(false)}>
            {t('web.retry')}
          </button>
        </>
      ) : (
        <img
          src={url}
          alt={t(key('captureImage'), { name: file.name })}
          onError={() => setFailed(true)}
        />
      )}
    </Dialog>
  );
}
