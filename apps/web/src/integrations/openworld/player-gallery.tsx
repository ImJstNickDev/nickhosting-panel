import { useEffect, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { Dialog, ErrorNotice, Loading } from '../../components/ui.js';
import { Pagination } from '../../components/workspace-controls.js';
import { people } from './player-identity.js';
import { playersBase, usePlayerResource } from './player-workspace.js';
import { key, type ServerView, useMetricsFormat } from './telemetry.js';

type Capture = { name: string; mtimeMs: number; bytes: number; accountId?: string | null };

export function PlayerGallery({
  server,
  watchUntil,
  account,
  accountNames,
  inspect = false,
}: {
  server: ServerView;
  watchUntil: number;
  account?: string;
  accountNames?: ReadonlyMap<string, string>;
  inspect?: boolean;
}) {
  const t = useT(),
    f = useMetricsFormat();
  const running = server.runtimeState === 'running';
  const list = usePlayerResource<{ files: Capture[] }>(
    server,
    account ? `screenshots?${new URLSearchParams({ account })}` : 'screenshots',
    {
      enabled: running,
      interval: (query) =>
        running && !query.state.error && Date.now() < watchUntil ? 3500 : false,
    },
  );
  const [selected, setSelected] = useState<Capture | null>(null);
  const [page, setPage] = useState(1);
  const [unassigned, setUnassigned] = useState(false);
  const files = (list.data?.files ?? []).filter(
    (f) => !(unassigned && inspect) || f.accountId === null,
  );
  const pageSize = 8,
    pages = Math.max(1, Math.ceil(files.length / pageSize));
  useEffect(() => {
    if (page > pages) setPage(pages);
  }, [page, pages]);
  const current =
    !list.error &&
    list.data?.files.find(
      (s) =>
        selected &&
        s.name === selected.name &&
        s.bytes === selected.bytes &&
        s.mtimeMs === selected.mtimeMs,
    );
  const fileTime = (stamp: number) =>
    stamp > 0 && Number.isFinite(new Date(stamp).getTime()) ? f.date(new Date(stamp)) : '—';
  return (
    <section className={account ? 'ow-profile-gallery' : 'ow-panel'}>
      <header className="ow-heading">
        <h2>{t(people(account ? 'personalGallery' : 'serverGallery'))}</h2>
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
      {running && !account && inspect && (
        <label className="ow-capture-filter">
          <input
            type="checkbox"
            checked={unassigned}
            onChange={(e) => {
              setUnassigned(e.target.checked);
              setPage(1);
            }}
          />
          {t(people('unassigned'))}
        </label>
      )}
      {!running ? (
        <p className="ow-empty">
          {t(key(server.runtimeState === 'offline' ? 'offline' : 'not_ready'))}
        </p>
      ) : list.error ? (
        <ErrorNotice error={list.error} retry={() => void list.refetch()} />
      ) : !list.data ? (
        <Loading />
      ) : !files.length ? (
        <p className="ow-empty">
          {t(account ? people('playerGalleryEmpty') : key('noScreenshots'))}
        </p>
      ) : (
        <>
          <ul className="ow-captures">
            {files.slice((page - 1) * pageSize, page * pageSize).map((shot) => (
              <li key={JSON.stringify([shot.name, shot.mtimeMs, shot.bytes])}>
                <button className="ow-capture-tile" type="button" onClick={() => setSelected(shot)}>
                  <CaptureThumbnail server={server} file={shot} />
                  <strong>
                    {(inspect && shot.accountId && accountNames?.get(shot.accountId)) ||
                      fileTime(shot.mtimeMs)}
                  </strong>
                  <span>
                    {inspect && !account && shot.accountId === null && (
                      <>{t(people('unassigned'))} · </>
                    )}
                    {inspect && shot.accountId && accountNames?.has(shot.accountId) && (
                      <>{fileTime(shot.mtimeMs)} · </>
                    )}
                    {f.bytes(shot.bytes)}
                    <span className="visually-hidden"> · {shot.name}</span>
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
          account={inspect ? current.accountId : null}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}

function captureUrl(server: ServerView, file: Capture, variant: 'thumbnail' | 'image') {
  const params = new URLSearchParams({
    name: file.name,
    mtimeMs: String(file.mtimeMs),
    bytes: String(file.bytes),
  });
  return `${playersBase(server.serverId)}/screenshots/${variant}?${params}`;
}
function CaptureThumbnail({ server, file }: { server: ServerView; file: Capture }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="ow-thumbnail" aria-hidden="true">
      {file.bytes > 0 && !failed ? (
        <img
          alt=""
          src={captureUrl(server, file, 'thumbnail')}
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
  account,
  onClose,
}: {
  server: ServerView;
  file: Capture;
  account?: string | null;
  onClose: () => void;
}) {
  const t = useT();
  const [failed, setFailed] = useState(false);
  const url = captureUrl(server, file, 'image');
  return (
    <Dialog title={file.name} open closeIcon className="ow-detail ow-capture" onClose={onClose}>
      {account && (
        <p className="ow-uuid">
          {t(key('account'))} · {account}
        </p>
      )}
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
