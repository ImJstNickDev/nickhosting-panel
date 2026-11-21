import { useEffect, useState } from 'react';
import type {
  OpenworldSavedPlayerDetail,
  OpenworldSavedPlayersPage,
} from '../../../../../games/openworld/src/offline-players.js';
import { ApiError } from '../../api/client.js';
import { useT } from '../../app/i18n.js';
import { Dialog, ErrorNotice, Loading } from '../../components/ui.js';
import { Pagination, SearchField } from '../../components/workspace-controls.js';
import { usePlayerResource } from './player-workspace.js';
import { key, Metrics, numeric, type ServerView, useMetricsFormat } from './telemetry.js';

export function savedUuid(value: string) {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
}
function useStamp() {
  const f = useMetricsFormat();
  return (value: string | number | null | undefined) => {
    if (value == null) return '—';
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? f.date(date) : '—';
  };
}

export function SavedPlayers({
  server,
  onOpen,
}: {
  server: ServerView;
  onOpen: (uuid: string) => void;
}) {
  const t = useT(),
    stamp = useStamp();
  const [input, setInput] = useState('');
  const [q, setQuery] = useState('');
  const [page, setPage] = useState(1);
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(input.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [input]);
  const list = usePlayerResource<OpenworldSavedPlayersPage>(
    server,
    `players/saved?${new URLSearchParams({ q, page: String(page) })}`,
    {
      interval: (query) => (query.state.data?.indexing && !query.state.error ? 3500 : false),
    },
  );
  const data = list.data;
  const lastPage = Math.max(1, Math.ceil((data?.total ?? 0) / 40));
  useEffect(() => {
    if (data && page > lastPage) setPage(lastPage);
  }, [data, page, lastPage]);
  return (
    <section className="ow-panel">
      <header className="ow-heading">
        <h2>{t(key('directory'))}</h2>
        <button
          type="button"
          className="secondary"
          disabled={list.isFetching}
          onClick={() => void list.refetch()}
        >
          {t(key('refresh'))}
        </button>
      </header>
      <div className="ow-roster-tools">
        <SearchField
          label={t(key('searchSaved'))}
          value={input}
          maxLength={128}
          onChange={(e) => setInput(e.target.value)}
        />
        {data && !list.error && (
          <span className="ow-count">{t(key('savedCount'), { count: data.total })}</span>
        )}
      </div>
      {list.error ? (
        <ErrorNotice error={list.error} retry={() => void list.refetch()} />
      ) : !data ? (
        <Loading />
      ) : (
        <>
          {data.indexing && (
            <p role="status" className="muted">
              {t(key('indexing'))}
            </p>
          )}
          {data.stale && (
            <p role="status" className="ow-observation-reason">
              {t(key('directoryStale'), { time: stamp(data.indexedAt) })}
            </p>
          )}
          {data.players.length ? (
            <ul className="ow-saved-list">
              {data.players.map((row) => (
                <li key={row.uuid}>
                  <button className="ow-file-name" type="button" onClick={() => onOpen(row.uuid)}>
                    <strong>{row.name ?? row.uuid}</strong>
                    {row.name && <small>{row.uuid}</small>}
                  </button>
                  <div className="ow-last-save">
                    <small>{t(key('lastSave'))}</small>
                    {row.savedAt ? <time dateTime={row.savedAt}>{stamp(row.savedAt)}</time> : '—'}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="ow-empty">{t(key(q ? 'noMatch' : 'noSaves'))}</p>
          )}
          {lastPage > 1 && (
            <Pagination
              label={t(key('directory'))}
              previousLabel={t('web.previous')}
              nextLabel={t('web.next')}
              summary={t(key('pageNumber'), { page, total: lastPage })}
              canPrevious={page > 1}
              canNext={page < lastPage}
              onPrevious={() => setPage((p) => Math.max(1, p - 1))}
              onNext={() => setPage((p) => p + 1)}
            />
          )}
        </>
      )}
    </section>
  );
}

export function SavedPlayerDialog({
  server,
  uuid,
  onClose,
}: {
  server: ServerView;
  uuid: string;
  onClose: () => void;
}) {
  const t = useT(),
    f = useMetricsFormat(),
    stamp = useStamp();
  const detail = usePlayerResource<OpenworldSavedPlayerDetail>(
    server,
    `players/saved/${encodeURIComponent(uuid)}`,
  );
  const player = detail.error ? undefined : detail.data;
  const stats = player?.stats;
  const position = player?.position;
  const inv = player?.inventory;
  const reported: [string, string][] = stats
    ? [
        [t(key('firstSeen')), stamp(stats.firstSeenMs)],
        [t(key('lastSeen')), stamp(stats.lastSeenMs)],
        [t(key('logins')), f.metric(stats.joins)],
        [t(key('playtime')), f.duration(stats.playSeconds)],
        [t(key('placed')), f.metric(stats.blocksPlaced)],
        [t(key('broken')), f.metric(stats.blocksBroken)],
        [t(key('deaths')), f.metric(stats.deaths)],
        [t(key('playerKills')), f.metric(stats.playerKills)],
        [t(key('kills')), f.metric(stats.creatureKills)],
        [t(key('distance')), f.metric(stats.walkedMeters, 'm')],
      ]
    : [];
  const statRows = reported.filter(([, value]) => value !== '—');
  return (
    <Dialog
      title={player?.name || t(key('savedPlayer'))}
      open
      closeIcon
      className="ow-detail"
      onClose={onClose}
    >
      {detail.error instanceof ApiError && detail.error.status === 404 ? (
        <p className="ow-empty">{t(key('saveNotFound'))}</p>
      ) : detail.error ? (
        <ErrorNotice error={detail.error} retry={() => void detail.refetch()} />
      ) : !player ? (
        <Loading />
      ) : (
        <>
          <div className="ow-detail-header">
            <span className="ow-uuid">{player.uuid}</span>
            <span>
              {t(key('lastSave'))} · {stamp(player.savedAt)}
            </span>
          </div>
          <div className="ow-detail-content">
            <Metrics
              items={[
                [t(key('world')), player.world || '—'],
                [
                  t(key('mode')),
                  player.mode &&
                  ['creative', 'survival', 'spectre', 'spectator'].includes(player.mode)
                    ? t(key(player.mode === 'spectator' ? 'spectre' : player.mode))
                    : player.mode || '—',
                ],
                [
                  t(key('localPosition')),
                  position
                    ? [position.x, position.y, position.z].map((v) => f.metric(v, '', 2)).join(', ')
                    : '—',
                ],
              ]}
            />
            {statRows.length > 0 && (
              <section>
                <h3>{t(key('activity'))}</h3>
                {player.statsAt && (
                  <p className="muted">{t(key('statsAt'), { time: stamp(player.statsAt) })}</p>
                )}
                <Metrics items={statRows} />
              </section>
            )}
            <section>
              <h3>{t(key('savedInventory'))}</h3>
              {!inv ? (
                <p className="ow-empty">{t(key('noSavedInventory'))}</p>
              ) : (
                (['hotbar', 'bag'] as const).map((group) => (
                  <details key={group} className="ow-disclosure">
                    <summary>{t(key(group))}</summary>
                    <ol className="ow-slots">
                      {inv[group].map((item, i) => (
                        <li
                          // biome-ignore lint/suspicious/noArrayIndexKey: Native inventory positions identify immutable slot numbers.
                          key={i + 1}
                          className={
                            group === 'hotbar' && inv.selected === i ? 'ow-selected' : undefined
                          }
                        >
                          <small>{i + 1}</small>
                          {item ? (
                            <>
                              <span>{t(key('itemCode'), { code: item.code })}</span>
                              {numeric(item.count) && <b>×{f.metric(item.count)}</b>}
                            </>
                          ) : (
                            <>
                              <span aria-hidden="true">—</span>
                              <span className="visually-hidden">{t(key('emptySlot'))}</span>
                            </>
                          )}
                        </li>
                      ))}
                    </ol>
                  </details>
                ))
              )}
            </section>
          </div>
        </>
      )}
    </Dialog>
  );
}
